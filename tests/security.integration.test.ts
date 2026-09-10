import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteD1 } from '../server/database';
import { hashPassword, sha256 } from '../worker/security';
import { getProvider } from '../worker/provider';
import { providerFingerprint } from '../worker/user-provider';
import type { Env } from '../worker/env';

const research = vi.hoisted(() => ({ previewImport: vi.fn(), researchLead: vi.fn(), buildProfile: vi.fn(), testProvider: vi.fn() }));
vi.mock('../worker/research', () => research);
import { app } from '../worker/app';
import { runJob } from '../worker/jobs';

let dir: string, db: SqliteD1, env: Env;
const date = '2026-01-01T00:00:00.000Z';

async function request(path: string, method = 'GET', body?: unknown, token = 'member-token', headers: Record<string, string> = {}) {
  return app.fetch(new Request(`https://work.example.org/api${path}`, { method, headers: { Cookie: `cb_session=${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
}
async function seedLead(id = 'l1') {
  await db.prepare('INSERT INTO leads(id,workspace_id,advertiser_id,name,company,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(id, 'w1', 'a1', 'Synthetic Contact', 'Synthetic Company', date, date).run();
}
async function seedJob() {
  const advertiser = await db.prepare('SELECT * FROM advertisers WHERE id=?').bind('a1').first();
  const lead = await db.prepare('SELECT * FROM leads WHERE id=?').bind('l1').first();
  await db.prepare("INSERT INTO jobs(id,workspace_id,lead_id,advertiser_id,user_id,kind,status,stage,model,profile_version,lead_version,created_at,updated_at) VALUES('j1','w1','l1','a1','member','research','queued','queued','synthetic-model',1,1,?,?)").bind(date, date).run();
  await db.prepare('INSERT INTO job_payloads VALUES(?,?,?)').bind('j1', 0, JSON.stringify({ advertiser, lead })).run();
}

beforeEach(async () => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'customer-background-security-'));
  db = new SqliteD1(join(dir, 'test.sqlite'), resolve('migrations'));
  env = { DB: db, DEFAULT_API_URL: 'https://model.example.org', DEFAULT_MODEL: 'synthetic-model', ALTERNATE_MODEL: 'synthetic-alternative', API_KEY: 'synthetic-provider-secret', ENCRYPTION_KEY: 'synthetic-test-encryption-key-32-characters', BOOTSTRAP_TOKEN: 'synthetic-setup-token', RESEARCH: { create: vi.fn(), get: vi.fn() }, ASSETS: { fetch: vi.fn() } } as unknown as Env;
  for (const [id, role, workspace] of [['admin', 'admin', 'w1'], ['member', 'member', 'w1'], ['viewer', 'viewer', 'w1'], ['other', 'member', 'w2']]) {
    await db.prepare('INSERT INTO users(id,username,display_name,password_hash,role,daily_limit,created_at) VALUES(?,?,?,?,?,?,?)').bind(id, id, id, 'pbkdf2:100000:dummy:invalid', role, 1, date).run();
    await db.prepare('INSERT OR IGNORE INTO workspaces VALUES(?,?,?)').bind(workspace, workspace, date).run();
    await db.prepare('INSERT INTO memberships VALUES(?,?)').bind(workspace, id).run();
    await db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await sha256(`${id}-token`), id, '2099-01-01T00:00:00.000Z', date).run();
  }
  await db.prepare('INSERT INTO advertisers VALUES(?,?,?,?,?,?,?)').bind('a1', 'w1', 'Synthetic Supplier', '# Synthetic supplier profile', 1, date, date).run();
  await db.prepare("INSERT INTO user_providers(user_id,mode,config_hash,tested_at,updated_at) VALUES(?,'inherit',?,?,?)").bind('member',await providerFingerprint(await getProvider(env),'inherit'),date,date).run();
  research.previewImport.mockResolvedValue({ leads: [{ name: 'Synthetic Contact', raw: {} }], warnings: [], usage: { input_tokens: 10, output_tokens: 10 } });
  research.researchLead.mockResolvedValue({ content_md: 'Synthetic report', result_json: { match_level: 3, priority: 4, industry: 'Synthetic industry', fit: '直接匹配' }, evidence: [], usage: { input_tokens: 10, output_tokens: 10 } });
  research.testProvider.mockResolvedValue({ ok: true, tool_calling: true, analysis_ok: true, model: 'synthetic-model', message: 'Synthetic test transport passed', usage: { input_tokens: 10, output_tokens: 10 } });
});
afterEach(() => { vi.useRealTimers(); db.db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('server-side access boundaries', () => {
  it('denies unauthenticated, viewer-write and other-workspace access', async () => {
    await seedLead();
    expect((await request('/admin/settings', 'GET', undefined, 'invalid')).status).toBe(401);
    expect((await request('/admin/settings')).status).toBe(403);
    expect((await request('/leads/l1', 'PATCH', { version: 1, notes: 'x' }, 'viewer-token')).status).toBe(403);
    expect((await request('/leads/l1', 'GET', undefined, 'other-token')).status).toBe(404);
    expect((await request('/leads/l1/export', 'GET', undefined, 'other-token')).status).toBe(404);
  });
  it('rejects cross-origin mutations and omits provider secrets from settings', async () => {
    expect((await request('/workspaces', 'POST', { name: 'Synthetic' }, 'admin-token', { Origin: 'https://hostile.example.org' })).status).toBe(403);
    const response = await request('/admin/settings', 'GET', undefined, 'admin-token');
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('synthetic-provider-secret');
  });
  it('rejects stale record writes', async () => {
    await seedLead();
    expect((await request('/leads/l1', 'PATCH', { version: 1, notes: 'first' })).status).toBe(200);
    expect((await request('/leads/l1', 'PATCH', { version: 1, notes: 'stale' })).status).toBe(409);
    expect((await db.prepare('SELECT notes FROM leads WHERE id=?').bind('l1').first<{ notes: string }>())?.notes).toBe('first');
  });
  it('keeps concurrent advertiser saves in the same millisecond as one success and one conflict', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-11T00:00:00.000Z'));
    const responses = await Promise.all([
      request('/advertisers/a1', 'PATCH', { version: 1, profile_md: 'First synthetic revision' }),
      request('/advertisers/a1', 'PATCH', { version: 1, profile_md: 'Second synthetic revision' })
    ]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM advertiser_versions WHERE advertiser_id='a1' AND version=2").first<{ n: number }>())?.n).toBe(1);
  });
  it('invalidates existing sessions after an administrator resets a password', async () => {
    expect((await request('/admin/users/member', 'PATCH', { password: 'synthetic-reset-password' }, 'admin-token')).status).toBe(200);
    expect((await request('/auth/me')).status).toBe(401);
    expect((await db.prepare("SELECT must_change_password FROM users WHERE id='member'").first<{ must_change_password: number }>())?.must_change_password).toBe(1);
  });
  it('does not let a boolean bypass the current administrator self-deactivation guard', async () => {
    expect((await request('/admin/users/admin', 'PATCH', { active: false }, 'admin-token')).status).toBe(400);
    expect((await db.prepare("SELECT active FROM users WHERE id='admin'").first<{ active: number }>())?.active).toBe(1);
  });
});

describe('cost, concurrency and persistence boundaries', () => {
  it('counts model-backed import previews against the configured daily limit', async () => {
    expect((await request('/leads/import/preview', 'POST', { text: 'synthetic input' })).status).toBe(200);
    expect((await request('/leads/import/preview', 'POST', { text: 'synthetic input' })).status).toBe(429);
    expect(research.previewImport).toHaveBeenCalledTimes(1);
  });
  it('does not publish old-profile scores into the current lead after advertiser changes', async () => {
    await seedLead(); await seedJob();
    research.researchLead.mockImplementationOnce(async () => {
      await db.prepare("UPDATE advertisers SET version=2,profile_md='Changed supplier scope' WHERE id='a1'").run();
      return { content_md: 'Synthetic historical result', result_json: { match_level: 3, priority: 4, industry: 'Synthetic industry', fit: '直接匹配' }, evidence: [], usage: { input_tokens: 10, output_tokens: 10 } };
    });
    await runJob(env, 'j1');
    const lead = await db.prepare('SELECT match_level,version FROM leads WHERE id=?').bind('l1').first<{ match_level: number | null; version: number }>();
    expect(lead?.match_level).toBeNull();
    expect(lead?.version).toBe(1);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM reports WHERE job_id=?').bind('j1').first<{ n: number }>())?.n).toBe(1);
  });
  it('does not partially import a batch when a later row is invalid', async () => {
    const response = await request('/leads/import', 'POST', { workspace_id: 'w1', advertiser_id: 'a1', leads: [{ name: 'Synthetic First' }, { name: 'Synthetic Invalid', raw: { oversized: 'x'.repeat(100001) } }] });
    expect(response.status).toBe(400);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM leads').first<{ n: number }>())?.n).toBe(0);
  });
  it('keeps every committed edit snapshot when another edit lands before the first handler resumes', async () => {
    await seedLead();
    const originalPrepare = db.prepare.bind(db), originalBatch = db.batch.bind(db);
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const updateReached = new Promise<void>(resolve => { reached = resolve; });
    let first = true;
    db.batch = async statements => {
      const result = await originalBatch(statements);
      if (first) { first = false; reached(); await gate; }
      return result;
    };
    const pending = request('/leads/l1', 'PATCH', { version: 1, notes: 'revision-two' });
    await updateReached;
    const later = await request('/leads/l1', 'PATCH', { version: 2, notes: 'revision-three' });
    release(); const earlier = await pending;
    expect(earlier.status).toBe(200); expect(later.status).toBe(200);
    expect((await earlier.json() as { lead: { version: number } }).lead.version).toBe(2);
    expect((await later.json() as { lead: { version: number } }).lead.version).toBe(3);
    const snapshots = (await originalPrepare('SELECT version,snapshot FROM lead_versions WHERE lead_id=? ORDER BY version').bind('l1').all<{ version: number; snapshot: string }>()).results;
    expect(snapshots.map(s => s.version)).toEqual([2, 3]);
    expect(JSON.parse(snapshots[0].snapshot).notes).toBe('revision-two');
  });
  it('atomically shares the quota between concurrent previews and background jobs', async () => {
    await seedLead();
    const responses = await Promise.all([
      request('/leads/import/preview', 'POST', { text: 'synthetic input' }),
      request('/leads/l1/research', 'POST', {})
    ]);
    expect(responses.filter(r => r.status === 429)).toHaveLength(1);
    expect(responses.filter(r => [200, 202].includes(r.status))).toHaveLength(1);
    const total = await db.prepare('SELECT (SELECT COUNT(*) FROM jobs)+(SELECT COUNT(*) FROM api_calls) AS n').first<{ n: number }>();
    expect(total?.n).toBe(1);
  });
  it('does not publish a cancelled task result', async () => {
    await seedLead(); await seedJob();
    research.researchLead.mockImplementationOnce(async () => {
      await db.prepare("UPDATE jobs SET status='cancelled' WHERE id='j1'").run();
      return { content_md: 'cancelled synthetic output', result_json: { match_level: 3, priority: 5 }, evidence: [], usage: { input_tokens: 10, output_tokens: 10 } };
    });
    await runJob(env, 'j1');
    expect((await db.prepare('SELECT status FROM jobs WHERE id=?').bind('j1').first<{ status: string }>())?.status).toBe('cancelled');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM reports').first<{ n: number }>())?.n).toBe(0);
  });
});

describe('login rate limit', () => {
  it('does not let a caller reset its bucket by spoofing Cloudflare client headers', async () => {
    await db.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(await hashPassword('synthetic-correct-password'), 'member').run();
    for (let i = 0; i < 8; i++) expect((await request('/auth/login', 'POST', { username: 'member', password: 'wrong-password' }, '', { 'CF-Connecting-IP': '198.51.100.1' })).status).toBe(401);
    expect((await request('/auth/login', 'POST', { username: 'member', password: 'wrong-password' }, '', { 'CF-Connecting-IP': '198.51.100.2' })).status).toBe(429);
  });
  it('uses the configured external origin behind a TLS reverse proxy and sets Secure cookies', async () => {
    (env as Env & { APP_ORIGIN: string }).APP_ORIGIN = 'https://work.example.org';
    await db.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(await hashPassword('synthetic-correct-password'), 'member').run();
    const response = await app.fetch(new Request('http://127.0.0.1:8787/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://work.example.org' }, body: JSON.stringify({ username: 'member', password: 'synthetic-correct-password' }) }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toContain('Secure');
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
  });
  it('creates accounts inactive and preserves a zero daily limit', async () => {
    const response = await request('/admin/users', 'POST', { username: 'synthetic-new-user', display_name: 'Synthetic New User', password: 'synthetic-new-password', role: 'member', daily_limit: 0, workspace_ids: ['w1'] }, 'admin-token');
    expect(response.status).toBe(201);
    const { user } = await response.json() as { user: { active: number; daily_limit: number } };
    expect(user.active).toBe(0); expect(user.daily_limit).toBe(0);
    expect(JSON.stringify(user)).not.toContain('password_hash');
  });
});

describe('assigned account provider boundaries', () => {
  const config = { mode: 'dedicated', api_url: 'https://model.example.org', api_key: 'synthetic-member-dedicated-key', model: 'synthetic-model', alternate_model: 'synthetic-alternative' };
  async function proof(user = 'member', proposed = config) {
    const response = await request(`/admin/users/${user}/provider/test`, 'POST', proposed, 'admin-token');
    expect(response.status).toBe(200);
    const result = await response.json() as { test_id: string };
    expect(result.test_id).toBeTruthy(); return result.test_id;
  }
  async function assign(user = 'member', proposed = config) {
    const test_id = await proof(user, proposed);
    expect((await request(`/admin/users/${user}/provider`, 'PUT', { ...proposed, test_id }, 'admin-token')).status).toBe(200);
  }
  it('requires successful assigned model validation before activating a new account', async () => {
    await db.prepare("UPDATE users SET active=0 WHERE id='other'").run();
    expect((await request('/admin/users/other', 'PATCH', { active: 1 }, 'admin-token')).status).toBe(409);
    await assign('other');
    expect((await request('/admin/users/other', 'PATCH', { active: 1 }, 'admin-token')).status).toBe(200);
  });
  it('binds a one-use test proof to its user and the exact key/model configuration', async () => {
    const test_id = await proof();
    expect((await request('/admin/users/other/provider', 'PUT', { ...config, test_id }, 'admin-token')).status).toBe(409);
    expect((await request('/admin/users/member/provider', 'PUT', { ...config, model: 'different-model', test_id }, 'admin-token')).status).toBe(409);
    expect((await request('/admin/users/member/provider', 'PUT', { ...config, api_key: 'different-synthetic-key', test_id }, 'admin-token')).status).toBe(409);
    expect((await request('/admin/users/member/provider', 'PUT', { ...config, test_id }, 'admin-token')).status).toBe(200);
    expect((await request('/admin/users/member/provider', 'PUT', { ...config, test_id }, 'admin-token')).status).toBe(409);
  });
  it('does not disclose assigned secrets through settings responses or unprivileged routes', async () => {
    await assign();
    expect((await request('/admin/users/member/provider')).status).toBe(403);
    const response = await request('/admin/users/member/provider', 'GET', undefined, 'admin-token');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(config.api_key); expect(text).not.toContain('synthetic-provider-secret');
    const row = await db.prepare("SELECT api_key FROM user_providers WHERE user_id='member'").first<{ api_key: string }>();
    expect(row?.api_key).not.toContain(config.api_key);
  });
  it('uses each member assigned key for actual import requests and background execution', async () => {
    await assign();
    await assign('other', { ...config, api_key: 'synthetic-other-dedicated-key' });
    expect((await request('/leads/import/preview', 'POST', { text: 'Synthetic member input', api_key: 'ignored-client-key' })).status).toBe(200);
    expect(research.previewImport.mock.calls[0][3].api_key).toBe(config.api_key);
    expect((await request('/leads/import/preview', 'POST', { text: 'Synthetic other input' }, 'other-token')).status).toBe(200);
    expect(research.previewImport.mock.calls[1][3].api_key).toBe('synthetic-other-dedicated-key');
    await seedLead(); await seedJob(); await runJob(env, 'j1');
    expect(research.researchLead).toHaveBeenCalledTimes(1);
    expect(research.researchLead.mock.calls[0][3].api_key).toBe(config.api_key);
  });
});
