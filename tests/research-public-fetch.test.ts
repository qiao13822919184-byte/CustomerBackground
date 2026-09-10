import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ requests: [] as { options: Record<string, unknown>; body: string }[], addresses: [{ address: '8.8.8.8', family: 4 }], responseStatus: 200 }));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => harness.addresses) }));
vi.mock('node:https', () => ({ request: (options: Record<string, unknown>, callback: (response: EventEmitter) => void) => makeRequest(options, callback) }));
vi.mock('node:http', () => ({ request: (options: Record<string, unknown>, callback: (response: EventEmitter) => void) => makeRequest(options, callback) }));
import { pinnedPublicFetch } from '../server/public-fetch';

function makeRequest(options: Record<string, unknown>, callback: (response: EventEmitter) => void) {
  const saved = { options, body: '' }; harness.requests.push(saved);
  const req = new EventEmitter() as EventEmitter & { destroyed: boolean; setTimeout: () => void; write: (data: unknown) => void; end: () => void; destroy: (error: Error) => void };
  req.destroyed = false;
  req.setTimeout = () => {};
  req.write = data => { saved.body += String(data); };
  req.destroy = error => { req.destroyed = true; queueMicrotask(() => { req.emit('error', error); req.emit('close'); }); };
  req.end = () => queueMicrotask(() => {
    const dns = String(options.path).startsWith('/dns-query');
    const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; complete: boolean; resume: () => void };
    res.statusCode = dns ? 200 : harness.responseStatus;
    res.headers = { 'content-type': 'application/json', ...(res.statusCode === 302 ? { location: 'https://elsewhere.org/' } : {}) };
    res.complete = true; res.resume = () => {};
    callback(res);
    if (!req.destroyed) {
      const body = dns ? JSON.stringify({ Status: 0, Answer: harness.addresses.map(a => ({ type: a.family === 4 ? 1 : 28, data: a.address })) }) : 'public content';
      res.emit('data', Buffer.from(body)); res.emit('end'); req.emit('close');
    }
  });
  return req;
}

describe('Node fixed-address public transport', () => {
  beforeEach(() => { harness.requests.length = 0; harness.addresses = [{ address: '8.8.8.8', family: 4 }]; harness.responseStatus = 200; vi.stubEnv('OUTBOUND_PROXY_URL', ''); });
  afterEach(() => vi.unstubAllEnvs());
  it('connects to the verified IP and preserves TLS servername and Host', async () => {
    const response = await pinnedPublicFetch('https://public-a.org/contact', { redirect: 'manual' });
    expect(response.status).toBe(200);
    expect(harness.requests[0].options).toMatchObject({ hostname: '8.8.8.8', servername: 'public-a.org', headers: { host: 'public-a.org' } });
  });
  it('fails closed when even one DNS answer is private', async () => {
    harness.addresses = [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }];
    await expect(pinnedPublicFetch('https://mixed-answers.org/')).rejects.toThrow('私网');
    expect(harness.requests).toHaveLength(0);
  });
  it('uses a fixed public DoH destination through proxy, then pins the API destination', async () => {
    vi.stubEnv('OUTBOUND_PROXY_URL', 'http://127.0.0.1:7890');
    await pinnedPublicFetch('https://proxy-test.org/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer test-placeholder' }, body: '{"test":true}', redirect: 'error' });
    expect(harness.requests).toHaveLength(3);
    expect(harness.requests[0].options).toMatchObject({ hostname: '1.1.1.1', servername: 'cloudflare-dns.com' });
    expect(harness.requests[1].options).toMatchObject({ hostname: '1.1.1.1', servername: 'cloudflare-dns.com' });
    expect(harness.requests[0].options.headers).not.toHaveProperty('authorization');
    expect(harness.requests[1].options.headers).not.toHaveProperty('authorization');
    expect(harness.requests[2].options).toMatchObject({ hostname: '8.8.8.8', servername: 'proxy-test.org', headers: { host: 'proxy-test.org', authorization: 'Bearer test-placeholder' } });
    expect(harness.requests[2].body).toBe('{"test":true}');
  });
  it('does not follow a redirect for a protected API request', async () => {
    harness.responseStatus = 302;
    await expect(pinnedPublicFetch('https://redirect-protected.org/', { headers: { Authorization: 'Bearer test-placeholder' }, redirect: 'error' })).rejects.toThrow('重定向');
    expect(harness.requests).toHaveLength(1);
  });
  it('rejects literal private URLs and plaintext credential requests before connecting', async () => {
    await expect(pinnedPublicFetch('http://169.254.169.254/latest/meta-data')).rejects.toThrow();
    await expect(pinnedPublicFetch('http://public-c.org/', { headers: { Authorization: 'Bearer test-placeholder' } })).rejects.toThrow('HTTPS');
    expect(harness.requests).toHaveLength(0);
  });
});
