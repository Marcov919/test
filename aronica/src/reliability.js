// Worker reliability, modelled on how Uber manages driver quality:
//  - Two-way star ratings; the worker's rating is the average of the LAST N rated
//    jobs (Uber: last 500 trips; we use 100 at our volume).
//  - Ratings for problems outside the worker's control are excluded
//    (Uber drops ratings attributed to app/traffic issues).
//  - New workers get a Bayesian prior so 1 bad review doesn't bury them and
//    1 good review doesn't put them on top.
//  - Acceptance rate barely matters (Uber stopped deactivating on it); what
//    matters is completion / cancellation after accepting, and no-shows.
//  - Below-threshold workers first get a WARNING (visible in the app, ranked
//    lower, kept off high-value jobs), then are SUSPENDED (removed from matching)
//    with the reasons listed; ops can reinstate after review.
import { all, get, update } from './db.js';
import { emit } from './events.js';

export const RATING_WINDOW = 100;
export const PRIOR_MEAN = 4.7;
export const PRIOR_WEIGHT = 5;

export const THRESHOLDS = {
  warn_rating: 4.6,
  suspend_rating: 4.4,
  min_ratings_for_rating_rules: 5,
  min_ratings_for_suspension: 10,
  warn_completion: 0.9,
  suspend_completion: 0.8,
  min_jobs_for_completion_rules: 5,
  min_jobs_for_suspension: 10,
  warn_cancel_rate: 0.05,
  suspend_no_shows: 3,
  high_value_cents: 5000, // warning-tier workers don't get jobs above this
};

// Tags a buyer can attach to a rating. `excluded` = not the worker's fault.
export const RATING_TAGS = {
  foto_nitide: { label_it: 'Foto nitide', positive: true },
  puntuale: { label_it: 'Puntuale', positive: true },
  prova_completa: { label_it: 'Prova completa', positive: true },
  oltre_le_attese: { label_it: 'Oltre le attese', positive: true },
  foto_sfocate: { label_it: 'Foto sfocate', positive: false },
  in_ritardo: { label_it: 'In ritardo', positive: false },
  prova_incompleta: { label_it: 'Prova incompleta', positive: false },
  posto_sbagliato: { label_it: 'Posto sbagliato', positive: false },
  istruzioni_mie_poco_chiare: { label_it: 'Le mie istruzioni erano poco chiare', positive: false, excluded: true },
  luogo_chiuso_o_inaccessibile: { label_it: 'Luogo chiuso / inaccessibile', positive: false, excluded: true },
};

export function ratingStats(workerId) {
  const rows = all(
    'SELECT stars FROM ratings WHERE worker_id = ? AND excluded = 0 ORDER BY created_at DESC LIMIT ?',
    workerId, RATING_WINDOW,
  );
  const n = rows.length;
  const sum = rows.reduce((a, r) => a + r.stars, 0);
  const raw = n ? sum / n : null;
  const bayes = (PRIOR_MEAN * PRIOR_WEIGHT + sum) / (PRIOR_WEIGHT + n);
  const total = get('SELECT COUNT(*) AS c FROM ratings WHERE worker_id = ?', workerId).c;
  return { count: n, total_count: total, raw_avg: raw, bayes_avg: bayes, window: RATING_WINDOW };
}

export function metrics(w) {
  const active = get(
    "SELECT COUNT(*) AS c FROM jobs WHERE assigned_worker_id = ? AND status IN ('assigned','en_route','on_site')", w.id,
  ).c;
  const closed = Math.max(0, w.jobs_accepted - active);
  const completion = closed ? w.jobs_completed / closed : 1;
  const cancel_rate = w.jobs_accepted ? (w.jobs_cancelled + w.no_shows) / w.jobs_accepted : 0;
  const acceptance = w.offers_received ? w.offers_accepted / w.offers_received : 1;
  return { completion, cancel_rate, acceptance, active_jobs: active, closed_jobs: closed };
}

export function evaluate(w) {
  const r = ratingStats(w.id);
  const m = metrics(w);
  const T = THRESHOLDS;
  const suspend = [];
  const warn = [];
  if (r.count >= T.min_ratings_for_suspension && r.raw_avg < T.suspend_rating)
    suspend.push(`Valutazione media ${r.raw_avg.toFixed(2)} sotto ${T.suspend_rating} (ultimi ${r.count} lavori)`);
  else if (r.count >= T.min_ratings_for_rating_rules && r.raw_avg < T.warn_rating)
    warn.push(`Valutazione media ${r.raw_avg.toFixed(2)} sotto ${T.warn_rating}`);
  if (m.closed_jobs >= T.min_jobs_for_suspension && m.completion < T.suspend_completion)
    suspend.push(`Tasso di completamento ${(m.completion * 100).toFixed(0)}% sotto ${T.suspend_completion * 100}%`);
  else if (m.closed_jobs >= T.min_jobs_for_completion_rules && m.completion < T.warn_completion)
    warn.push(`Tasso di completamento ${(m.completion * 100).toFixed(0)}% sotto ${T.warn_completion * 100}%`);
  if (w.no_shows >= T.suspend_no_shows) suspend.push(`${w.no_shows} mancate presenze`);
  else if (w.jobs_accepted >= 5 && m.cancel_rate > T.warn_cancel_rate)
    warn.push(`Tasso di cancellazione ${(m.cancel_rate * 100).toFixed(1)}% sopra ${T.warn_cancel_rate * 100}%`);
  const tier = suspend.length ? 'suspended' : warn.length ? 'warning' : 'good';
  return { tier, reasons: suspend.length ? suspend : warn, rating: r, metrics: m };
}

// Re-evaluate after any reliability-relevant event and enforce the outcome.
export function enforce(workerId) {
  const w = get('SELECT * FROM workers WHERE id = ?', workerId);
  if (!w) return null;
  const ev = evaluate(w);
  const patch = {};
  if (ev.tier !== w.tier || JSON.stringify(ev.reasons) !== JSON.stringify(w.tier_reasons)) {
    patch.tier = ev.tier;
    patch.tier_reasons = ev.reasons;
  }
  if (ev.tier === 'suspended' && w.status === 'active') {
    patch.status = 'suspended';
    patch.online = 0;
  }
  if (Object.keys(patch).length) {
    update('workers', w.id, patch);
    if (patch.tier && patch.tier !== w.tier) {
      emit('worker.tier_changed', { worker_id: w.id, data: { from: w.tier, to: ev.tier, reasons: ev.reasons } });
    }
  }
  return ev;
}
