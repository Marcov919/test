// Uber-style matching: hard eligibility filters, then a weighted score where
// ETA dominates, quality (rating, completion) comes next, acceptance barely
// counts. Every candidate carries its score breakdown so agents and ops can
// see *why* someone ranks where they do.
import { all, get } from './db.js';
import { haversineKm, etaMinutes } from './geo.js';
import { ratingStats, metrics, THRESHOLDS } from './reliability.js';
import { clamp, round50, clock } from './util.js';
import { getSkill } from './skills.js';

export const MAX_RADIUS_KM = 12;

export const WEIGHTS = {
  eta: 0.35,
  rating: 0.25,
  completion: 0.15,
  experience: 0.1,
  price: 0.1,
  acceptance: 0.05,
};
const WARNING_PENALTY = 12; // points off a 0-100 score

// What this worker's supplier agent will never go below for this job.
export function supplierFloor(worker, job, skill, distanceKm) {
  const minsToDeadline = (job.deadline_at - clock.now()) / 60000;
  const urgent = job.mode !== 'schedule';
  const urgency = !urgent ? 1 : minsToDeadline < 60 ? 1.35 : minsToDeadline < 180 ? 1.15 : 1;
  const distance = 1 + Math.max(0, distanceKm - 2) * 0.04;
  return round50(skill.base_price_cents * worker.rate_multiplier * urgency * distance);
}

export function activeJobCount(workerId) {
  return get(
    "SELECT COUNT(*) AS c FROM jobs WHERE assigned_worker_id = ? AND status IN ('assigned','en_route','on_site')",
    workerId,
  ).c;
}

export function scoreWorker(worker, job, skill) {
  const here = { lat: worker.lat, lng: worker.lng };
  const there = { lat: job.lat, lng: job.lng };
  const distance_km = haversineKm(here, there);
  const eta_min = etaMinutes(here, there, worker.vehicle);
  const r = ratingStats(worker.id);
  const m = metrics(worker);
  const floor = supplierFloor(worker, job, skill, distance_km);
  const expJobs = worker.skill_jobs?.[skill.code] ?? 0;

  const parts = {
    eta: 1 - clamp(eta_min / 60),
    rating: clamp((r.bayes_avg - 4.0) / 1.0),
    completion: clamp((m.completion - 0.7) / 0.3),
    experience: clamp(Math.log10(1 + expJobs) / 2),
    price: job.budget_max_cents ? clamp(1 - floor / job.budget_max_cents + 0.5) : 0.5,
    acceptance: m.acceptance,
  };
  let score = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) score += parts[k] * w * 100;
  if (worker.tier === 'warning') score -= WARNING_PENALTY;
  return {
    score: Math.round(score * 10) / 10,
    breakdown: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    distance_km: Math.round(distance_km * 100) / 100,
    eta_min,
    floor_cents: floor,
    rating: Math.round(r.bayes_avg * 100) / 100,
    rating_raw: r.raw_avg == null ? null : Math.round(r.raw_avg * 100) / 100,
    rating_count: r.total_count,
    completion: Math.round(m.completion * 1000) / 1000,
    acceptance: Math.round(m.acceptance * 1000) / 1000,
    experience_jobs: expJobs,
    active_jobs: m.active_jobs,
  };
}

// Returns { eligible: [...ranked], excluded: [{worker_id, reasons}] }
export function rankCandidates(job, { excludeIds = [] } = {}) {
  const skill = getSkill(job.skill);
  if (!skill) return { eligible: [], excluded: [], skill: null };
  const now = clock.now();
  const eligible = [];
  const excluded = [];
  for (const w of all('SELECT * FROM workers WHERE city = ?', job.city)) {
    const reasons = [];
    if (excludeIds.includes(w.id)) reasons.push('already_tried');
    if (w.status === 'suspended') reasons.push('suspended');
    if (w.status === 'pending_verification' || !w.verified) reasons.push('not_verified');
    if (!w.online) reasons.push('offline');
    if (!w.skills.includes(job.skill)) reasons.push('missing_skill');
    const s = scoreWorker(w, job, skill);
    if (s.active_jobs >= w.capacity) reasons.push('busy');
    if (s.distance_km > MAX_RADIUS_KM) reasons.push('too_far');
    if (job.mode !== 'schedule' && now + s.eta_min * 60000 > job.deadline_at) reasons.push('cannot_meet_deadline');
    if (job.budget_max_cents && s.floor_cents > job.budget_max_cents) reasons.push('above_budget');
    if (w.tier === 'warning' && (job.budget_max_cents ?? 0) > THRESHOLDS.high_value_cents) reasons.push('warning_tier_high_value');
    if (reasons.length) excluded.push({ worker_id: w.id, reasons });
    else eligible.push({ worker: w, ...s });
  }
  eligible.sort((a, b) => b.score - a.score || a.eta_min - b.eta_min);
  eligible.forEach((c, i) => { c.rank = i + 1; });
  return { eligible, excluded, skill };
}

// Public, privacy-safe view of a candidate (what agents see).
export function publicCandidate(c) {
  const w = c.worker;
  return {
    worker_ref: w.id,
    alias: w.display_name,
    kind: w.kind,
    verified: !!w.verified,
    tier: w.tier,
    vehicle: w.vehicle,
    zone: w.zone,
    rank: c.rank,
    score: c.score,
    score_breakdown: c.breakdown,
    eta_min: c.eta_min,
    distance_km: c.distance_km,
    rating: c.rating,
    rating_count: c.rating_count,
    completion_rate: c.completion,
    jobs_in_skill: c.experience_jobs,
  };
}
