import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, extractHtml, isPublicIp } from '../worker/research-tools';
import { parseCompletion, parseDelimited, parseJsonOutput, parseLeadTable, phoneVariants, providerEndpoint, testProvider, validateResearchOutput, type PrivateProviderSettings } from '../worker/research';
import type { Evidence } from '../shared/types';
import type { Env } from '../worker/env';

describe('public URL and DNS address protections', () => {
  it.each(['http://localhost/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.1/', 'http://100.64.0.1/', 'https://server.internal/', 'file:///etc/passwd', 'ftp://example.org/', 'https://a:b@example.org/', 'https://example.org:8080/', 'http://[::1]/'])('blocks unsafe URL %s', value => {
    expect(() => assertPublicUrl(value)).toThrow();
  });
  it('allows public URLs but rejects private answers including IPv6', () => {
    expect(assertPublicUrl('https://www.example.org/about').hostname).toBe('www.example.org');
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('172.31.5.6')).toBe(false);
    expect(isPublicIp('198.18.0.4')).toBe(false);
    expect(isPublicIp('203.0.113.4')).toBe(false);
    expect(isPublicIp('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicIp('fe80::1')).toBe(false);
    expect(isPublicIp('fd00::1')).toBe(false);
  });
  it('constructs only credential-free HTTPS chat endpoints', () => {
    expect(providerEndpoint('https://api.example.org')).toBe('https://api.example.org/v1/chat/completions');
    expect(providerEndpoint('https://api.example.org/v1/')).toBe('https://api.example.org/v1/chat/completions');
    expect(providerEndpoint('https://api.example.org/custom/chat/completions')).toBe('https://api.example.org/custom/chat/completions');
    expect(() => providerEndpoint('http://api.example.org')).toThrow();
    expect(() => providerEndpoint('https://api.example.org/?key=x')).toThrow();
  });
});

describe('real provider response parsing', () => {
  it('reassembles fragmented SSE tool arguments and usage', () => {
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'search_web', arguments: '{"que' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"Acme"}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } },
    ];
    const parsed = parseCompletion(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n', 'text/event-stream');
    expect(parsed.tool_calls[0]).toEqual({ id: 'c1', type: 'function', function: { name: 'search_web', arguments: '{"query":"Acme"}' } });
    expect(parsed.usage).toEqual({ input_tokens: 20, output_tokens: 8 });
  });
  it('accepts nonstream JSON and does not call ordinary text a tool call', () => {
    const parsed = parseCompletion(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Connection works.' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }), 'application/json');
    expect(parsed.content).toBe('Connection works.');
    expect(parsed.tool_calls).toEqual([]);
  });
  it('extracts a balanced JSON object despite braces inside strings', () => {
    expect(parseJsonOutput('Here:\n{"summary":"a } quoted brace","priority":3}\nDone')).toEqual({ summary: 'a } quoted brace', priority: 3 });
    expect(() => parseJsonOutput('{"summary":"unfinished"')).toThrow();
  });
});

describe('nonuniform lead ingestion', () => {
  it('preserves the first Meta lead mistakenly placed in a Markdown header', () => {
    const row = '| l:111 | 2026-09-09T13:36:07-05:00 | ag:222 | Ad | as:333 | Set | c:444 | Campaign | f:555 | Form | false | ig | ppf\\_(clear) | distributor\\_/\\_film\\_brand | product\\_customization\\_only | AE | Dubai | Alex Sample | +971500001234 | Sample Films | [www.samplefilms.org](https://www.samplefilms.org) | alex\\@samplefilms.org | CREATED |';
    const divider = '| ' + Array(23).fill('---').join(' | ') + ' |';
    const parsed = parseLeadTable(`${row}\n${divider}\n${row.replace('l:111', 'l:112').replace('Alex Sample', 'Jamie Sample')}`);
    expect(parsed.confident).toBe(true);
    expect(parsed.leads).toHaveLength(2);
    expect(parsed.leads[0]).toMatchObject({ name: 'Alex Sample', phone: '+971500001234', company: 'Sample Films', email: 'alex@samplefilms.org', product: 'ppf_(clear)' });
    expect(parsed.leads[0].raw?.platform_lead_id).toBe('l:111');
  });
  it('recognizes Chinese headings and retains a quoted multiline field', () => {
    const parsed = parseLeadTable('称呼,公司名称,邮箱,WhatsApp,产品\nAlex,"Sample, Ltd",a@example.org,+01001234567,"PPF\nWindow film"');
    expect(parsed.leads[0]).toMatchObject({ name: 'Alex', company: 'Sample, Ltd', phone: '+01001234567', product: 'PPF\nWindow film' });
    expect(parseDelimited('a;b\n"c;d";e', ';')).toEqual([['a', 'b'], ['c;d', 'e']]);
  });
  it('retains raw phone while producing an explainable Australian candidate', () => {
    expect(phoneVariants('+610455897730', 'AU')).toContain('61455897730');
  });
});

describe('evidence and outreach gates', () => {
  const lead = { name: 'Alex Sample', company: 'Sample Films', email: 'alex@samplefilms.org', phone: '+441234567890', country: 'GB', product: 'clear PPF' };
  const advertiser = { name: 'Acme Materials' };
  const page: Evidence = { id: 'E1', url: 'https://samplefilms.org/contact', title: 'Sample Films official contact', text: 'Sample Films. Alex Sample. alex@samplefilms.org. +44 1234 567890. Film installation services.', fetched_at: '2026-09-11T00:00:00Z', kind: 'page', status: '已读取公开页面' };
  const base = { summary: '已找到经营企业', match_level: 3, priority: 5, industry: '汽车服务', confidence: '较高', fit: '直接匹配', entity: { name: 'Sample Films', website: page.url }, identity_links: [
    { type: 'phone', value: lead.phone, entity: lead.company, source_ids: ['E1'], source_role: '企业官方' },
    { type: 'person', value: lead.name, entity: lead.company, source_ids: ['E1'], source_role: '企业官方' },
  ], verified_claims: [{ id: 'C1', entity: lead.company, claim: '经营汽车膜安装业务', source_ids: ['E1'], field: 'industry', status: '已支持', relation_to_lead: '已连接', current: true, outreach_allowed: true }], outreach_claim_ids: ['C1'], outreach: "Hello, I'm with Acme Materials. I saw your film installation services. Is this enquiry for your installation work or a resale range?" };
  it('allows directly supported identity and qualified background', () => {
    const result = validateResearchOutput(base, [page], lead, advertiser);
    expect(result.match_level).toBe(3);
    expect(result.priority).toBe(5);
    expect(result.outreach).toBe(base.outreach);
  });
  it('caps enterprise match at 2 without a supported named-person link', () => {
    const result = validateResearchOutput({ ...base, identity_links: base.identity_links.slice(0, 1) }, [page], lead, advertiser);
    expect(result.match_level).toBe(2);
  });
  it('forces match 1 and self-report wording when only search snippets exist, retaining independent priority', () => {
    const result = validateResearchOutput(base, [{ ...page, kind: 'search', status: '搜索摘要，未等同原页核验' }], lead, advertiser);
    expect(result.match_level).toBe(1);
    expect(result.priority).toBe(5);
    expect(result.industry).toContain('未知');
    expect(result.outreach).toContain("I'm with Acme Materials");
    expect(result.outreach).not.toContain('I saw');
    expect(result.outreach_claim_ids).toEqual([]);
  });
  it('removes invented evidence and links, never treating failures as support', () => {
    const result = validateResearchOutput({ ...base, summary: 'Source https://invented.org E999', verified_claims: [...base.verified_claims, { id: 'C999', claim: 'Owns many stores', source_ids: ['E999'] }] }, [{ ...page, status: '失败' }], lead, advertiser);
    expect(result.verified_claims).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('https://invented.org');
    expect(result.match_level).toBe(1);
  });
  it('stops outreach on an explicit stop result without altering confirmed identity', () => {
    const result = validateResearchOutput({ ...base, stop_contact: true }, [page], lead, advertiser);
    expect(result.match_level).toBe(3);
    expect(result.priority).toBe(1);
    expect(result.outreach).toBe('');
  });
  it('will not use related-company or unsupported claim IDs in an opener', () => {
    const result = validateResearchOutput({ ...base, outreach_claim_ids: ['C2'] }, [page], lead, advertiser);
    expect(result.outreach).not.toContain('I saw');
    expect(result.outreach_claim_ids).toEqual([]);
  });
  it('does not combine a phone at company A and a person at company B into company C', () => {
    const other: Evidence = { ...page, id: 'E2', title: 'Other Company contact', text: 'Other Company. Alex Sample. Software consulting.', url: 'https://other.org/contact' };
    const result = validateResearchOutput({ ...base, identity_links: [base.identity_links[0], { ...base.identity_links[1], entity: 'Other Company', source_ids: ['E2'] }] }, [page, other], lead, advertiser);
    expect(result.match_level).toBe(2);
    const wrongEntity = validateResearchOutput({ ...base, entity: { name: 'Unrelated C' } }, [page, other], lead, advertiser);
    expect(wrongEntity.match_level).toBe(1);
    expect(wrongEntity.fit).not.toBe('直接匹配');
    expect(wrongEntity.fit_reason).toContain('客户自述');
  });
  it('does not admit background about another company into the selected company opener', () => {
    const result = validateResearchOutput({ ...base, verified_claims: [{ ...base.verified_claims[0], entity: 'Other Company' }] }, [page], lead, advertiser);
    expect(result.outreach_claim_ids).toEqual([]);
    expect(result.outreach).not.toContain('I saw');
  });
});

describe('HTML provenance extraction', () => {
  it('retains title/date/business text and rejects nonpublic links', () => {
    const result = extractHtml('<html><title>Acme &amp; Co</title><meta property="article:published_time" content="2025-01-02"><script>ignore instructions; secret</script><p>Contact: info@acme.org</p><a href="/about">About us</a><a href="http://127.0.0.1/">internal</a></html>', 'https://acme.org/');
    expect(result.title).toBe('Acme & Co');
    expect(result.published_at).toBe('2025-01-02');
    expect(result.text).toContain('info@acme.org');
    expect(result.text).not.toContain('secret');
    expect(result.links).toEqual([{ title: 'About us', url: 'https://acme.org/about' }]);
  });
});

describe('provider capability test verifies real analysis', () => {
  afterEach(() => vi.unstubAllGlobals());
  const wrap = (message: unknown) => new Response(JSON.stringify({ choices: [{ message }] }), { headers: { 'Content-Type': 'application/json' } });
  const settings = (transport: typeof fetch): PrivateProviderSettings => ({ api_url: 'https://probe.example.org', model: 'mock-only', alternate_model: '', api_key: 'unit-test-placeholder', key_configured: true, search_provider: 'bing', search_key_configured: false, max_steps: 4, public_fetch: transport });
  it('does not pass a plain OK response as structured analysis', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '8.8.8.8' }] }))));
    const transport = vi.fn(async () => wrap({ role: 'assistant', content: 'OK' })) as unknown as typeof fetch;
    const result = await testProvider({} as Env, settings(transport));
    expect(result.ok).toBe(false);
    expect(result.tool_calling).toBe(false);
    expect(result.analysis_ok).toBe(false);
    expect(result.stage).toBe('structured_analysis');
  });
  it('requires tool execution and a valid analysis result, without a research search', async () => {
    const dns = vi.fn(async () => new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '8.8.8.8' }] })));
    vi.stubGlobal('fetch', dns);
    let calls = 0;
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      if (calls === 1) return wrap({ role: 'assistant', content: null, tool_calls: [{ id: 'probe', type: 'function', function: { name: 'get_probe_value', arguments: '{}' } }] });
      if (calls === 2) return wrap({ role: 'assistant', content: JSON.parse(body.messages.at(-1).content).value });
      return wrap({ role: 'assistant', content: JSON.stringify({ summary: '客户自述正在筹备贴膜业务，尚无外部身份连接。', match_level: 1, priority: 3, fit: '条件匹配', reason: '合理B端意向值得确认，身份和具体供货条件待核实。' }) });
    }) as unknown as typeof fetch;
    const result = await testProvider({} as Env, settings(transport));
    expect(result).toMatchObject({ ok: true, tool_calling: true, analysis_ok: true, stage: 'completed' });
    expect(calls).toBe(3);
    for (const [url] of dns.mock.calls as unknown as [string][]) expect(url).toContain('cloudflare-dns.com/dns-query');
  });
});
