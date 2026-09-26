// Matching v2: scheduled work. A partner is eligible if they are verified and
// active, do the service, are near enough, accept the pay rate, and are *free*
// for the slot (weekly availability minus overlapping assignments, times crew
// capacity for businesses). Score is Uber-style and explainable.
import { all, get } from './db.js';
import { haversineKm, etaMinutes } from './geo.js';
import { ratingStats, metrics, THRESHOLDS } from './reliability.js';
import { getService } from './services.js';
import { romeParts, minutesOfDay } from './time.js';
import { clamp, clock } from './util.js';

export const MAX_RADIUS_KM = 18;

// Concentration limit: on shifts of 4+ people no single supplier covers more
// than half the seats, so one no-show (e.g. an agency) can't sink the shift.
export function maxSeatsPerSupplier(headcount) {
  return headcount >= 4 ? Math.ceil(headcount / 2) : headcount;
}
// Kept deliberately simple and explainable (shown in Ops and to agents).
export const WEIGHTS = { proximity: 0.3, rating: 0.25, reliability: 0.2, service_fit: 0.15, acceptance: 0.1 };
export const WEIGHT_LABELS_IT = { proximity: 'Vicinanza', rating: 'Valutazione', reliability: 'Affidabilità (completamento, no-show)', service_fit: 'Esperienza nel servizio', acceptance: 'Accettazione offerte' };
const WARNING_PENALTY = 12;
const STEP = 30 * 60000;

// Crew already committed by this worker in [start, end).
export async function busyLoad(workerId, start, end, ignoreJobId = null) {
  const rows = await all(
    `SELECT a.crew, j.slot_start, j.duration_min FROM assignments a JOIN jobs j ON j.id = a.job_id
     WHERE a.worker_id = ? AND a.status IN ('assigned','en_route','on_site') AND j.id != ?`, workerId, ignoreJobId ?? '',
  );
  return rows.filter((r) => r.slot_start < end && r.slot_start + r.duration_min * 60000 > start).reduce((a, r) => a + r.crew, 0);
}

export async function activeLoadNow(workerId) {
  return (await get("SELECT COALESCE(SUM(crew),0) AS c FROM assignments WHERE worker_id = ? AND status IN ('en_route','on_site')", workerId)).c;
}

function inAvailability(w, start, minutes) {
  const p = romeParts(start);
  const from = minutesOfDay(start);
  const to = from + minutes;
  return (w.availability?.[p.dow] ?? []).some(([a, b]) => from >= a && to <= b);
}

export async function freeCapacity(w, start, minutes, ignoreJobId = null) {
  if (!inAvailability(w, start, minutes)) return 0;
  return Math.max(0, w.capacity - await busyLoad(w.id, start, start + minutes * 60000, ignoreJobId));
}

// Earliest feasible start in [from, to] (start times on a 30-minute grid).
export async function earliestStart(w, from, to, minutes, earliestPossible, ignoreJobId = null) {
  const grid = 15 * 60000;
  let t = Math.ceil(Math.max(from, earliestPossible) / grid) * grid;
  for (let i = 0; i < 400 && t <= to; i++, t += STEP) {
    if (await freeCapacity(w, t, minutes, ignoreJobId) > 0) return t;
  }
  return null;
}

export async function scoreWorker(w, job, start) {
  const distance_km = haversineKm(w, job);
  const eta_min = etaMinutes(w, job, w.vehicle);
  const r = await ratingStats(w.id);
  const m = await metrics(w);
  const exp = w.skill_jobs?.[job.service] ?? 0;
  const parts = {
    proximity: 1 - clamp(distance_km / MAX_RADIUS_KM),
    rating: clamp((r.bayes_avg - 4.0) / 1.0),
    reliability: clamp((m.completion - 0.7) / 0.3) * (1 - clamp(w.no_shows / 3)),
    service_fit: clamp(Math.log10(1 + exp) / 2.5),
    acceptance: m.acceptance,
  };
  let score = 0;
  for (const [k, wt] of Object.entries(WEIGHTS)) score += parts[k] * wt * 100;
  if (w.tier === 'warning') score -= WARNING_PENALTY;
  return {
    score: Math.round(score * 10) / 10,
    breakdown: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    distance_km: Math.round(distance_km * 10) / 10,
    eta_min,
    rating: Math.round(r.bayes_avg * 100) / 100,
    rating_count: r.total_count,
    completion: Math.round(m.completion * 1000) / 1000,
    experience_jobs: exp,
  };
}

// job needs: service, lat, lng, window_start, window_end, duration_min, price (quote), flexible
// opts.slotStart: only partners free at exactly that start.
// opts.explain: ignore this job's own assignments (Ops "why this ranking" view).
export async function rankCandidates(job, { slotStart = null, excludeIds = [], explain = false } = {}) {
  const ignore = explain ? job.id : null;
  const service = getService(job.service);
  if (!service) return { eligible: [], excluded: [], service: null };
  const now = clock.now();
  const minutes = job.duration_min;
  const seatPay = job.price?.seat_payout_cents ?? 0;
  const perHour = seatPay / Math.max(0.5, minutes / 60);
  const immediate = (slotStart ?? job.window_start) - now < 2 * 3600000;
  const eligible = [];
  const excluded = [];
  for (const w of await all('SELECT * FROM workers WHERE city = ?', job.city ?? 'milano')) {
    const reasons = [];
    if (excludeIds.includes(w.id)) reasons.push('already_tried');
    if (w.status === 'suspended') reasons.push('suspended');
    if (w.status === 'pending_verification' || !w.verified) reasons.push('not_verified');
    if (!w.skills.includes(job.service)) reasons.push('missing_service');
    const distance = haversineKm(w, job);
    if (distance > MAX_RADIUS_KM) reasons.push('too_far');
    if (perHour < w.min_hourly_cents) reasons.push('pay_below_partner_minimum');
    if (immediate && !w.online) reasons.push('offline');
    if (w.tier === 'warning' && (job.price?.total_cents ?? 0) > THRESHOLDS.high_value_cents) reasons.push('warning_tier_high_value');
    let start = null;
    let capacity = 0;
    if (!reasons.length) {
      const eta = Math.round(haversineKm(w, job) * 1.3 / 14 * 60) + 10;
      if (slotStart != null) {
        capacity = await freeCapacity(w, slotStart, minutes, ignore);
        // A replacement may arrive late, but only within the first half of the job.
        const arrive = Math.max(slotStart, now + eta * 60000);
        start = capacity > 0 && arrive <= slotStart + (minutes * 60000) / 2 ? slotStart : null;
      } else {
        const last = job.flexible ? job.window_end - minutes * 60000 : job.window_start;
        start = await earliestStart(w, job.window_start, last, minutes, explain ? job.window_start : now + eta * 60000, ignore);
        if (start != null) capacity = await freeCapacity(w, start, minutes, ignore);
      }
      if (start == null) reasons.push('not_available');
    }
    if (reasons.length) { excluded.push({ worker_id: w.id, reasons }); continue; }
    eligible.push({ worker: w, start, capacity_free: capacity, ...(await scoreWorker(w, job, start)) });
  }
  for (const c of eligible) c.service_code = job.service;
  eligible.sort((a, b) => b.score - a.score || a.start - b.start);
  eligible.forEach((c, i) => { c.rank = i + 1; });
  return { eligible, excluded, service };
}

// Next availability after the window (for supplier counter-proposals).
export async function nextAvailability(w, job, horizonDays = 7) {
  const from = job.window_end;
  return await earliestStart(w, from, from + horizonDays * 86400000, job.duration_min, clock.now() + 3600000);
}

export function publicCandidate(c) {
  const w = c.worker;
  return {
    worker_ref: w.id,
    alias: w.display_name,
    kind: w.kind,
    crew_available: w.kind === 'business' ? c.capacity_free : 1,
    verified: !!w.verified,
    insured: !!w.insured,
    tier: w.tier,
    zone: w.zone,
    rank: c.rank,
    score: c.score,
    score_breakdown: c.breakdown,
    earliest_start: c.start ? new Date(c.start).toISOString() : null,
    distance_km: c.distance_km,
    rating: c.rating,
    rating_count: c.rating_count,
    completion_rate: c.completion,
    jobs_in_service: c.experience_jobs,
    how: w.service_notes?.[c.service_code] ?? null,
  };
}
