import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const websiteId = process.env.DEMO_WEBSITE_ID;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(websiteId || '')) {
  throw new Error('DEMO_WEBSITE_ID must be the UUID of a separate demo website.');
}
const analytics = new URL(process.env.DEMO_ANALYTICS_URL);
if (
  !['http:', 'https:'].includes(analytics.protocol) ||
  analytics.username ||
  analytics.password ||
  analytics.search ||
  analytics.hash
) {
  throw new Error(
    'DEMO_ANALYTICS_URL must be an HTTP(S) base URL without credentials, query, or fragment.',
  );
}
const analyticsUrl = analytics.href.replace(/\/$/, '');
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/explore', ['index.html', 'text/html; charset=utf-8']],
  ['/about', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);
const assets = new Map(
  await Promise.all(
    [...files].map(async ([route, [file, type]]) => [
      route,
      { type, body: await readFile(new URL(file, import.meta.url)) },
    ]),
  ),
);

createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self' ${analytics.origin}; connect-src 'self' ${analytics.origin}; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
  );
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let pathname;
  try {
    pathname = new URL(request.url, 'http://localhost').pathname;
  } catch {
    response.writeHead(400).end();
    return;
  }
  const asset =
    pathname === '/config.json'
      ? { type: 'application/json', body: JSON.stringify({ websiteId, analyticsUrl }) }
      : pathname === '/health'
        ? { type: 'application/json', body: '{"status":"ok"}' }
        : assets.get(pathname);
  if (!asset) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': asset.type });
  response.end(request.method === 'HEAD' ? undefined : asset.body);
}).listen(3301, '::', () =>
  console.log('Monkelytics demo listening on port 3301 (IPv4 and IPv6).'),
);
