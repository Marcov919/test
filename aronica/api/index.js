// Vercel Function entry: every API path is rewritten here (see vercel.json).
// The rewrite carries the original path in ?__p=…; static apps are served by
// Vercel's CDN from public/.
import { handleRequest } from '../server/app.js';
import { maybeTick } from '../server/runtime.js';

let waitUntil = null;
try { ({ waitUntil } = await import('@vercel/functions')); } catch { /* optional */ }

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.searchParams.get('__p');
  if (p != null) {
    url.searchParams.delete('__p');
    const qs = url.searchParams.toString();
    req.url = `/${p.replace(/^\/+/, '')}${qs ? `?${qs}` : ''}`;
  }
  await handleRequest(req, res, { serveFiles: false });
  // Keep the dispatch loop moving after the response (offer expiry, cascade, simulator).
  if (waitUntil && !String(req.headers.accept ?? '').includes('text/event-stream')) waitUntil(maybeTick().catch(() => {}));
}

export const config = { maxDuration: 60 };
