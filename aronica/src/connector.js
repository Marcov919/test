// Agent Connector: ONE set of tool definitions, exposed as MCP tools (/mcp),
// REST (/v1 + OpenAPI) and OpenAI/xAI function schemas (/v1/tools.json).
import { get } from './db.js';
import { listServices } from './services.js';
import { compileTask } from './compiler.js';
import { rankCandidates, publicCandidate, WEIGHTS, WEIGHT_LABELS_IT } from './matching.js';
import { createJob, serializeJob, loadJob, listJobsForAccount, rateWorker, summarizeExcluded } from './jobs.js';
import { negotiateRound, acceptQuote, autoNegotiate } from './negotiation.js';
import { buyerCancel } from './dispatch.js';
import { eventsForJob, waitForJobEvent } from './events.js';
import { RATING_TAGS } from './reliability.js';
import { CAPS, ROUTES } from './compliance.js';
import { CITY, GAZETTEER } from './geo.js';
import { HttpError, NO_SUPPLY_IT } from './util.js';

const location = {
  type: 'object',
  description: 'Where the work happens: lat/lng, or an address containing a known Milano place (see list_services → places).',
  properties: { address: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' } },
};
const window = {
  type: 'object',
  description: 'When. For flexible services (gardening, furniture…) the partner starts anywhere inside the window; for shifts (event staff, load-in crews) it is the exact shift.',
  properties: { start: { type: 'string', format: 'date-time' }, end: { type: 'string', format: 'date-time' } },
};
const mode = { type: 'string', enum: ['now', 'scheduled'], description: 'now = "Adesso": as soon as a partner is free (within 3h, short-notice surcharge). scheduled = "Programma": inside window (default).' };

export const TOOLS = [
  {
    name: 'list_services', method: 'GET', path: '/v1/services',
    description: 'Catalog of physical services Aronica dispatches in Milano for private people: car wash (pick-up & return, or mobile wash), waiting at home for a technician/courier, local pick-up & drop-off (pharmacy, keys, envelope; max 3 km), IKEA assembly, small handyman, cleaning, gardening, purchase errands. Business staffing (load-in crews, event staff, short-let turnover) is experimental. Each service has typed params, a fixed price and a proof type. Anything else fails closed.',
    input: { type: 'object', properties: {} },
  },
  {
    name: 'compile_task', method: 'POST', path: '/v1/tasks/compile',
    description: 'Turn a vague request ("Porta la mia auto all\'autolavaggio sabato mattina e riportamela, Navigli, berlina, interno+esterno" / "aspetta il corriere a casa mia domani 9-13") into a structured job: service, typed params, time window, headcount, duration, FIXED price with breakdown, proof, plus the questions still open. Nothing is booked. Use it to confirm details with your user before create_job.',
    input: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The user\'s request in natural language (Italian or English)' },
        service: { type: 'string', description: 'Optional explicit service code' },
        params: { type: 'object', description: 'Optional typed params (see list_services) — override what is parsed from text' },
        location, window, mode,
      },
    },
  },
  {
    name: 'search_supply', method: 'GET', path: '/v1/supply',
    description: 'Check live supply before booking: verified partners (people or local businesses) who do the service, are free in the window and accept the fixed price. Ranked (proximity, rating, reliability, service fit, acceptance) with how each one does the job. Pass the same text you compiled, or service + address. If nobody is available it says so: no fake matches.',
    input: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The request text (same as compile_task)' },
        service: { type: 'string' }, address: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' }, mode,
        start: { type: 'string', format: 'date-time' }, end: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', default: 5 },
      },
    },
  },
  {
    name: 'create_job', method: 'POST', path: '/v1/jobs',
    description: 'Create the job (compiled as in compile_task). Fails closed with an honest message if the task is out of scope or nobody can do it. Returns job_id, the fixed price and the confirm_url for your human.',
    input: {
      type: 'object',
      properties: {
        text: { type: 'string' }, service: { type: 'string' }, params: { type: 'object' }, location, window, mode,
        instructions: { type: 'array', items: { type: 'string' }, description: 'Extra step-by-step instructions for the partner (access, keys, referente…)' },
        max_price_eur: { type: 'number', description: 'Refuse if the fixed price is above this' },
        agent_name: { type: 'string' },
      },
    },
  },
  {
    name: 'negotiate', method: 'POST', path: '/v1/jobs/{job_id}/negotiate',
    description: 'A2A round on WHEN (price is fixed): supplier agents of the best partners check their calendars and reply accept (with a start time and how many seats they cover), counter (another slot) or decline. Optionally propose a different window.',
    input: { type: 'object', required: ['job_id'], properties: { job_id: { type: 'string' }, window, message: { type: 'string' } } },
  },
  {
    name: 'auto_negotiate', method: 'POST', path: '/v1/jobs/{job_id}/auto-negotiate',
    description: 'Let Aronica\'s buyer agent run the round and lock the best partner free in the window. If nobody is free, returns the counter-proposals for you/your human to pick.',
    input: { type: 'object', required: ['job_id'], properties: { job_id: { type: 'string' } } },
  },
  {
    name: 'accept_quote', method: 'POST', path: '/v1/jobs/{job_id}/accept-quote',
    description: 'Lock the slot from a supplier reply (accept or counter). Consumers: give confirm_url to your human (one tap). Business accounts: auto-approved under the company policy threshold and dispatched immediately.',
    input: { type: 'object', required: ['job_id', 'quote_id'], properties: { job_id: { type: 'string' }, quote_id: { type: 'string' } } },
  },
  {
    name: 'get_job', method: 'GET', path: '/v1/jobs/{job_id}',
    description: 'Job status (scheduling → pending_confirmation → dispatching → assigned → in_progress → done), slot, seats filled, each assigned person with contract type, proof (photos / timesheet, GPS check), escrow and invoice.',
    input: { type: 'object', required: ['job_id'], properties: { job_id: { type: 'string' }, include_events: { type: 'boolean' } } },
  },
  {
    name: 'list_jobs', method: 'GET', path: '/v1/jobs',
    description: 'Jobs created with your API key, newest first.',
    input: { type: 'object', properties: { limit: { type: 'integer', default: 20 } } },
  },
  {
    name: 'wait_for_update', method: 'GET', path: '/v1/jobs/{job_id}/events',
    description: 'Long-poll the job event stream (negotiation, seats filling, no-show replacements, check-ins, proof). Returns events after since_seq, waiting up to timeout_s.',
    input: { type: 'object', required: ['job_id'], properties: { job_id: { type: 'string' }, since_seq: { type: 'integer', default: 0 }, timeout_s: { type: 'integer', minimum: 0, maximum: 25, default: 20 } } },
  },
  {
    name: 'cancel_job', method: 'POST', path: '/v1/jobs/{job_id}/cancel',
    description: 'Cancel. Free until 24h before the slot; 20% after; 50% once someone is on the way (escrow stub).',
    input: { type: 'object', required: ['job_id'], properties: { job_id: { type: 'string' }, reason: { type: 'string' } } },
  },
  {
    name: 'rate_worker', method: 'POST', path: '/v1/jobs/{job_id}/rating',
    description: 'Rate a person who worked on a completed job (1-5). For multi-person jobs pass worker_ref. Tags marked "not the worker\'s fault" exclude a low rating from their average.',
    input: {
      type: 'object', required: ['job_id', 'stars'],
      properties: { job_id: { type: 'string' }, worker_ref: { type: 'string' }, stars: { type: 'integer', minimum: 1, maximum: 5 }, tags: { type: 'array', items: { type: 'string', enum: Object.keys(RATING_TAGS) } }, comment: { type: 'string' } },
    },
  },
];

function ownJob(account, jobId) {
  const job = loadJob(jobId);
  if (job.account_id !== account.id) throw new HttpError(404, 'job_not_found', 'Job not found');
  return job;
}

export function searchSupply(args = {}) {
  if (!args.service && !args.text) throw new HttpError(400, 'service_or_text_required', 'Pass text (as in compile_task) or a service code.');
  const c = compileTask({
    text: args.text, service: args.service, params: typeof args.params === 'object' ? args.params : undefined, mode: args.mode,
    location: args.location ?? (args.address || args.lat != null ? { address: args.address, lat: args.lat, lng: args.lng } : undefined),
    window: args.window ?? (args.start ? { start: args.start, end: args.end } : undefined),
  });
  const probe = {
    city: 'milano', service: c.service.code, lat: c.location?.lat ?? CITY.center.lat, lng: c.location?.lng ?? CITY.center.lng,
    window_start: Date.parse(c.window.start), window_end: Date.parse(c.window.end), flexible: c.window.flexible ? 1 : 0,
    duration_min: c.duration_min, price: c.price,
  };
  const { eligible, excluded } = rankCandidates(probe);
  return {
    service: c.service.code, title: c.title, window: c.window.label, price_cents: c.price.total_cents, available: eligible.length,
    ranking: { weights: WEIGHTS, labels_it: WEIGHT_LABELS_IT, filters: 'verified, active, does the service, within 18 km, free in the window, accepts the fixed pay' },
    partners: eligible.slice(0, Math.min(20, Number(args.limit ?? 5))).map(publicCandidate),
    excluded: summarizeExcluded(excluded), message: eligible.length ? null : NO_SUPPLY_IT,
  };
}

const handlers = {
  list_services() {
    return {
      city: CITY.name,
      services: listServices().map((s) => ({
        code: s.code, segment: s.segment, name: s.name_en, name_it: s.name_it, description: s.description,
        params: s.params, proof: s.proof, flexible_start: !!s.flexible, multi_person: !!s.multi_seat,
      })),
      places: GAZETTEER.map((g) => g.name),
      rating_tags: Object.fromEntries(Object.entries(RATING_TAGS).map(([k, v]) => [k, { label_it: v.label_it, not_workers_fault: !!v.excluded }])),
      contracts: { routes: ROUTES, presto_caps_indicative: CAPS },
      fail_closed: `Out-of-scope requests (lessons/teachers such as Capoeira, beauty, medical, certified plumbing/electrical…), other cities, errands beyond 3 km, or no available verified partners return: ${NO_SUPPLY_IT} (+ reason, e.g. "fuori ambito v1")`,
      simulated: 'Supplier agents run server-side; seed partners are simulated in the demo; escrow, payments and KYC are stubs.',
    };
  },
  compile_task(account, args) { return compileTask(args); },
  search_supply(account, args) { return searchSupply(args); },
  create_job(account, args) { return createJob(account, args); },
  async negotiate(account, args) {
    ownJob(account, args.job_id);
    return negotiateRound(args.job_id, { windows: args.window ? [args.window] : null, actor: account.name, message: args.message });
  },
  async auto_negotiate(account, args) {
    ownJob(account, args.job_id);
    const r = await autoNegotiate(args.job_id);
    const job = serializeJob(loadJob(args.job_id), { buyer: true });
    return { deal: r.deal, auto_approved: r.auto_approved ?? false, counters: r.counters ?? [], message: r.message ?? null, job, confirm_url: r.deal && !r.auto_approved ? job.confirm_url : null };
  },
  accept_quote(account, args) {
    ownJob(account, args.job_id);
    const r = acceptQuote(args.job_id, args.quote_id, { actor: account.name });
    const job = serializeJob(loadJob(args.job_id), { buyer: true });
    return {
      job, auto_approved: r.auto_approved, confirm_url: r.auto_approved ? null : job.confirm_url,
      next: r.auto_approved
        ? 'Auto-approved by company policy: partners are being dispatched. Follow with wait_for_update.'
        : 'Send confirm_url to your human. One tap confirms; dispatch starts immediately. Follow with wait_for_update.',
    };
  },
  get_job(account, args) { return serializeJob(ownJob(account, args.job_id), { buyer: true, events: !!args.include_events }); },
  list_jobs(account, args) { return { jobs: listJobsForAccount(account.id, Math.min(100, Number(args.limit ?? 20))) }; },
  async wait_for_update(account, args) {
    ownJob(account, args.job_id);
    const since = Number(args.since_seq ?? 0);
    const timeout = Math.min(25, Math.max(0, Number(args.timeout_s ?? 20))) * 1000;
    let events = eventsForJob(args.job_id, since);
    if (!events.length && timeout) { await waitForJobEvent(args.job_id, timeout); events = eventsForJob(args.job_id, since); }
    return { status: get('SELECT status FROM jobs WHERE id = ?', args.job_id).status, events, next_since_seq: events.length ? events[events.length - 1].seq : since };
  },
  cancel_job(account, args) { ownJob(account, args.job_id); return buyerCancel(args.job_id, args.reason); },
  rate_worker(account, args) { ownJob(account, args.job_id); return rateWorker(args.job_id, args); },
};

export async function callTool(account, name, args = {}) {
  const fn = handlers[name];
  if (!fn) throw new HttpError(404, 'unknown_tool', `Unknown tool ${name}`);
  return fn(account, args ?? {});
}

export function accountFromKey(key) {
  if (!key) return null;
  return get("SELECT * FROM accounts WHERE api_key = ? AND kind IN ('consumer','business')", key) ?? null;
}

export function openAiTools() {
  return TOOLS.map((t) => ({ type: 'function', function: { name: `aronica_${t.name}`, description: t.description, parameters: t.input } }));
}
