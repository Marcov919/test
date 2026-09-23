// Agent Connector: ONE set of tool definitions, exposed as
//   - MCP tools (Streamable HTTP at /mcp, stdio via bin/aronica-mcp-stdio.js)
//   - REST endpoints under /v1 (+ OpenAPI 3.1 at /openapi.json)
//   - OpenAI/xAI function-calling schemas at /v1/tools.json
// so Claude, Grok, OpenAI and any tool-using agent can hire people.
import { get } from './db.js';
import { listSkills, getSkill } from './skills.js';
import { rankCandidates, publicCandidate } from './matching.js';
import { resolveLocation, createJob, serializeJob, loadJob, listJobsForAccount, rateWorker, summarizeExcluded } from './jobs.js';
import { negotiateRound, acceptQuote, autoNegotiate } from './negotiation.js';
import { buyerCancel } from './dispatch.js';
import { eventsForJob, waitForJobEvent } from './events.js';
import { RATING_TAGS } from './reliability.js';
import { CITY, GAZETTEER, inServiceArea } from './geo.js';
import { HttpError, clock, NO_SUPPLY_IT, toCents } from './util.js';

const locationSchema = {
  type: 'object',
  description: 'Where the work happens. Give lat/lng, or an address that contains a known Milano place (e.g. "Esselunga, Corso Buenos Aires").',
  properties: {
    address: { type: 'string' },
    lat: { type: 'number' },
    lng: { type: 'number' },
  },
};

export const TOOLS = [
  {
    name: 'list_skills',
    method: 'GET', path: '/v1/skills',
    description: 'List the physical task types Aronica can dispatch in Milano, with base prices, typical duration and default proof requirements. Anything not listed fails closed (Aronica does not do lifestyle services like teachers, nails, dentists).',
    input: { type: 'object', properties: {} },
  },
  {
    name: 'search_workers',
    method: 'GET', path: '/v1/workers',
    description: 'Query available verified workers for a skill near a location. Returns ranked, privacy-safe profiles (alias, rating, ETA, completion rate, score breakdown). Use before create_job to check supply.',
    input: {
      type: 'object',
      required: ['skill'],
      properties: {
        skill: { type: 'string', description: 'Skill code from list_skills, e.g. "shelf_check"' },
        address: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' },
        budget_max_eur: { type: 'number' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
      },
    },
  },
  {
    name: 'create_job',
    method: 'POST', path: '/v1/jobs',
    description: 'Create a structured physical task (deadline, instructions, proof, budget). Aronica classifies it to a skill (or fails closed with an honest message), checks live supply and opens a negotiation with supplier agents. Returns job_id and a confirm_url for your human.',
    input: {
      type: 'object',
      required: ['title', 'location'],
      properties: {
        title: { type: 'string', description: 'Short task title, e.g. "Check Barilla Pesto shelf at Esselunga Buenos Aires"' },
        description: { type: 'string' },
        skill: { type: 'string', description: 'Optional explicit skill code; otherwise inferred from title/description' },
        location: locationSchema,
        deadline: { type: 'string', format: 'date-time', description: 'ISO time by which proof must be delivered' },
        deadline_minutes: { type: 'integer', description: 'Alternative to deadline: minutes from now' },
        instructions: { type: 'array', items: { type: 'string' }, description: 'Step-by-step instructions for the worker' },
        proof: {
          type: 'object',
          properties: {
            photos_min: { type: 'integer' },
            checklist: { type: 'array', items: { type: 'string' }, description: 'Extra questions the worker must answer' },
          },
        },
        budget: {
          type: 'object',
          properties: { target_eur: { type: 'number' }, max_eur: { type: 'number' } },
        },
        agent_name: { type: 'string', description: 'Your agent name, shown to the human and the worker (e.g. "Claude", "Grok")' },
      },
    },
  },
  {
    name: 'negotiate',
    method: 'POST', path: '/v1/jobs/{job_id}/negotiate',
    description: 'Send one price offer to the supplier agents of the top-ranked workers. Each replies live with accept / counter / reject, price and ETA. Repeat with a new offer, or lock a deal with accept_quote.',
    input: {
      type: 'object',
      required: ['job_id', 'offer_eur'],
      properties: { job_id: { type: 'string' }, offer_eur: { type: 'number' }, message: { type: 'string' } },
    },
  },
  {
    name: 'auto_negotiate',
    method: 'POST', path: '/v1/jobs/{job_id}/auto-negotiate',
    description: 'Let Aronica\'s built-in buyer agent negotiate for you within your budget (opens at target, never exceeds max). Returns the locked deal or the best counter if no deal.',
    input: {
      type: 'object',
      required: ['job_id'],
      properties: { job_id: { type: 'string' }, target_eur: { type: 'number' }, max_eur: { type: 'number' } },
    },
  },
  {
    name: 'accept_quote',
    method: 'POST', path: '/v1/jobs/{job_id}/accept-quote',
    description: 'Lock the deal at a supplier agent\'s quote (accept or counter). The job moves to pending_confirmation: give the returned confirm_url to your human, who confirms Now or Schedule with one tap. Work is dispatched immediately after.',
    input: {
      type: 'object',
      required: ['job_id', 'quote_id'],
      properties: { job_id: { type: 'string' }, quote_id: { type: 'string' } },
    },
  },
  {
    name: 'get_job',
    method: 'GET', path: '/v1/jobs/{job_id}',
    description: 'Get job status (negotiating → pending_confirmation → dispatching → assigned → en_route → on_site → done), deal, assigned worker, live ETA and proof (photo URLs, checklist answers, GPS check).',
    input: {
      type: 'object',
      required: ['job_id'],
      properties: { job_id: { type: 'string' }, include_events: { type: 'boolean' } },
    },
  },
  {
    name: 'list_jobs',
    method: 'GET', path: '/v1/jobs',
    description: 'List jobs created with your API key, newest first.',
    input: { type: 'object', properties: { limit: { type: 'integer', default: 20 } } },
  },
  {
    name: 'wait_for_update',
    method: 'GET', path: '/v1/jobs/{job_id}/events',
    description: 'Long-poll the job event stream. Returns events after since_seq, waiting up to timeout_s for new ones. Use it to follow negotiation, dispatch and delivery without busy polling.',
    input: {
      type: 'object',
      required: ['job_id'],
      properties: {
        job_id: { type: 'string' },
        since_seq: { type: 'integer', default: 0 },
        timeout_s: { type: 'integer', minimum: 0, maximum: 25, default: 20 },
      },
    },
  },
  {
    name: 'cancel_job',
    method: 'POST', path: '/v1/jobs/{job_id}/cancel',
    description: 'Cancel a job. Free until the worker is on the way; afterwards a 30% cancellation fee applies (escrow stub).',
    input: { type: 'object', required: ['job_id'], properties: { job_id: { type: 'string' }, reason: { type: 'string' } } },
  },
  {
    name: 'rate_worker',
    method: 'POST', path: '/v1/jobs/{job_id}/rating',
    description: 'Rate the worker 1-5 after a job is done. Tags explain the rating; tags marked "not worker\'s fault" exclude a low rating from their average.',
    input: {
      type: 'object',
      required: ['job_id', 'stars'],
      properties: {
        job_id: { type: 'string' },
        stars: { type: 'integer', minimum: 1, maximum: 5 },
        tags: { type: 'array', items: { type: 'string', enum: Object.keys(RATING_TAGS) } },
        comment: { type: 'string' },
      },
    },
  },
];

function ownJob(account, jobId) {
  const job = loadJob(jobId);
  if (job.account_id !== account.id) throw new HttpError(404, 'job_not_found', 'Job not found');
  return job;
}

const handlers = {
  list_skills() {
    return {
      city: CITY.name,
      skills: listSkills().map((s) => ({
        code: s.code, name: s.name_en, name_it: s.name_it, description: s.description,
        base_price_eur: s.base_price_cents / 100, typical_minutes: s.typical_minutes, default_proof: s.default_proof,
      })),
      places: GAZETTEER.map((g) => g.name),
      rating_tags: Object.fromEntries(Object.entries(RATING_TAGS).map(([k, v]) => [k, { label_it: v.label_it, not_workers_fault: !!v.excluded }])),
      fail_closed: 'Requests outside these skills, outside Milano, or with no available verified workers return an honest error: ' + NO_SUPPLY_IT,
    };
  },

  search_workers(account, args) {
    const skill = getSkill(String(args.skill ?? ''));
    if (!skill) throw new HttpError(422, 'unsupported_skill', NO_SUPPLY_IT, { detail: `Unknown skill "${args.skill}". See list_skills.` });
    const loc = args.lat != null || args.address ? resolveLocation(args) : { ...CITY.center, address: 'Duomo' };
    if (!inServiceArea(loc)) throw new HttpError(422, 'outside_service_area', NO_SUPPLY_IT, { detail: 'Outside the Milano service area.' });
    const probe = {
      city: CITY.code, skill: skill.code, lat: loc.lat, lng: loc.lng, mode: 'now',
      deadline_at: clock.now() + 3 * 3600000, budget_max_cents: toCents(args.budget_max_eur, args.budget_max_cents),
    };
    const { eligible, excluded } = rankCandidates(probe);
    const limit = Math.min(20, Number(args.limit ?? 5));
    return {
      skill: skill.code,
      location: { address: loc.address, lat: loc.lat, lng: loc.lng },
      available: eligible.length,
      workers: eligible.slice(0, limit).map(publicCandidate),
      excluded: summarizeExcluded(excluded),
      message: eligible.length ? null : NO_SUPPLY_IT,
    };
  },

  create_job(account, args) {
    return createJob(account, args);
  },

  async negotiate(account, args) {
    ownJob(account, args.job_id);
    const cents = toCents(args.offer_eur, args.offer_cents);
    return negotiateRound(args.job_id, cents, { actor: account.name, message: args.message });
  },

  async auto_negotiate(account, args) {
    ownJob(account, args.job_id);
    const r = await autoNegotiate(args.job_id, {
      target_cents: toCents(args.target_eur, args.target_cents) ?? undefined,
      max_cents: toCents(args.max_eur, args.max_cents) ?? undefined,
    });
    const job = serializeJob(loadJob(args.job_id), { buyer: true });
    return { ...r, job, confirm_url: r.deal ? job.confirm_url : null };
  },

  accept_quote(account, args) {
    ownJob(account, args.job_id);
    acceptQuote(args.job_id, args.quote_id, { actor: account.name });
    const job = serializeJob(loadJob(args.job_id), { buyer: true });
    return {
      job,
      confirm_url: job.confirm_url,
      next: 'Send confirm_url to your human. They tap Conferma (Now or Schedule); dispatch starts immediately. Follow with wait_for_update.',
    };
  },

  get_job(account, args) {
    const job = ownJob(account, args.job_id);
    return serializeJob(job, { buyer: true, events: !!args.include_events });
  },

  list_jobs(account, args) {
    return { jobs: listJobsForAccount(account.id, Math.min(100, Number(args.limit ?? 20))) };
  },

  async wait_for_update(account, args) {
    ownJob(account, args.job_id);
    const since = Number(args.since_seq ?? 0);
    const timeout = Math.min(25, Math.max(0, Number(args.timeout_s ?? 20))) * 1000;
    let events = eventsForJob(args.job_id, since);
    if (!events.length && timeout) {
      await waitForJobEvent(args.job_id, timeout);
      events = eventsForJob(args.job_id, since);
    }
    const job = get('SELECT status FROM jobs WHERE id = ?', args.job_id);
    return { status: job.status, events, next_since_seq: events.length ? events[events.length - 1].seq : since };
  },

  cancel_job(account, args) {
    ownJob(account, args.job_id);
    return buyerCancel(args.job_id, args.reason);
  },

  rate_worker(account, args) {
    ownJob(account, args.job_id);
    return rateWorker(args.job_id, args);
  },
};

export async function callTool(account, name, args = {}) {
  const fn = handlers[name];
  if (!fn) throw new HttpError(404, 'unknown_tool', `Unknown tool ${name}`);
  return fn(account, args ?? {});
}

export function accountFromKey(key) {
  if (!key) return null;
  return get("SELECT * FROM accounts WHERE api_key = ? AND kind = 'agent'", key) ?? null;
}

// OpenAI / xAI (Grok) function-calling format
export function openAiTools() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: `aronica_${t.name}`, description: t.description, parameters: t.input },
  }));
}
