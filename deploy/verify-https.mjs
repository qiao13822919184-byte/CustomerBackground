// Run inside the app container after Caddy is healthy. Never print provider settings.
const origin = process.env.APP_ORIGIN;
const url = origin && new URL(origin);
if (!url || url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
  throw new Error('APP_ORIGIN must be a public HTTPS origin derived from APP_DOMAIN.');
}
let lastFailure = 'HTTPS endpoint unavailable';
for (let attempt = 1; attempt <= 8; attempt++) {
  try {
    const response = await fetch(new URL('/api/auth/status', url), {
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (typeof result.initialized !== 'boolean') throw new Error('Unexpected application response');
    console.log(`HTTPS endpoint verified: ${url.origin}`);
    process.exit(0);
  } catch (error) {
    lastFailure = error instanceof Error ? error.message : 'HTTPS request failed';
    if (attempt < 8) await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
console.error(`Containers started, but public HTTPS verification failed: ${lastFailure}. Check DNS, ports 80/443 and Caddy certificate logs.`);
process.exit(1);
