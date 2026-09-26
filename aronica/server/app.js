// HTTP application: one request handler shared by the local Node server and
// the Vercel function. API areas (each a separate contract):
//   Agent API    /v1/*, /mcp, /openapi.json, /v1/tools.json   (API key)
//   Confirm API  /api/jobs/:id/*                                (per-job token)
//   Partner API  /partner/v1/*                                  (partner session)
//   Ops API      /api/ops/*                                     (ops token)
//   Assistant    /api/assistant/*   simulated assistant platform (demo only)
// Static apps live in public/ (served by the CDN on Vercel, by us locally).
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../core/util.js';
import { setIdleHook } from '../core/events.js';
import { Router, json, readBody } from './http.js';
import { ensureReady, syncClock, maybeTick } from './runtime.js';
import { agentRoutes } from './routes/agent.js';
import { confirmRoutes } from './routes/confirm.js';
import { partnerRoutes } from './routes/partner.js';
import { opsRoutes } from './routes/ops.js';
import { webRoutes } from './routes/web.js';
import { assistantRoutes } from './routes/assistant.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

const router = new Router();
agentRoutes(router);
confirmRoutes(router);
partnerRoutes(router);
opsRoutes(router);
webRoutes(router);
assistantRoutes(router);

setIdleHook(maybeTick);

const CORS_PREFIXES = ['/v1', '/mcp', '/openapi.json'];

async function serveStatic(res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  let file = resolve(PUBLIC, '.' + normalize(p));
  if (!file.startsWith(PUBLIC)) return false;
  try {
    let s = await stat(file).catch(() => null);
    if (s?.isDirectory()) { file = join(file, 'index.html'); s = await stat(file).catch(() => null); }
    if (!s && !extname(file)) { file += '.html'; s = await stat(file).catch(() => null); }
    if (!s?.isFile()) return false;
    const headers = { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' };
    res.writeHead(200, headers);
    res.end(await readFile(file));
    return true;
  } catch { return false; }
}

// Plain (req, res) handler.
export async function handleRequest(req, res, { serveFiles = true } = {}) {
  const url = new URL(req.url, 'http://x');
  if (CORS_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-Api-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  }
  try {
    const hit = router.match(req.method, url.pathname);
    if (hit) {
      await ensureReady();
      await syncClock();
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req, hit.route.limit) : '';
      await hit.route.handler({ req, res, url, params: hit.params, body });
      return;
    }
    if (serveFiles && req.method === 'GET' && (await serveStatic(res, url))) return;
    json(res, 404, { error: 'not_found', message: 'Not found' });
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch { /* noop */ } return; }
    if (e instanceof HttpError) return json(res, e.status, { error: e.code, message: e.message, ...e.extra });
    console.error(e);
    json(res, 500, { error: 'internal_error', message: 'Internal error' });
  }
}
