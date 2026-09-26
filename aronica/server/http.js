// Minimal HTTP toolkit (no framework): router, JSON/body helpers, auth helpers.
import { timingSafeEqual } from 'node:crypto';
import { HttpError } from '../core/util.js';

export function json(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}

export function readBody(req, limit) {
  // Some hosts hand over an already-parsed body.
  if (req.body !== undefined && req.body !== null) {
    const s = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    if (s.length > limit) return Promise.reject(new HttpError(413, 'payload_too_large', 'Request body too large'));
    return Promise.resolve(s);
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'payload_too_large', 'Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function parseJson(body) {
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw new HttpError(400, 'invalid_json', 'Body must be JSON'); }
}

export const safeEq = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function bearer(req, url) {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : (req.headers['x-api-key'] || url.searchParams.get('api_key') || null);
}

const NUMERIC = new Set(['lat', 'lng', 'limit', 'since_seq', 'timeout_s', 'stars']);
export function queryArgs(url) {
  const out = {};
  for (const [k, v] of url.searchParams) {
    if (k === 'api_key') continue;
    out[k] = NUMERIC.has(k) && v !== '' ? Number(v) : v === 'true' ? true : v === 'false' ? false : v;
  }
  return out;
}

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler, limit: opts.limit ?? 1_000_000 });
    return this;
  }
  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}
