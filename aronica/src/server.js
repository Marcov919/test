import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openDb, get, all, update, insert, getSetting, setSetting } from './db.js';
import { seed, CONSOLE_ACCOUNT } from './seed.js';
import { TOOLS, callTool, accountFromKey, openAiTools } from './connector.js';
import { handleMcpHttp } from './mcp.js';
import { openApiSpec } from './openapi.js';
import { openSse, eventsForJob, recentEvents, realGps } from './events.js';
import { listSkills } from './skills.js';
import { CITY, GAZETTEER, VEHICLES, geocode, inServiceArea } from './geo.js';
import { RATING_TAGS, THRESHOLDS, evaluate, enforce } from './reliability.js';
import { WEIGHTS } from './matching.js';
import { createJob, serializeJob, loadJob, rateWorker, publicWorker, ACTIVE, BASE_URL } from './jobs.js';
import { autoNegotiate, quotesForJob } from './negotiation.js';
import {
  confirmJob, buyerCancel, respondOffer, startJob, arriveJob, submitProof, workerCancel,
  pendingOffersForWorker, tick, UPLOAD_DIR,
} from './dispatch.js';
import { moveWorkers, runBots } from './sim.js';
import { emit } from './events.js';
import { HttpError, clock, id, iso, token, NO_SUPPLY_IT } from './util.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------- helpers
function json(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolveP, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'payload_too_large', 'Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolveP(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(body) {
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw new HttpError(400, 'invalid_json', 'Body must be JSON'); }
}

const safeEq = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function bearer(req, url) {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : (req.headers['x-api-key'] || url.searchParams.get('api_key') || null);
}

function jobWithToken(jobId, t) {
  const job = loadJob(jobId);
  if (!safeEq(job.confirm_token, t ?? '')) throw new HttpError(403, 'invalid_token', 'Invalid or missing job token');
  return job;
}

function workerFromReq(req, url) {
  const t = req.headers['x-worker-token'] || url.searchParams.get('wt');
  const w = t ? get('SELECT * FROM workers WHERE token = ?', String(t)) : null;
  if (!w) throw new HttpError(401, 'unauthorized', 'Sessione lavoratore non valida');
  return w;
}

function requireOps(req, url) {
  const need = process.env.ARONICA_OPS_TOKEN;
  if (!need) return;
  const got = req.headers['x-ops-token'] || url.searchParams.get('ops_token');
  if (!safeEq(String(got ?? ''), need)) throw new HttpError(401, 'unauthorized', 'Ops token required');
}

const NUMERIC = new Set(['lat', 'lng', 'limit', 'since_seq', 'timeout_s', 'budget_max_eur', 'offer_eur', 'stars', 'target_eur', 'max_eur']);
function queryArgs(url) {
  const out = {};
  for (const [k, v] of url.searchParams) {
    if (k === 'api_key') continue;
    out[k] = NUMERIC.has(k) && v !== '' ? Number(v) : v === 'true' ? true : v === 'false' ? false : v;
  }
  return out;
}

// ---------------------------------------------------------------- views
function workerSelf(w) {
  const ev = evaluate(w);
  const jobs = all(`SELECT * FROM jobs WHERE assigned_worker_id = ? AND status IN ('assigned','en_route','on_site') ORDER BY assigned_at`, w.id);
  const history = all(`SELECT * FROM jobs WHERE assigned_worker_id = ? AND status IN ('done','cancelled','expired') ORDER BY updated_at DESC LIMIT 20`, w.id);
  const reviews = all('SELECT stars, tags, comment, excluded, created_at FROM ratings WHERE worker_id = ? AND job_id IS NOT NULL ORDER BY created_at DESC LIMIT 10', w.id);
  return {
    worker: {
      id: w.id, kind: w.kind, display_name: w.display_name, legal_name: w.legal_name, vat_id: w.vat_id, bio: w.bio,
      zone: w.zone, lat: w.lat, lng: w.lng, vehicle: w.vehicle, skills: w.skills, skill_jobs: w.skill_jobs,
      capacity: w.capacity, online: !!w.online, verified: !!w.verified, verification_note: w.verification_note,
      status: w.status, tier: w.tier, tier_reasons: w.tier_reasons, avatar_color: w.avatar_color,
      jobs_completed: w.jobs_completed, earnings_cents: w.earnings_cents, simulated: !!w.simulated, real_gps: realGps.has(w.id),
    },
    reliability: {
      tier: ev.tier, reasons: ev.reasons,
      rating: ev.rating, completion: ev.metrics.completion, acceptance: ev.metrics.acceptance, cancel_rate: ev.metrics.cancel_rate,
      no_shows: w.no_shows, thresholds: THRESHOLDS,
    },
    active_jobs: jobs.map((j) => ({ ...serializeJob(j), proof_requirements: j.proof_req, pay_cents: j.deal?.worker_payout_cents })),
    offers: pendingOffersForWorker(w.id),
    history: history.map((j) => ({ id: j.id, title: j.title, status: j.status, pay_cents: j.status === 'done' ? j.deal?.worker_payout_cents : 0, completed_at: iso(j.completed_at ?? j.updated_at), buyer_rating: j.buyer_rating, skill: j.skill })),
    reviews: reviews.map((r) => ({ ...r, created_at: iso(r.created_at) })),
  };
}

function opsState() {
  const workers = all('SELECT * FROM workers ORDER BY status, display_name').map((w) => {
    const ev = evaluate(w);
    return {
      id: w.id, kind: w.kind, display_name: w.display_name, zone: w.zone, lat: w.lat, lng: w.lng, vehicle: w.vehicle,
      skills: w.skills, online: !!w.online, verified: !!w.verified, status: w.status, tier: ev.tier, reasons: ev.reasons,
      rating: ev.rating.raw_avg, rating_bayes: ev.rating.bayes_avg, ratings: ev.rating.count,
      completion: ev.metrics.completion, acceptance: ev.metrics.acceptance, active_jobs: ev.metrics.active_jobs,
      capacity: w.capacity, avatar_color: w.avatar_color, simulated: !!w.simulated, no_shows: w.no_shows, jobs_completed: w.jobs_completed,
    };
  });
  const jobs = all('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 40').map((j) => serializeJob(j));
  const offers = all("SELECT o.*, w.display_name FROM offers o JOIN workers w ON w.id = o.worker_id ORDER BY o.created_at DESC LIMIT 40")
    .map((o) => ({ ...o, created_at: iso(o.created_at), expires_at: iso(o.expires_at), responded_at: iso(o.responded_at) }));
  const accounts = all("SELECT id, name, kind, api_key, created_at FROM accounts WHERE kind = 'agent'")
    .map((a) => ({ ...a, api_key: a.api_key.slice(0, 6) + '…' + a.api_key.slice(-4), created_at: iso(a.created_at) }));
  return {
    workers, jobs, offers, accounts,
    events: recentEvents(60),
    settings: { offer_ttl_s: getSetting('offer_ttl_s', 20), simulate_workers: getSetting('simulate_workers', true), sim_speedup: getSetting('sim_speedup', 30) },
  };
}

function config() {
  return {
    city: CITY,
    places: GAZETTEER.map(({ name, lat, lng }) => ({ name, lat, lng })),
    skills: listSkills().map((s) => ({ code: s.code, name_it: s.name_it, name_en: s.name_en, description: s.description, base_price_cents: s.base_price_cents, typical_minutes: s.typical_minutes, default_proof: s.default_proof })),
    rating_tags: RATING_TAGS,
    vehicles: VEHICLES,
    weights: WEIGHTS,
    thresholds: THRESHOLDS,
    no_supply_message: NO_SUPPLY_IT,
    base_url: BASE_URL(),
  };
}

// ---------------------------------------------------------------- routes
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handler, limit: opts.limit ?? 1_000_000 });
};

// --- Agent Connector: REST generated from tool definitions
for (const t of TOOLS) {
  const pattern = t.path.replace(/\{(\w+)\}/g, ':$1');
  route(t.method, pattern, async ({ req, res, url, params, body }) => {
    const account = accountFromKey(bearer(req, url));
    if (!account) throw new HttpError(401, 'unauthorized', 'Send Authorization: Bearer <Aronica API key>. Demo key: ak_demo_milano');
    if (t.name === 'wait_for_update' && (req.headers.accept ?? '').includes('text/event-stream')) {
      const job = loadJob(params.job_id);
      if (job.account_id !== account.id) throw new HttpError(404, 'job_not_found', 'Job not found');
      const since = Number(url.searchParams.get('since_seq') ?? req.headers['last-event-id'] ?? 0);
      openSse(req, res, { filter: (e) => e.job_id === job.id, backlog: eventsForJob(job.id, since) });
      return;
    }
    const args = { ...queryArgs(url), ...(t.method === 'POST' ? parseJson(body) : {}), ...params };
    const out = await callTool(account, t.name, args);
    json(res, t.name === 'create_job' ? 201 : 200, out);
  });
}
route('GET', '/v1/tools.json', ({ res }) => json(res, 200, { tools: openAiTools() }));
route('GET', '/openapi.json', ({ res }) => json(res, 200, openApiSpec()));
route('POST', '/mcp', async ({ req, res, url, body }) => handleMcpHttp(req, res, body, accountFromKey(bearer(req, url))));
route('GET', '/mcp', async ({ req, res }) => handleMcpHttp(req, res, '', null));
route('DELETE', '/mcp', async ({ req, res }) => handleMcpHttp(req, res, '', null));

// --- Web apps
route('GET', '/api/config', ({ res }) => json(res, 200, config()));
route('GET', '/api/geocode', ({ res, url }) => {
  const g = geocode(url.searchParams.get('q') ?? '');
  json(res, 200, g ? { ...g, in_service_area: inServiceArea(g) } : { error: 'not_found' });
});

// Buyer console (human). The console's own buyer agent is Aronica's built-in one.
route('POST', '/api/console/jobs', ({ res, body }) => {
  const account = get('SELECT * FROM accounts WHERE id = ?', CONSOLE_ACCOUNT);
  const input = parseJson(body);
  const out = createJob(account, { ...input, agent_name: input.agent_name || 'Aronica Buyer Agent' });
  const job = loadJob(out.job.id);
  json(res, 201, { ...out, token: job.confirm_token });
});
route('GET', '/api/jobs/:id', ({ res, url, params }) => {
  const job = jobWithToken(params.id, url.searchParams.get('t'));
  const quotes = quotesForJob(job.id).map((q) => ({ ...q, created_at: iso(q.created_at) }));
  json(res, 200, { job: serializeJob(job, { buyer: true, events: true }), quotes });
});
route('POST', '/api/jobs/:id/auto-negotiate', async ({ res, url, params, body }) => {
  const job = jobWithToken(params.id, url.searchParams.get('t'));
  const b = parseJson(body);
  if (b.restart && job.status === 'negotiating') update('jobs', job.id, { negotiation_round: 0, deal: { state: 'open' } });
  // Respond immediately; the negotiation streams over SSE.
  json(res, 202, { ok: true });
  autoNegotiate(job.id, {
    target_cents: b.target_eur != null ? Math.round(b.target_eur * 100) : undefined,
    max_cents: b.max_eur != null ? Math.round(b.max_eur * 100) : undefined,
  }).catch((e) => emit('negotiation.failed', { job_id: job.id, data: { message: e.message } }));
});
route('POST', '/api/jobs/:id/confirm', ({ res, url, params, body }) => {
  jobWithToken(params.id, url.searchParams.get('t'));
  const job = confirmJob(params.id, parseJson(body));
  json(res, 200, { job: serializeJob(job, { buyer: true }) });
});
route('POST', '/api/jobs/:id/cancel', ({ res, url, params, body }) => {
  jobWithToken(params.id, url.searchParams.get('t'));
  json(res, 200, buyerCancel(params.id, parseJson(body).reason));
});
route('POST', '/api/jobs/:id/rating', ({ res, url, params, body }) => {
  jobWithToken(params.id, url.searchParams.get('t'));
  json(res, 200, rateWorker(params.id, parseJson(body)));
});

// Worker / Business app
route('GET', '/api/workers/demo', ({ res }) => {
  json(res, 200, all('SELECT id, kind, display_name, zone, status, tier, online, vehicle, skills, avatar_color, simulated FROM workers ORDER BY kind DESC, display_name'));
});
route('POST', '/api/worker/login', ({ res, body }) => {
  // Demo login (v1 has no SMS provider): pick a persona. Production = phone OTP.
  const w = get('SELECT id, token FROM workers WHERE id = ?', String(parseJson(body).worker_id ?? ''));
  if (!w) throw new HttpError(404, 'not_found', 'Lavoratore non trovato');
  json(res, 200, { token: w.token });
});
route('POST', '/api/worker/signup', ({ res, body }) => {
  const b = parseJson(body);
  const kind = b.kind === 'business' ? 'business' : 'person';
  const name = String(b.display_name ?? '').trim().slice(0, 60);
  if (name.length < 2) throw new HttpError(400, 'name_required', 'Inserisci un nome');
  if (kind === 'business' && !/^IT\d{11}$/.test(String(b.vat_id ?? '').replace(/\s/g, ''))) throw new HttpError(400, 'vat_required', 'Partita IVA non valida (formato IT + 11 cifre)');
  const place = GAZETTEER.find((g) => g.name === b.zone) ?? GAZETTEER[0];
  const codes = new Set(listSkills().map((s) => s.code));
  const skills = (Array.isArray(b.skills) ? b.skills : []).filter((s) => codes.has(s));
  if (!skills.length) throw new HttpError(400, 'skills_required', 'Scegli almeno una competenza');
  const w = {
    id: id(kind === 'business' ? 'b' : 'w'), kind, display_name: name, legal_name: b.legal_name ? String(b.legal_name).slice(0, 120) : null,
    vat_id: kind === 'business' ? String(b.vat_id).replace(/\s/g, '') : null, bio: b.bio ? String(b.bio).slice(0, 200) : null,
    city: 'milano', zone: place.name, lat: place.lat, lng: place.lng, vehicle: VEHICLES[b.vehicle] ? b.vehicle : 'bike',
    skills, skill_jobs: {}, rate_multiplier: 1, capacity: kind === 'business' ? Math.max(1, Math.min(20, Number(b.capacity ?? 2))) : 1,
    online: 0, verified: 0, status: 'pending_verification', tier: 'good', tier_reasons: [], avatar_color: '#495057',
    simulated: 0, token: token(), joined_at: clock.now(),
  };
  insert('workers', w);
  emit('worker.signed_up', { worker_id: w.id, data: { kind, display_name: name } });
  json(res, 201, { token: w.token });
});
route('GET', '/api/worker/me', ({ req, res, url }) => json(res, 200, workerSelf(workerFromReq(req, url))));
route('POST', '/api/worker/online', ({ req, res, url, body }) => {
  const w = workerFromReq(req, url);
  const online = !!parseJson(body).online;
  if (online && (w.status !== 'active' || !w.verified)) {
    throw new HttpError(409, 'not_allowed', w.status === 'suspended' ? 'Account sospeso: non puoi andare online' : 'Account in verifica: potrai andare online dopo la verifica');
  }
  update('workers', w.id, { online: online ? 1 : 0 });
  emit(online ? 'worker.online' : 'worker.offline', { worker_id: w.id });
  json(res, 200, { online });
});
route('POST', '/api/worker/location', ({ req, res, url, body }) => {
  const w = workerFromReq(req, url);
  const b = parseJson(body);
  if (b.real === false) { realGps.delete(w.id); return json(res, 200, { ok: true }); }
  const lat = Number(b.lat); const lng = Number(b.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HttpError(400, 'invalid_location', 'lat/lng required');
  realGps.add(w.id);
  update('workers', w.id, { lat, lng });
  const j = get("SELECT id FROM jobs WHERE assigned_worker_id = ? AND status IN ('en_route','on_site')", w.id);
  emit('worker.location', { worker_id: w.id, job_id: j?.id ?? null, data: { lat, lng, simulated: false } });
  json(res, 200, { ok: true });
});
route('POST', '/api/worker/offers/:id/:action', ({ req, res, url, params }) => {
  const w = workerFromReq(req, url);
  if (!['accept', 'decline'].includes(params.action)) throw new HttpError(404, 'not_found', 'Not found');
  json(res, 200, respondOffer(w.id, params.id, params.action === 'accept', { via: 'app' }));
});
route('POST', '/api/worker/jobs/:id/:action', ({ req, res, url, params, body }) => {
  const w = workerFromReq(req, url);
  const b = parseJson(body);
  const a = params.action;
  if (a === 'start') return json(res, 200, startJob(w.id, params.id));
  if (a === 'arrive') return json(res, 200, arriveJob(w.id, params.id));
  if (a === 'cancel') return json(res, 200, workerCancel(w.id, params.id, b.reason));
  if (a === 'proof') return json(res, 200, submitProof(w.id, params.id, { photos: b.photos, answers: b.answers }));
  if (a === 'rate-buyer') {
    const job = loadJob(params.id);
    if (job.assigned_worker_id !== w.id || job.status !== 'done') throw new HttpError(409, 'invalid_state', 'Non valutabile');
    const s = Number(b.stars);
    if (!Number.isInteger(s) || s < 1 || s > 5) throw new HttpError(400, 'invalid_stars', '1..5');
    update('jobs', job.id, { worker_rating_of_buyer: s });
    emit('rating.buyer_rated', { job_id: job.id, worker_id: w.id, data: { stars: s } });
    return json(res, 200, { ok: true });
  }
  throw new HttpError(404, 'not_found', 'Not found');
}, { limit: 45_000_000 });

// Live streams
route('GET', '/api/stream', ({ req, res, url }) => {
  if (url.searchParams.get('job')) {
    const job = jobWithToken(url.searchParams.get('job'), url.searchParams.get('t'));
    const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? 0);
    return openSse(req, res, { filter: (e) => e.job_id === job.id, backlog: since ? eventsForJob(job.id, since) : [] });
  }
  if (url.searchParams.get('wt')) {
    const w = workerFromReq(req, url);
    return openSse(req, res, { filter: (e) => e.worker_id === w.id || (e.job_id && get('SELECT 1 AS x FROM jobs WHERE id = ? AND assigned_worker_id = ?', e.job_id, w.id)), workerId: w.id });
  }
  if (url.searchParams.get('ops')) {
    requireOps(req, url);
    return openSse(req, res, { filter: () => true });
  }
  throw new HttpError(400, 'bad_request', 'Specify job, wt or ops');
});

// Ops (platform)
route('GET', '/api/ops/state', ({ req, res, url }) => { requireOps(req, url); json(res, 200, opsState()); });
route('POST', '/api/ops/workers/:id/:action', ({ req, res, url, params }) => {
  requireOps(req, url);
  const w = get('SELECT * FROM workers WHERE id = ?', params.id);
  if (!w) throw new HttpError(404, 'not_found', 'Worker not found');
  if (params.action === 'verify') {
    update('workers', w.id, { verified: 1, status: 'active', verification_note: w.kind === 'business' ? 'P.IVA verificata da ops (stub KYB)' : 'Documento verificato da ops (stub KYC)' });
    emit('worker.verified', { worker_id: w.id });
  } else if (params.action === 'reinstate') {
    // Ops review after suspension: reset the counters that triggered it.
    update('workers', w.id, { status: 'active', no_shows: 0, tier: 'good', tier_reasons: [] });
    emit('worker.reinstated', { worker_id: w.id });
    enforce(w.id);
    const after = get('SELECT status FROM workers WHERE id = ?', w.id);
    if (after.status === 'suspended') update('workers', w.id, { status: 'active', tier: 'warning' });
  } else if (params.action === 'toggle-online') {
    if (!w.online && (w.status !== 'active' || !w.verified)) throw new HttpError(409, 'not_allowed', 'Worker not active/verified');
    update('workers', w.id, { online: w.online ? 0 : 1 });
    emit(w.online ? 'worker.offline' : 'worker.online', { worker_id: w.id, actor: 'ops' });
  } else throw new HttpError(404, 'not_found', 'Unknown action');
  json(res, 200, { ok: true });
});
route('POST', '/api/ops/settings', ({ req, res, url, body }) => {
  requireOps(req, url);
  const b = parseJson(body);
  if (b.offer_ttl_s != null) setSetting('offer_ttl_s', Math.max(5, Math.min(120, Number(b.offer_ttl_s))));
  if (b.simulate_workers != null) setSetting('simulate_workers', !!b.simulate_workers);
  if (b.sim_speedup != null) setSetting('sim_speedup', Math.max(1, Math.min(120, Number(b.sim_speedup))));
  json(res, 200, opsState().settings);
});
route('POST', '/api/ops/keys', ({ req, res, url, body }) => {
  requireOps(req, url);
  const name = String(parseJson(body).name ?? 'Agent').slice(0, 60);
  const key = `ak_${token(18)}`;
  insert('accounts', { id: id('acc'), name, kind: 'agent', api_key: key, created_at: clock.now() });
  json(res, 201, { name, api_key: key });
});

// ---------------------------------------------------------------- static
const PAGES = { '/': 'index.html', '/buyer': 'buyer.html', '/worker': 'worker.html', '/ops': 'ops.html', '/docs': 'docs.html' };

async function serveStatic(req, res, url) {
  let file;
  if (PAGES[url.pathname]) file = join(PUBLIC, PAGES[url.pathname]);
  else if (url.pathname.startsWith('/uploads/')) {
    const base = resolve(UPLOAD_DIR());
    file = resolve(base, '.' + normalize(decodeURIComponent(url.pathname.slice('/uploads'.length))));
    if (!file.startsWith(base)) return false;
  } else if (url.pathname === '/llms.txt') file = join(PUBLIC, 'llms.txt');
  else {
    file = resolve(PUBLIC, '.' + normalize(decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC)) return false;
  }
  try {
    const s = await stat(file);
    if (!s.isFile()) return false;
    const data = await readFile(file);
    const headers = { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' };
    if (extname(file) === '.svg') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
    res.writeHead(200, headers);
    res.end(data);
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------- server
export function createApp() {
  return http.createServer(handleRequest);
}

// Plain (req, res) handler: used by node:http and by the in-browser demo build.
export async function handleRequest(req, res) {
  {
    const url = new URL(req.url, 'http://x');
    const isApi = url.pathname.startsWith('/v1') || url.pathname === '/mcp' || url.pathname === '/openapi.json';
    if (isApi) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-Api-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    }
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req, r.limit) : '';
        await r.handler({ req, res, url, params, body });
        return;
      }
      if (req.method === 'GET' && (await serveStatic(req, res, url))) return;
      json(res, 404, { error: 'not_found', message: 'Not found' });
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* noop */ } return; }
      if (e instanceof HttpError) return json(res, e.status, { error: e.code, message: e.message, ...e.extra });
      console.error(e);
      json(res, 500, { error: 'internal_error', message: 'Internal error' });
    }
  }
}

export function startLoop(tickMs = Number(process.env.ARONICA_TICK_MS ?? 2000)) {
  let last = Date.now();
  const h = setInterval(() => {
    const now = Date.now();
    const dt = now - last;
    last = now;
    try { tick(); moveWorkers(dt); runBots(); } catch (e) { console.error('tick error', e); }
  }, tickMs);
  return () => clearInterval(h);
}

export function boot({ dbPath = process.env.ARONICA_DB || join(ROOT, 'data', 'aronica.db'), port = Number(process.env.PORT || 8787), loop = true } = {}) {
  openDb(dbPath);
  const seeded = seed();
  const server = createApp();
  const stop = loop ? startLoop() : () => {};
  server.on('close', stop);
  return new Promise((r) => server.listen(port, () => r({ server, seeded, port: server.address().port })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port, seeded } = await boot();
  const base = process.env.ARONICA_PUBLIC_URL || `http://localhost:${port}`;
  console.log(`
  Aronica · Agent→Human dispatch · Milano${seeded ? ' (seeded demo data)' : ''}
  ─────────────────────────────────────────────
  Buyer console   ${base}/buyer
  Worker app      ${base}/worker
  Ops             ${base}/ops
  Connect agents  ${base}/docs
  MCP endpoint    ${base}/mcp        (Bearer ak_demo_milano)
  REST / OpenAPI  ${base}/v1  ·  ${base}/openapi.json
`);
}

export { ACTIVE, publicWorker };
