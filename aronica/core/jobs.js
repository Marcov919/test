// Job intake (via the task compiler, fail-closed), serialization, ratings.
import { get, insert, update, all } from './db.js';
import { emit, eventsForJob } from './events.js';
import { rankCandidates, publicCandidate, nextAvailability } from './matching.js';
import { compileTask } from './compiler.js';
import { getService } from './services.js';
import { haversineKm, etaMinutes } from './geo.js';
import { RATING_TAGS, enforce } from './reliability.js';
import { slotLabel, durationLabel } from './time.js';
import { HttpError, clock, id, token, iso, toCents, eur, NO_SUPPLY_IT } from './util.js';

// Public base URL for links handed to agents (confirm_url). On Vercel the
// production domain is provided by the platform.
export const BASE_URL = () => process.env.ARONICA_PUBLIC_URL
  ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null)
  ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  ?? `http://localhost:${process.env.PORT || 8787}`;
export const LIVE = ['dispatching', 'assigned', 'in_progress'];

export const STATUS_IT = {
  scheduling: 'Cerco disponibilità',
  pending_confirmation: 'In attesa di conferma',
  dispatching: 'Assegno le persone…',
  assigned: 'Confermato',
  in_progress: 'In corso',
  done: 'Fatto',
  no_match: 'Nessuna persona disponibile',
  expired: 'Scaduto',
  cancelled: 'Annullato',
};
export const ASSIGNMENT_IT = {
  assigned: 'Confermato', en_route: 'In viaggio', on_site: 'Sul posto', done: 'Fatto', cancelled: 'Annullato', no_show: 'Non presentato',
};

// ---- intake -------------------------------------------------------------
export async function createJob(account, input) {
  const compiled = compileTask(input);
  if (!compiled.ready) {
    throw new HttpError(422, 'needs_input', 'Mancano informazioni per preparare l\'incarico.', { compiled, questions: compiled.questions.filter((q) => q.blocking) });
  }
  const service = getService(compiled.service.code);
  const maxPrice = toCents(input.max_price_eur, input.max_price_cents);
  if (maxPrice != null && compiled.price.total_cents > maxPrice) {
    throw new HttpError(422, 'over_budget', `Il prezzo (${eur(compiled.price.total_cents)}) supera il massimo indicato (${eur(maxPrice)}).`, { compiled });
  }
  const now = clock.now();
  const extra = (Array.isArray(input.instructions) ? input.instructions : String(input.instructions ?? '').split(/\n+/))
    .map((s) => String(s).trim()).filter(Boolean);
  const job = {
    id: id('job'),
    account_id: account.id,
    agent_name: String(input.agent_name ?? account.name).slice(0, 80),
    city: 'milano',
    service: service.code,
    title: compiled.title.slice(0, 140),
    request_text: input.text ? String(input.text).slice(0, 1000) : null,
    params: compiled.params,
    instructions: [...extra, ...compiled.instructions],
    proof_req: compiled.proof,
    address: compiled.location.address ?? `${compiled.location.lat.toFixed(4)}, ${compiled.location.lng.toFixed(4)}`,
    lat: compiled.location.lat,
    lng: compiled.location.lng,
    window_start: Date.parse(compiled.window.start),
    window_end: Date.parse(compiled.window.end),
    flexible: compiled.window.flexible ? 1 : 0,
    mode: compiled.mode ?? 'scheduled',
    duration_min: compiled.duration_min,
    headcount: compiled.headcount,
    price: compiled.price,
    max_price_cents: maxPrice,
    status: 'scheduling',
    confirm_token: token(),
    deal: { state: 'open' },
    created_at: now,
    updated_at: now,
  };
  const { eligible, excluded } = await rankCandidates(job);
  if (!eligible.length) {
    // Anyone who could do it on another day? Then negotiation can counter-propose.
    const nearby = (await all('SELECT * FROM workers WHERE status = ? AND verified = 1', 'active'))
      .filter((w) => w.skills.includes(job.service) && haversineKm(w, job) <= 18);
    const capable = (await Promise.all(nearby.map((w) => nextAvailability(w, job)))).filter(Boolean);
    if (!capable.length) {
      job.status = 'no_match';
      job.status_message = NO_SUPPLY_IT;
      await insert('jobs', job);
      await emit('job.no_match', { job_id: job.id, actor: account.name, data: { message: NO_SUPPLY_IT, stage: 'intake', excluded: summarizeExcluded(excluded) } });
      throw new HttpError(409, 'no_supply', NO_SUPPLY_IT, { job_id: job.id, excluded: summarizeExcluded(excluded) });
    }
  }
  await insert('jobs', job);
  await emit('job.created', { job_id: job.id, actor: account.name, data: { service: job.service, title: job.title, price_cents: job.price.total_cents, headcount: job.headcount, window: compiled.window.label } });
  return {
    job: await serializeJob(await get('SELECT * FROM jobs WHERE id = ?', job.id), { buyer: true }),
    compiled,
    supply: { available_in_window: eligible.length, top: eligible.slice(0, 5).map(publicCandidate), excluded: summarizeExcluded(excluded) },
    next: 'Poll supplier agents for a slot: negotiate(job_id) or auto_negotiate(job_id). Then accept_quote(quote_id).',
  };
}

export function summarizeExcluded(excluded) {
  const counts = {};
  for (const e of excluded) for (const r of e.reasons) counts[r] = (counts[r] ?? 0) + 1;
  return counts;
}

// ---- serialization -------------------------------------------------------
export async function publicWorker(w, job = null) {
  if (!w) return null;
  const r = await get('SELECT AVG(stars) AS a, COUNT(*) AS c FROM (SELECT stars FROM ratings WHERE worker_id = ? AND excluded = 0 ORDER BY created_at DESC LIMIT 100) AS recent', w.id);
  const out = {
    worker_ref: w.id, alias: w.display_name, kind: w.kind, verified: !!w.verified, insured: !!w.insured,
    vehicle: w.vehicle, zone: w.zone, avatar_color: w.avatar_color, jobs_completed: w.jobs_completed,
    rating: r.c ? Math.round(r.a * 100) / 100 : null, rating_count: r.c,
    position: { lat: w.lat, lng: w.lng },
  };
  if (job) {
    out.distance_km = Math.round(haversineKm(w, job) * 100) / 100;
    out.eta_min = etaMinutes(w, job, w.vehicle);
    out.how = w.service_notes?.[job.service] ?? null;
  }
  return out;
}

export function confirmUrl(job) {
  return `${BASE_URL()}/confirm/#/job/${job.id}?t=${job.confirm_token}`;
}

export async function serializeAssignment(a, job) {
  const w = await get('SELECT * FROM workers WHERE id = ?', a.worker_id);
  return {
    id: a.id,
    status: a.status,
    status_label: ASSIGNMENT_IT[a.status] ?? a.status,
    crew: a.crew,
    worker: await publicWorker(w, job),
    contract: a.contract ? { route: a.contract.route, label: a.contract.label_it, checks: a.contract.checks, text: a.contract.text, indicative: !!a.contract.indicative } : null,
    payout_cents: a.payout_cents,
    assigned_via: a.assigned_via,
    assigned_at: iso(a.assigned_at),
    started_at: iso(a.started_at),
    arrived_at: iso(a.arrived_at),
    completed_at: iso(a.completed_at),
    proof: a.proof,
    buyer_rating: a.buyer_rating,
  };
}

export async function serializeJob(job, { buyer = false, events = false } = {}) {
  if (!job) return null;
  const service = getService(job.service);
  const assignments = await all('SELECT * FROM assignments WHERE job_id = ? ORDER BY assigned_at', job.id);
  const slot = job.slot_start ?? null;
  const out = {
    id: job.id,
    status: job.status,
    status_label: STATUS_IT[job.status] ?? job.status,
    status_message: job.status_message,
    service: job.service,
    service_name: service?.name_it,
    segment: service?.segment,
    account_kind: (await get('SELECT kind FROM accounts WHERE id = ?', job.account_id))?.kind ?? 'consumer',
    mode: job.mode ?? 'scheduled',
    proof_kind: service?.proof?.kind,
    title: job.title,
    request_text: job.request_text,
    params: job.params,
    instructions: job.instructions,
    proof_requirements: job.proof_req,
    location: { address: job.address, lat: job.lat, lng: job.lng },
    window: { start: iso(job.window_start), end: iso(job.window_end), flexible: !!job.flexible, label: job.mode === 'now' ? 'Adesso' : job.flexible ? `${slotLabel(job.window_start, Math.round((job.window_end - job.window_start) / 60000))}` : slotLabel(job.window_start, job.duration_min) },
    slot: slot ? { start: iso(slot), end: iso(slot + job.duration_min * 60000), label: slotLabel(slot, job.duration_min) } : null,
    duration_min: job.duration_min,
    duration_label: durationLabel(job.duration_min),
    headcount: job.headcount,
    seats_filled: job.seats_filled,
    price: job.price,
    deal: job.deal?.state === 'locked' ? { ...job.deal, pool: undefined, participants: undefined, slot_start: iso(job.deal.slot_start), locked_at: iso(job.deal.locked_at) } : job.deal ? { state: job.deal.state } : null,
    approval: job.approval,
    escrow: job.escrow,
    invoice: job.invoice,
    assignments: await Promise.all(assignments.map((a) => serializeAssignment(a, job))),
    agent_name: job.agent_name,
    created_at: iso(job.created_at),
    updated_at: iso(job.updated_at),
    completed_at: iso(job.completed_at),
  };
  if (buyer) out.confirm_url = confirmUrl(job);
  if (job.status === 'dispatching') {
    out.dispatch = {
      pool_size: job.dispatch_pool?.length ?? 0,
      tried: (await get('SELECT COUNT(*) AS c FROM offers WHERE job_id = ?', job.id)).c,
      pending: (await all("SELECT worker_id, seats, expires_at FROM offers WHERE job_id = ? AND status = 'pending'", job.id)).map((o) => ({ ...o, expires_at: iso(o.expires_at) })),
    };
  }
  if (events) out.events = await eventsForJob(job.id, 0, 400);
  return out;
}

export async function loadJob(jobId) {
  const job = await get('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) throw new HttpError(404, 'job_not_found', 'Job not found');
  return job;
}

export async function listJobsForAccount(accountId, limit = 50) {
  return Promise.all((await all('SELECT * FROM jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT ?', accountId, limit)).map((j) => serializeJob(j)));
}

// ---- buyer rating (per person; two-way ratings) ----------------------------
export async function rateWorker(jobId, { worker_ref = null, stars, tags = [], comment = null }) {
  const job = await loadJob(jobId);
  if (job.status !== 'done') throw new HttpError(409, 'not_done', 'You can rate only completed jobs.');
  const done = await all("SELECT * FROM assignments WHERE job_id = ? AND status = 'done'", jobId);
  const a = worker_ref ? done.find((x) => x.worker_id === worker_ref) : done.length === 1 ? done[0] : null;
  if (!a) throw new HttpError(400, 'worker_ref_required', 'Specify worker_ref (one of the people who worked on this job).', { worker_refs: done.map((x) => x.worker_id) });
  if (a.buyer_rating) throw new HttpError(409, 'already_rated', 'Already rated.');
  const s = Number(stars);
  if (!Number.isInteger(s) || s < 1 || s > 5) throw new HttpError(400, 'invalid_stars', 'stars must be an integer 1..5');
  const clean = (Array.isArray(tags) ? tags : []).filter((t) => RATING_TAGS[t]);
  const excluded = clean.some((t) => RATING_TAGS[t].excluded) && s <= 3 ? 1 : 0;
  await insert('ratings', { id: id('r'), job_id: jobId, worker_id: a.worker_id, stars: s, tags: clean, comment: comment ? String(comment).slice(0, 500) : null, excluded, created_at: clock.now() });
  await update('assignments', a.id, { buyer_rating: s });
  await emit('rating.created', { job_id: jobId, worker_id: a.worker_id, actor: 'buyer', data: { stars: s, tags: clean, excluded: !!excluded } });
  const ev = await enforce(a.worker_id);
  return { ok: true, stars: s, tags: clean, excluded_from_average: !!excluded, worker_tier: ev?.tier };
}
