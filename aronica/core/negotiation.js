// A2A negotiation v2 — on WHEN, not on price.
// The price is fixed by the platform. The buyer agent proposes a time window;
// each supplier agent (one per top-ranked partner, server-side in v1) checks its
// partner's calendar and replies: accept (with a start time), counter (another
// slot outside the window), or decline (booked / pay below the partner's
// minimum). The chosen quote locks the slot; approval is a human tap or, for
// business accounts, an automatic policy.
import { get, insert, update, all, run, tx, lockRow } from './db.js';
import { emit } from './events.js';
import { rankCandidates, nextAvailability, freeCapacity, maxSeatsPerSupplier } from './matching.js';
import { getService } from './services.js';
import { quote as priceQuote } from './pricing.js';
import { haversineKm } from './geo.js';
import { slotLabel, durationLabel } from './time.js';
import { confirmJob } from './dispatch.js';
import { HttpError, clock, id, eur, sleep, NO_SUPPLY_IT } from './util.js';

export const MAX_ROUNDS = 6;
const LOCK_MS = 60_000;

function delay() {
  const base = Number(process.env.ARONICA_NEG_DELAY_MS ?? 800);
  return base ? base * (0.5 + Math.random()) : 0;
}

async function participants(job) {
  const { eligible } = await rankCandidates(job);
  const k = job.headcount > 1 ? Math.min(12, job.headcount * 2 + 2) : 5;
  const list = eligible.slice(0, k);
  if (list.length < k) {
    // Also ask capable partners who are busy in the window: they may counter.
    const ids = new Set(list.map((c) => c.worker.id));
    const perHour = job.price.seat_payout_cents / Math.max(0.5, job.duration_min / 60);
    const extra = (await all("SELECT * FROM workers WHERE status = 'active' AND verified = 1"))
      .filter((w) => !ids.has(w.id) && w.skills.includes(job.service) && haversineKm(w, job) <= 18)
      .map((w) => ({ worker: w, start: null, capacity_free: 0, score: 0, busy: true, underpaid: perHour < w.min_hourly_cents }))
      .slice(0, k - list.length);
    list.push(...extra);
  }
  return list;
}

function acceptLine(service, job, c, seats) {
  const when = slotLabel(c.start, job.duration_min);
  if (job.headcount > 1) {
    return c.worker.kind === 'business'
      ? `Copro ${seats} ${seats === 1 ? 'posto' : 'posti'} su ${job.headcount} con la mia squadra, ${when}.`
      : `Disponibile per il turno ${when}.`;
  }
  const crew = c.worker.kind === 'business' && !c.worker.service_notes?.[job.service] ? ' con la squadra' : '';
  const how = c.worker.service_notes?.[job.service];
  return `Ci sono ${when}${crew}. ${how ? `${how} ` : ''}Durata stimata ${durationLabel(job.duration_min)}.`;
}

export async function supplierReply(job, service, c) {
  if (c.underpaid) {
    return { action: 'decline', slot_start: null, seats: 0, message: `Il compenso è sotto la mia tariffa minima (${eur(c.worker.min_hourly_cents)}/h).` };
  }
  if (!c.busy && c.start) {
    const seats = job.headcount > 1 ? Math.min(maxSeatsPerSupplier(job.headcount), c.worker.kind === 'business' ? c.capacity_free : 1) : 1;
    return { action: 'accept', slot_start: c.start, seats, message: acceptLine(service, job, c, seats) };
  }
  const next = await nextAvailability(c.worker, job);
  if (next) {
    return { action: 'counter', slot_start: next, seats: 1, message: `In quella fascia sono pieno. Posso ${slotLabel(next, job.duration_min)}.` };
  }
  return { action: 'decline', slot_start: null, seats: 0, message: 'Non ho disponibilità nei prossimi 7 giorni.' };
}

export async function negotiateRound(jobId, { windows = null, actor = 'buyer_agent', message = null } = {}) {
  let job = await get('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) throw new HttpError(404, 'job_not_found', 'Job not found');
  if (job.status !== 'scheduling') throw new HttpError(409, 'not_scheduling', `Job is ${job.status}; negotiation is closed.`);
  const round = job.negotiation_round + 1;
  if (round > MAX_ROUNDS) throw new HttpError(409, 'too_many_rounds', `Max ${MAX_ROUNDS} rounds. Accept a quote or cancel.`);
  const service = getService(job.service);
  if (windows?.length) {
    const w = windows[0];
    const s = Date.parse(w.start);
    const e = w.end ? Date.parse(w.end) : s + job.duration_min * 60000;
    if (Number.isNaN(s) || e <= s) throw new HttpError(400, 'invalid_window', 'windows[0] needs valid start/end');
    const minutes = service.flexible ? job.duration_min : Math.round((e - s) / 60000);
    const price = priceQuote(service, job.params, { start: s, minutes, now: clock.now() });
    await update('jobs', jobId, { window_start: s, window_end: Math.max(e, s + minutes * 60000), flexible: service.flexible && e - s > minutes * 60000 ? 1 : 0, duration_min: price.minutes, price });
    job = await get('SELECT * FROM jobs WHERE id = ?', jobId);
  }
  const parts = await participants(job);
  if (!parts.length) throw new HttpError(409, 'no_supply', NO_SUPPLY_IT, { job_id: jobId });
  // One round at a time per job, across server instances (compare-and-set lock).
  const got = await run('UPDATE jobs SET negotiating_until = ? WHERE id = ? AND (negotiating_until IS NULL OR negotiating_until < ?)', Date.now() + LOCK_MS, jobId, Date.now());
  if (!got) throw new HttpError(409, 'round_in_progress', 'A negotiation round is already running for this job.');
  try {
    const windowLabel = job.flexible ? slotLabel(job.window_start, Math.round((job.window_end - job.window_start) / 60000)) : slotLabel(job.window_start, job.duration_min);
    if (round === 1) {
      await emit('negotiation.started', { job_id: jobId, actor, data: { participants: parts.map((c) => ({ worker_ref: c.worker.id, alias: c.worker.display_name, kind: c.worker.kind, agent: `supplier-agent/${c.worker.id}` })) } });
    }
    await update('jobs', jobId, { negotiation_round: round, updated_at: clock.now() });
    await emit('negotiation.buyer_offer', {
      job_id: jobId, actor,
      data: { round, window: windowLabel, price_cents: job.price.total_cents, headcount: job.headcount, message: message ?? `${service.name_it}${job.headcount > 1 ? ` · ${job.headcount} persone` : ''}, ${windowLabel}. Prezzo fisso ${eur(job.price.total_cents)}. Chi è disponibile?` },
    });
    const responses = await Promise.all(parts.map(async (c) => {
      await sleep(delay());
      const r = await supplierReply(job, service, c);
      const q = { id: id('q'), job_id: jobId, round, worker_id: c.worker.id, action: r.action, slot_start: r.slot_start, seats: r.seats, eta_min: null, message: r.message, created_at: clock.now() };
      await insert('quotes', q);
      const out = {
        quote_id: q.id, worker_ref: c.worker.id, alias: c.worker.display_name, kind: c.worker.kind, agent: `supplier-agent/${c.worker.id}`,
        action: r.action, slot_start: r.slot_start ? new Date(r.slot_start).toISOString() : null,
        slot_label: r.slot_start ? slotLabel(r.slot_start, job.duration_min) : null, seats: r.seats,
        score: c.score, rating: c.rating ?? null, message: r.message,
      };
      await emit('negotiation.supplier_response', { job_id: jobId, worker_id: c.worker.id, actor: out.agent, data: { round, ...out } });
      return out;
    }));
    responses.sort((a, b) => b.score - a.score);
    const accepts = responses.filter((r) => r.action === 'accept');
    const counters = responses.filter((r) => r.action === 'counter').sort((a, b) => Date.parse(a.slot_start) - Date.parse(b.slot_start));
    const covered = Math.min(job.headcount, accepts.reduce((a, r) => a + r.seats, 0));
    return {
      job_id: jobId, round, window: windowLabel, price_cents: job.price.total_cents, headcount: job.headcount,
      seats_available: covered,
      responses,
      best_accept: accepts[0] ?? null,
      earliest_counter: counters[0] ?? null,
      hint: accepts.length
        ? `${covered}/${job.headcount} seat(s) available in the window. accept_quote(${accepts[0].quote_id}) to lock the slot.`
        : counters.length
          ? `Nobody free in the window. Earliest counter-proposal: ${counters[0].slot_label} — accept_quote(${counters[0].quote_id}) or negotiate with another window.`
          : 'No availability. Try another window or cancel.',
    };
  } finally {
    await run('UPDATE jobs SET negotiating_until = NULL WHERE id = ?', jobId);
  }
}

export async function acceptQuote(jobId, quoteId, opts = {}) {
  return tx(async () => { await lockRow('jobs', jobId); return acceptQuoteLocked(jobId, quoteId, opts); });
}

async function acceptQuoteLocked(jobId, quoteId, { actor = 'buyer_agent' } = {}) {
  const job = await get('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) throw new HttpError(404, 'job_not_found', 'Job not found');
  if (job.status !== 'scheduling') throw new HttpError(409, 'not_scheduling', `Job is ${job.status}.`);
  const q = await get('SELECT * FROM quotes WHERE id = ? AND job_id = ?', quoteId, jobId);
  if (!q) throw new HttpError(404, 'quote_not_found', 'Quote not found for this job');
  if (q.action === 'decline') throw new HttpError(409, 'quote_declined', 'That supplier declined; pick another quote.');
  const service = getService(job.service);
  const now = clock.now();
  const slot = q.slot_start;
  const patch = { slot_start: slot, updated_at: now };
  let price = job.price;
  if (slot < job.window_start || slot + job.duration_min * 60000 > job.window_end) {
    // Counter-proposal outside the original window: move the window and re-quote.
    price = priceQuote(service, job.params, { start: slot, minutes: job.duration_min, now });
    Object.assign(patch, { window_start: slot, window_end: slot + job.duration_min * 60000, flexible: 0, price });
  }
  const view = { ...job, ...patch };
  const pool = (await rankCandidates(view, { slotStart: slot })).eligible;
  const quoted = pool.find((c) => c.worker.id === q.worker_id);
  const ordered = quoted ? [quoted, ...pool.filter((c) => c !== quoted)] : pool;
  if (!ordered.length) {
    await update('jobs', jobId, { status: 'no_match', status_message: NO_SUPPLY_IT, updated_at: now });
    await emit('job.no_match', { job_id: jobId, data: { message: NO_SUPPLY_IT, stage: 'deal' } });
    throw new HttpError(409, 'no_supply', NO_SUPPLY_IT, { job_id: jobId });
  }
  const lead = ordered[0];
  const seatsInPool = Math.min(job.headcount, ordered.reduce((a, c) => a + (c.worker.kind === 'business' ? Math.min(c.capacity_free, maxSeatsPerSupplier(job.headcount)) : 1), 0));
  const deal = {
    state: 'locked',
    slot_start: slot,
    slot_label: slotLabel(slot, job.duration_min),
    price_cents: price.total_cents,
    repriced: price !== job.price,
    quote_id: q.id,
    lead: { worker_ref: lead.worker.id, alias: lead.worker.display_name, kind: lead.worker.kind, rating: lead.rating, rating_count: lead.rating_count, score: lead.score, insured: !!lead.worker.insured, how: lead.worker.service_notes?.[job.service] ?? null },
    seats_available: seatsInPool,
    headcount: job.headcount,
    pool: ordered.map((c) => c.worker.id),
    rounds: job.negotiation_round,
    locked_at: now,
  };
  await update('jobs', jobId, { ...patch, deal, status: 'pending_confirmation', status_message: 'In attesa di approvazione', dispatch_pool: deal.pool });
  await emit('negotiation.deal', { job_id: jobId, actor, data: { ...deal, pool: undefined } });

  // Business accounts: auto-approve under the policy threshold (no human tap).
  const account = await get('SELECT * FROM accounts WHERE id = ?', job.account_id);
  const limit = account?.org?.auto_approve_max_cents;
  if (account?.kind === 'business' && limit != null && price.total_cents <= limit) {
    await confirmJob(jobId, { by: 'policy', rule: `Approvazione automatica fino a ${eur(limit)} (policy ${account.org.legal_name ?? account.name})` });
    return { deal, auto_approved: true };
  }
  return { deal, auto_approved: false };
}

// Aronica's built-in buyer agent: take the best partner free in the window;
// otherwise leave the counter-proposals to the human (or the external agent).
export async function autoNegotiate(jobId) {
  const res = await negotiateRound(jobId, { actor: 'Aronica Buyer Agent' });
  if (res.best_accept) {
    const r = await acceptQuote(jobId, res.best_accept.quote_id, { actor: 'Aronica Buyer Agent' });
    return { ...r, round: res };
  }
  const msg = res.earliest_counter
    ? `Nessuno è libero nella fascia richiesta. Prima alternativa: ${res.earliest_counter.slot_label} (${res.earliest_counter.alias}).`
    : NO_SUPPLY_IT;
  await update('jobs', jobId, { status_message: msg, updated_at: clock.now() });
  await emit('negotiation.counters', { job_id: jobId, actor: 'Aronica Buyer Agent', data: { message: msg, counters: res.responses.filter((r) => r.action === 'counter') } });
  return { deal: null, message: msg, counters: res.responses.filter((r) => r.action === 'counter'), round: res };
}

export async function quotesForJob(jobId) {
  return await all('SELECT * FROM quotes WHERE job_id = ? ORDER BY round, created_at', jobId);
}

export { freeCapacity };
