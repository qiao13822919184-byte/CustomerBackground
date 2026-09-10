import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { assertPublicUrl, isPublicIp } from '../worker/research-tools';

interface Address { address: string; family: number }
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const dnsCache = new Map<string, { expires: number; addresses: Address[] }>();

/** This is a trusted server environment setting, never a user-supplied request field. */
function outboundProxy(): URL | undefined {
  const value = process.env.OUTBOUND_PROXY_URL;
  if (!value) return undefined;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) throw new Error('出站代理配置必须是HTTP(S)代理地址');
  return url;
}

function requestPinned(url: URL, address: Address, init: RequestInit, proxy?: URL, limit = RESPONSE_LIMIT): Promise<Response> {
  const secure = url.protocol === 'https:';
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  headers.host = url.host;
  // CONNECT uses a checked IP; Host and TLS SNI preserve the original hostname.
  const options = {
    hostname: address.address, family: address.family, port: url.port || (secure ? 443 : 80),
    method: init.method || 'GET', path: url.pathname + url.search, headers,
    ...(secure ? { servername: isIP(url.hostname) ? undefined : url.hostname } : {}),
    ...(proxy ? { agent: new HttpsProxyAgent(proxy) } : {}),
  };
  return new Promise<Response>((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)(options, res => {
      const status = res.statusCode || 502;
      if (status >= 300 && status < 400 && init.redirect === 'error') { res.resume(); req.destroy(new Error('拒绝模型或受保护请求的重定向')); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) { req.destroy(new Error('响应超过读取上限')); return; } chunks.push(chunk); });
      res.on('end', () => {
        if (req.destroyed && !res.complete) return;
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(',') : value);
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
      });
      res.on('error', reject);
    });
    req.setTimeout(110_000, () => req.destroy(new Error('远端请求超时')));
    req.on('error', reject);
    const abort = () => req.destroy(new Error('请求已中止'));
    req.on('close', () => init.signal?.removeEventListener('abort', abort));
    if (init.signal) { if (init.signal.aborted) { abort(); return; } init.signal.addEventListener('abort', abort, { once: true }); }
    if (init.body) {
      if (typeof init.body === 'string' || init.body instanceof Uint8Array) req.write(init.body);
      else if (init.body instanceof ArrayBuffer) req.write(Buffer.from(init.body));
      else { req.destroy(new Error('安全出站传输不支持该请求体类型')); return; }
    }
    req.end();
  });
}

async function resolvePublic(host: string, proxy?: URL): Promise<Address[]> {
  if (isIP(host)) { if (!isPublicIp(host)) throw new Error('拒绝访问私网或保留地址'); return [{ address: host, family: isIP(host) }]; }
  const cacheKey = `${proxy ? 'proxy' : 'direct'}:${host}`;
  const cached = dnsCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.addresses;
  let addresses: Address[];
  if (proxy) {
    // Fixed public DoH endpoint via the proxy; never include business API credentials.
    const responses = await Promise.all(['A', 'AAAA'].map(async type => {
      const url = new URL(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`);
      const response = await requestPinned(url, { address: '1.1.1.1', family: 4 }, { headers: { Accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.timeout(15_000) }, proxy, 64_000);
      if (!response.ok) throw new Error('代理DNS安全查询失败');
      const body = await response.json() as { Status?: number; Answer?: { type: number; data: string }[] };
      if (body.Status && body.Status !== 3) throw new Error('DNS安全查询未获得有效结果');
      return (body.Answer || []).filter(answer => answer.type === 1 || answer.type === 28).map(answer => ({ address: answer.data, family: answer.type === 1 ? 4 : 6 }));
    }));
    addresses = responses.flat();
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([lookup(host, { all: true, verbatim: true }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS解析超时')), 15_000); timer.unref(); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  if (!addresses.length || addresses.some(item => !isPublicIp(item.address))) throw new Error('拒绝访问私网、保留地址或未解析域名');
  addresses.sort((a, b) => a.family - b.family);
  if (dnsCache.size > 200) dnsCache.clear();
  dnsCache.set(cacheKey, { expires: Date.now() + 30_000, addresses });
  return addresses;
}

/** One hop only: caller validates redirects individually or sets redirect:error. */
export async function pinnedPublicFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = assertPublicUrl(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (new Headers(init.headers).has('authorization') && url.protocol !== 'https:') throw new Error('凭证请求必须使用HTTPS');
  const proxy = outboundProxy();
  const addresses = await resolvePublic(url.hostname, proxy);
  return requestPinned(url, addresses[0], init, proxy);
}
