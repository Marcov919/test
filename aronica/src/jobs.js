// Job intake (fail-closed), serialization, and buyer-side lifecycle actions.
import { get, insert, update, all } from './db.js';
import { emit, eventsForJob } from './events.js';
import { rankCandidates, publicCandidate } from './matching.js';
import { classify, getSkill } from './skills.js';
import { CITY, geocode, inServiceArea, haversineKm, etaMinutes } from './geo.js';
import { RATING_TAGS, enforce } from './reliability.js';
import { HttpError, clock, id, token, iso, toCents, parseTime, NO_SUPPLY_IT } from './util.js';

export const BASE_URL = () => process.env.ARONICA_PUBLIC_URL ?? `http://localhost:${process.env.PORT || 8787}`;

export const ACTIVE = ['assigned', 'en_route', 'on_site'];
export const OPEN = ['negotiating', 'pending_confirmation', 'dispatching', ...ACTIVE];

export const STATUS_IT = {
  negotiating: 'Negoziazione in corso',
  pending_confirmation: 'In attesa di conferma',
  dispatching: 'Cerco la persona giusta…',
  assigned: 'Assegnato',
  en_route: 'In viaggio',
  on_site: 'Sul posto',
  done: 'Fatto',
  no_match: 'Nessuna persona disponibile',
  expired: 'Scaduto',
  cancelled: 'Annullato',
};

function failClosed(code, detail, extra = {}) {
  return new HttpError(422, code, NO_SUPPLY_IT, { detail, ...extra });
}

function asList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v).split(/\n+/).map((s) => s.replace(/^[-•*\d.)\s]+/, '').trim()).filter(Boolean);
}

export function resolveLocation(input) {
  const loc = input.location ?? input;
  let lat = loc.lat != null ? Number(loc.lat) : null;
  let lng = loc.lng != null ? Number(loc.lng) : null;
  const address = loc.address ?? input.address ?? null;
  let matched = null;
  if ((lat == null || lng == null) && address) {
    const g = geocode(address);
    if (g) { lat = g.lat; lng = g.lng; matched = g.matched; }
  }
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) {
    throw new HttpError(400, 'location_required',
      'Provide location.lat/lng, or an address containing a known Milano place (see GET /v1/skills → places).');
  }
  return { lat, lng, address: address ?? matched ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`, matched };
}

export function buildProofReq(skill, proof = {}) {
  const d = skill.default_proof;
  const extra = (proof.checklist ?? []).map((c, i) => (typeof c === 'string'
    ? { id: `extra_${i + 1}`, q: c, type: 'text', required: true }
    : { id: c.id ?? `extra_${i + 1}`, q: c.q ?? c.question, type: c.type ?? 'text', required: c.required ?? true }));
  return {
    photos_min: Math.max(d.photos_min, Number(proof.photos_min ?? 0)),
    gps_required: true,
    gps_radius_m: Math.min(d.gps_radius_m, Number(proof.gps_radius_m ?? d.gps_radius_m)),
    timestamp_required: true,
    checklist: [...d.checklist, ...extra],
    notes: proof.notes ?? null,
  };
}

// ---- intake -------------------------------------------------------------
export function createJob(account, input) {
  const city = String(input.city ?? CITY.code).toLowerCase();
  if (city !== CITY.code) throw failClosed('unsupported_city', `Aronica v1 operates only in Milano (got "${input.city}").`);

  const title = String(input.title ?? '').trim();
  const description = String(input.description ?? '').trim();
  if (!title && !description) throw new HttpError(400, 'title_required', 'Provide a title and/or description.');
  const instructions = asList(input.instructions);

  let skill;
  let classification = null;
  if (input.skill) {
    skill = getSkill(String(input.skill));
    if (!skill) throw failClosed('unsupported_skill', `Skill "${input.skill}" does not exist in the Aronica database.`);
  } else {
    classification = classify([title, description, ...instructions].join(' \n '));
    if (!classification || !classification.skill) {
      const why = classification?.out_of_scope?.length
        ? `Out of scope for Aronica v1: ${classification.out_of_scope.join(', ')}. We only do structured field proof.`
        : 'No matching skill in the Aronica database for this request.';
      emit('job.unsupported', { actor: account.name, data: { title, description, reason: why } });
      throw failClosed('unsupported_task', why);
    }
    skill = getSkill(classification.skill);
  }

  const loc = resolveLocation(input);
  if (!inServiceArea(loc)) throw failClosed('outside_service_area', `Location is outside the Milano service area (${CITY.radius_km} km from Duomo).`);

  const now = clock.now();
  let deadline = parseTime(input.deadline ?? input.deadline_at, null);
  if (deadline == null && input.deadline_minutes != null) deadline = now + Number(input.deadline_minutes) * 60000;
  if (deadline == null) deadline = now + Math.max(120, skill.typical_minutes * 3) * 60000;
  if (deadline < now + 15 * 60000) throw new HttpError(400, 'deadline_too_soon', 'Deadline must be at least 15 minutes from now.');

  const target = toCents(input.budget?.target_eur ?? input.budget_target_eur, input.budget?.target_cents ?? input.budget_target_cents);
  const max = toCents(input.budget?.max_eur ?? input.budget_max_eur, input.budget?.max_cents ?? input.budget_max_cents);
  if (target != null && max != null && target > max) throw new HttpError(400, 'invalid_budget', 'budget target must be ≤ max');

  const job = {
    id: id('job'),
    account_id: account.id,
    agent_name: String(input.agent_name ?? account.name).slice(0, 80),
    city,
    skill: skill.code,
    title: (title || description).slice(0, 140),
    description: description || null,
    instructions: instructions.length ? instructions : [skill.description],
    proof_req: buildProofReq(skill, input.proof),
    address: loc.address,
    lat: loc.lat,
    lng: loc.lng,
    deadline_at: deadline,
    scheduled_at: parseTime(input.scheduled_at, null),
    mode: null,
    budget_target_cents: target,
    budget_max_cents: max,
    status: 'negotiating',
    status_message: null,
    confirm_token: token(),
    deal: { state: 'open' },
    created_at: now,
    updated_at: now,
  };

  const { eligible, excluded } = rankCandidates(job);
  if (!eligible.length) {
    job.status = 'no_match';
    job.status_message = NO_SUPPLY_IT;
    insert('jobs', job);
    emit('job.no_match', { job_id: job.id, actor: account.name, data: { message: NO_SUPPLY_IT, stage: 'intake', excluded: summarizeExcluded(excluded) } });
    throw new HttpError(409, 'no_supply', NO_SUPPLY_IT, { job_id: job.id, skill: skill.code, excluded: summarizeExcluded(excluded) });
  }
  insert('jobs', job);
  emit('job.created', { job_id: job.id, actor: account.name, data: { skill: skill.code, title: job.title, address: job.address, eligible: eligible.length } });
  return {
    job: serializeJob(get('SELECT * FROM jobs WHERE id = ?', job.id), { buyer: true }),
    classification,
    match: {
      eligible_workers: eligible.length,
      top: eligible.slice(0, 5).map(publicCandidate),
      excluded: summarizeExcluded(excluded),
    },
    next: 'Negotiate price with supplier agents: negotiate(job_id, offer_eur) or auto_negotiate(job_id). Then accept_quote(quote_id) and send confirm_url to your human.',
  };
}

export function summarizeExcluded(excluded) {
  const counts = {};
  for (const e of excluded) for (const r of e.reasons) counts[r] = (counts[r] ?? 0) + 1;
  return counts;
}

// ---- serialization -------------------------------------------------------
export function publicWorker(w, job = null) {
  if (!w) return null;
  const out = {
    worker_ref: w.id,
    alias: w.display_name,
    kind: w.kind,
    verified: !!w.verified,
    vehicle: w.vehicle,
    zone: w.zone,
    avatar_color: w.avatar_color,
    jobs_completed: w.jobs_completed,
    position: { lat: w.lat, lng: w.lng },
  };
  const r = get('SELECT AVG(stars) AS a, COUNT(*) AS c FROM (SELECT stars FROM ratings WHERE worker_id = ? AND excluded = 0 ORDER BY created_at DESC LIMIT 100)', w.id);
  out.rating = r.c ? Math.round(r.a * 100) / 100 : null;
  out.rating_count = r.c;
  if (job) {
    out.distance_km = Math.round(haversineKm(w, job) * 100) / 100;
    out.eta_min = job.status === 'on_site' ? 0 : etaMinutes(w, job, w.vehicle);
  }
  return out;
}

export function confirmUrl(job) {
  return `${BASE_URL()}/buyer#/job/${job.id}?t=${job.confirm_token}`;
}

export function serializeJob(job, { buyer = false, events = false } = {}) {
  if (!job) return null;
  const skill = getSkill(job.skill);
  const worker = job.assigned_worker_id ? get('SELECT * FROM workers WHERE id = ?', job.assigned_worker_id) : null;
  const deal = job.deal && job.deal.state === 'locked'
    ? { ...job.deal, pool: undefined, participants: undefined, locked_at: iso(job.deal.locked_at), valid_until: iso(job.deal.valid_until) }
    : job.deal ? { state: job.deal.state } : null;
  const out = {
    id: job.id,
    status: job.status,
    status_label: STATUS_IT[job.status] ?? job.status,
    status_message: job.status_message,
    city: job.city,
    skill: job.skill,
    skill_name: skill?.name_it,
    title: job.title,
    description: job.description,
    instructions: job.instructions,
    proof_requirements: job.proof_req,
    location: { address: job.address, lat: job.lat, lng: job.lng },
    deadline_at: iso(job.deadline_at),
    scheduled_at: iso(job.scheduled_at),
    mode: job.mode,
    budget: { target_cents: job.budget_target_cents, max_cents: job.budget_max_cents, currency: 'EUR' },
    negotiation_round: job.negotiation_round,
    deal,
    escrow: job.escrow ? { ...job.escrow } : null,
    worker: worker ? publicWorker(worker, job) : null,
    assigned_via: job.assigned_via,
    proof: job.proof,
    buyer_rating: job.buyer_rating,
    agent_name: job.agent_name,
    created_at: iso(job.created_at),
    updated_at: iso(job.updated_at),
    assigned_at: iso(job.assigned_at),
    started_at: iso(job.started_at),
    arrived_at: iso(job.arrived_at),
    completed_at: iso(job.completed_at),
    cancelled_at: iso(job.cancelled_at),
  };
  if (buyer) out.confirm_url = confirmUrl(job);
  if (job.status === 'dispatching') {
    const o = get("SELECT * FROM offers WHERE job_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1", job.id);
    const tried = get('SELECT COUNT(*) AS c FROM offers WHERE job_id = ?', job.id).c;
    out.dispatch = {
      pool_size: job.dispatch_pool?.length ?? 0,
      tried,
      current_offer: o ? { rank: o.rank, expires_at: iso(o.expires_at) } : null,
    };
  }
  if (events) out.events = eventsForJob(job.id, 0, 300);
  return out;
}

export function loadJob(jobId) {
  const job = get('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) throw new HttpError(404, 'job_not_found', 'Job not found');
  return job;
}

export function listJobsForAccount(accountId, limit = 50) {
  return all('SELECT * FROM jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT ?', accountId, limit).map((j) => serializeJob(j));
}

// ---- buyer rating (two-way ratings; see reliability.js) --------------------
export function rateWorker(jobId, { stars, tags = [], comment = null }) {
  const job = loadJob(jobId);
  if (job.status !== 'done') throw new HttpError(409, 'not_done', 'You can rate only completed jobs.');
  if (job.buyer_rating) throw new HttpError(409, 'already_rated', 'This job was already rated.');
  const s = Number(stars);
  if (!Number.isInteger(s) || s < 1 || s > 5) throw new HttpError(400, 'invalid_stars', 'stars must be an integer 1..5');
  const clean = (Array.isArray(tags) ? tags : []).filter((t) => RATING_TAGS[t]);
  const excluded = clean.some((t) => RATING_TAGS[t].excluded) && s <= 3 ? 1 : 0;
  insert('ratings', { id: id('r'), job_id: jobId, worker_id: job.assigned_worker_id, stars: s, tags: clean, comment: comment ? String(comment).slice(0, 500) : null, excluded, created_at: clock.now() });
  update('jobs', jobId, { buyer_rating: s, updated_at: clock.now() });
  emit('rating.created', { job_id: jobId, worker_id: job.assigned_worker_id, actor: 'buyer', data: { stars: s, tags: clean, excluded: !!excluded } });
  const ev = enforce(job.assigned_worker_id);
  return { ok: true, stars: s, tags: clean, excluded_from_average: !!excluded, worker_tier: ev?.tier };
}
