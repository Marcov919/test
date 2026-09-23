// Live A2A negotiation. The Buyer Agent (external Claude/Grok/OpenAI agent, or
// Aronica's built-in buyer agent) exchanges offers with Supplier Agents, one per
// top-ranked worker. Supplier agents run server-side (v1), each with a private
// policy derived from its worker: a price floor (base × worker rate × urgency ×
// distance) and a concession curve. Every step is persisted and streamed.
import { get, insert, update, all } from './db.js';
import { emit } from './events.js';
import { rankCandidates } from './matching.js';
import { getSkill } from './skills.js';
import { VEHICLES } from './geo.js';
import { HttpError, clock, id, round50, eur, sleep, NO_SUPPLY_IT } from './util.js';

export const PARTICIPANTS = 5;
export const MAX_ROUNDS = 8;
export const DEAL_VALID_MS = 10 * 60 * 1000;
export const PLATFORM_FEE = 0.15;

const busy = new Set(); // job ids with a round in flight

function negotiationDelay() {
  const base = Number(process.env.ARONICA_NEG_DELAY_MS ?? 800);
  return base ? base * (0.5 + Math.random()) : 0;
}

export function openingAsk(c) {
  return round50(c.floor_cents * (1.2 + 0.15 * c.breakdown.rating));
}

// Pure supplier-agent policy. Returns { action, price_cents, message }.
export function supplierPolicy(c, skill, buyerOffer, round, lastAsk) {
  const floor = c.floor_cents;
  const ask = lastAsk ?? openingAsk(c);
  const alias = c.worker.display_name;
  const vehicle = VEHICLES[c.worker.vehicle]?.label_it.toLowerCase() ?? c.worker.vehicle;
  const closeEnough = floor + (ask - floor) * 0.3;
  if (buyerOffer >= ask || buyerOffer >= closeEnough || (round >= 3 && buyerOffer >= floor)) {
    return {
      action: 'accept',
      price_cents: buyerOffer,
      message: `Accetto ${eur(buyerOffer)}. Sono a ${c.distance_km.toFixed(1)} km, arrivo in ${c.eta_min} min (${vehicle}).`,
    };
  }
  if (round >= 6) {
    return { action: 'reject', price_cents: floor, message: `Non posso scendere sotto ${eur(floor)}. Passo.` };
  }
  if (lastAsk == null) {
    const low = buyerOffer < floor * 0.7;
    return {
      action: 'counter',
      price_cents: ask,
      message: low
        ? `${eur(buyerOffer)} è troppo basso per ${c.distance_km.toFixed(1)} km. Posso farlo a ${eur(ask)}, arrivo in ${c.eta_min} min.`
        : `Posso esserci in ${c.eta_min} min (${vehicle}). Per ${skill.name_it.toLowerCase()} chiedo ${eur(ask)}.`,
    };
  }
  let next = Math.max(floor, round50(ask - (ask - Math.max(buyerOffer, floor)) * 0.4));
  if (next >= ask && ask > floor) next = Math.max(floor, ask - 50);
  return {
    action: 'counter',
    price_cents: next,
    message: next === floor ? `Ultima offerta: ${eur(next)}.` : `Vengo incontro: ${eur(next)}.`,
  };
}

function lastAskFor(jobId, workerId) {
  const q = get(
    "SELECT price_cents FROM quotes WHERE job_id = ? AND worker_id = ? AND action = 'counter' ORDER BY round DESC LIMIT 1",
    jobId, workerId,
  );
  return q ? q.price_cents : null;
}

function participants(job) {
  const { eligible } = rankCandidates(job);
  const fixed = job.deal?.participants;
  let list = eligible;
  if (fixed?.length) {
    const still = eligible.filter((c) => fixed.includes(c.worker.id));
    // top up if some participants went offline
    list = [...still, ...eligible.filter((c) => !fixed.includes(c.worker.id))];
  }
  return list.slice(0, PARTICIPANTS);
}

export async function negotiateRound(jobId, offerCents, { actor = 'buyer_agent', message = null } = {}) {
  if (busy.has(jobId)) throw new HttpError(409, 'round_in_progress', 'A negotiation round is already running for this job.');
  const job = get('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) throw new HttpError(404, 'job_not_found', 'Job not found');
  if (job.status !== 'negotiating') {
    throw new HttpError(409, 'not_negotiating', `Job is ${job.status}; negotiation is closed.`);
  }
  if (!Number.isFinite(offerCents) || offerCents < 100) throw new HttpError(400, 'invalid_offer', 'offer must be at least €1.00');
  const round = job.negotiation_round + 1;
  if (round > MAX_ROUNDS) throw new HttpError(409, 'too_many_rounds', `Max ${MAX_ROUNDS} rounds. Accept a quote or cancel.`);
  const skill = getSkill(job.skill);
  const parts = participants(job);
  if (!parts.length) {
    throw new HttpError(409, 'no_supply', NO_SUPPLY_IT, { job_id: jobId });
  }
  busy.add(jobId);
  try {
    if (round === 1) {
      update('jobs', jobId, { deal: { state: 'open', participants: parts.map((c) => c.worker.id) } });
      emit('negotiation.started', {
        job_id: jobId, actor,
        data: { participants: parts.map((c) => ({ worker_ref: c.worker.id, alias: c.worker.display_name, agent: `supplier-agent/${c.worker.id}`, score: c.score, eta_min: c.eta_min, rating: c.rating })) },
      });
    }
    update('jobs', jobId, { negotiation_round: round, updated_at: clock.now() });
    emit('negotiation.buyer_offer', { job_id: jobId, actor, data: { round, offer_cents: offerCents, message: message ?? `Offro ${eur(offerCents)}.` } });

    // Supplier agents "think" in parallel and answer as they finish.
    const responses = await Promise.all(parts.map(async (c) => {
      await sleep(negotiationDelay());
      const r = supplierPolicy(c, skill, offerCents, round, lastAskFor(jobId, c.worker.id));
      const quote = {
        id: id('q'), job_id: jobId, round, worker_id: c.worker.id, buyer_offer_cents: offerCents,
        action: r.action, price_cents: r.price_cents, eta_min: c.eta_min, message: r.message, created_at: clock.now(),
      };
      insert('quotes', quote);
      const out = {
        quote_id: quote.id, worker_ref: c.worker.id, alias: c.worker.display_name, agent: `supplier-agent/${c.worker.id}`,
        action: r.action, price_cents: r.price_cents, eta_min: c.eta_min, score: c.score, rating: c.rating, message: r.message,
      };
      emit('negotiation.supplier_response', { job_id: jobId, worker_id: c.worker.id, actor: out.agent, data: { round, ...out } });
      return out;
    }));
    responses.sort((a, b) => b.score - a.score);
    const accepts = responses.filter((r) => r.action === 'accept');
    const counters = responses.filter((r) => r.action === 'counter');
    return {
      job_id: jobId,
      round,
      buyer_offer_cents: offerCents,
      responses,
      best_accept: accepts[0] ?? null,
      lowest_counter: counters.sort((a, b) => a.price_cents - b.price_cents)[0] ?? null,
      hint: accepts.length
        ? `Accepted by ${accepts.length} supplier agent(s). Call accept_quote with quote_id ${accepts[0].quote_id} to lock the deal.`
        : 'No acceptance yet. Raise your offer, or accept a counter via accept_quote.',
    };
  } finally {
    busy.delete(jobId);
  }
}

// Lock a deal from a quote. The deal price becomes the job price; the dispatch
// pool is every eligible worker whose supplier agent would work at that price,
// ranked by match score (offer goes to the highest score first).
export function acceptQuote(jobId, quoteId, { actor = 'buyer_agent' } = {}) {
  const job = get('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) throw new HttpError(404, 'job_not_found', 'Job not found');
  if (job.status !== 'negotiating') throw new HttpError(409, 'not_negotiating', `Job is ${job.status}.`);
  const quote = get('SELECT * FROM quotes WHERE id = ? AND job_id = ?', quoteId, jobId);
  if (!quote) throw new HttpError(404, 'quote_not_found', 'Quote not found for this job');
  if (quote.action === 'reject') throw new HttpError(409, 'quote_rejected', 'That supplier walked away; pick another quote.');
  const price = quote.price_cents;
  if (job.budget_max_cents && price > job.budget_max_cents) {
    throw new HttpError(409, 'over_budget', `Quote ${eur(price)} exceeds your max budget ${eur(job.budget_max_cents)}.`);
  }
  const pool = rankCandidates(job).eligible.filter((c) => c.floor_cents <= price);
  if (!pool.length) {
    update('jobs', jobId, { status: 'no_match', status_message: NO_SUPPLY_IT, updated_at: clock.now() });
    emit('job.no_match', { job_id: jobId, data: { message: NO_SUPPLY_IT, stage: 'deal' } });
    throw new HttpError(409, 'no_supply', NO_SUPPLY_IT, { job_id: jobId });
  }
  const lead = pool[0];
  const fee = Math.round(price * PLATFORM_FEE);
  const deal = {
    state: 'locked',
    price_cents: price,
    platform_fee_cents: fee,
    worker_payout_cents: price - fee,
    currency: 'EUR',
    quote_id: quote.id,
    quoted_by: quote.worker_id,
    rounds: job.negotiation_round,
    eta_min: lead.eta_min,
    lead: { worker_ref: lead.worker.id, alias: lead.worker.display_name, rating: lead.rating, rating_count: lead.rating_count, vehicle: lead.worker.vehicle, score: lead.score, kind: lead.worker.kind },
    pool: pool.map((c) => c.worker.id),
    pool_size: pool.length,
    participants: job.deal?.participants ?? [],
    locked_at: clock.now(),
    valid_until: clock.now() + DEAL_VALID_MS,
  };
  update('jobs', jobId, { deal, status: 'pending_confirmation', status_message: 'In attesa di conferma umana', updated_at: clock.now() });
  emit('negotiation.deal', { job_id: jobId, actor, data: { ...deal, pool: undefined } });
  return deal;
}

// Aronica's built-in buyer agent: opens at target, concedes toward the best
// counter, never exceeds max, prefers higher-scored suppliers.
export async function autoNegotiate(jobId, { target_cents, max_cents } = {}) {
  let job = get('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) throw new HttpError(404, 'job_not_found', 'Job not found');
  const skill = getSkill(job.skill);
  const max = max_cents ?? job.budget_max_cents ?? round50(skill.base_price_cents * 1.6);
  let offer = Math.min(max, target_cents ?? job.budget_target_cents ?? round50(skill.base_price_cents * 0.85));
  if (max_cents && max_cents !== job.budget_max_cents) update('jobs', jobId, { budget_max_cents: max_cents });
  const actor = 'Aronica Buyer Agent';
  let last = null;
  for (let round = job.negotiation_round + 1; round <= MAX_ROUNDS; round++) {
    const res = await negotiateRound(jobId, offer, { actor, message: round === 1 ? `Budget obiettivo. Offro ${eur(offer)}.` : `Rilancio a ${eur(offer)}.` });
    last = res;
    // Value = price inflated by how far the supplier is from a perfect match:
    // the buyer agent pays a bit more for the best-ranked worker (Uber gives you
    // the best available driver, not the cheapest).
    const eff = (r) => r.price_cents * (1 + (100 - r.score) / 100);
    const accepts = res.responses.filter((r) => r.action === 'accept');
    const counters = res.responses.filter((r) => r.action === 'counter' && r.price_cents <= max);
    const best = [...accepts, ...counters].sort((a, b) => eff(a) - eff(b))[0];
    if (best?.action === 'accept') return { deal: acceptQuote(jobId, best.quote_id, { actor }), rounds: res.round };
    if (best && (accepts.length || best.price_cents - offer <= Math.max(100, offer * 0.06) || res.round >= 5)) {
      emit('negotiation.buyer_offer', { job_id: jobId, actor, data: { round: res.round, accept_quote: best.quote_id, offer_cents: best.price_cents, message: `Accetto la controproposta di ${best.alias}: ${eur(best.price_cents)} (miglior rapporto qualità/prezzo).` } });
      return { deal: acceptQuote(jobId, best.quote_id, { actor }), rounds: res.round };
    }
    const lowest = res.responses.filter((r) => r.action === 'counter').sort((a, b) => a.price_cents - b.price_cents)[0];
    if (!lowest) break;
    let next = Math.min(max, round50(offer + (lowest.price_cents - offer) * 0.55));
    if (next <= offer) next = Math.min(max, offer + 100);
    if (next === offer && offer === max && res.round >= 6) break;
    offer = next;
    // The buyer agent "thinks" between rounds so humans can follow along live.
    await sleep(Number(process.env.ARONICA_NEG_DELAY_MS ?? 800) * 1.5);
    job = get('SELECT * FROM jobs WHERE id = ?', jobId);
  }
  const lowest = last?.lowest_counter;
  const msg = lowest
    ? `Nessun accordo entro ${eur(max)}. Miglior controproposta: ${eur(lowest.price_cents)} (${lowest.alias}).`
    : `Nessun accordo entro ${eur(max)}.`;
  update('jobs', jobId, { status_message: msg, updated_at: clock.now() });
  emit('negotiation.failed', { job_id: jobId, actor, data: { message: msg, max_cents: max, lowest_counter: lowest ?? null } });
  return { deal: null, message: msg, lowest_counter: lowest ?? null };
}

export function quotesForJob(jobId) {
  return all('SELECT * FROM quotes WHERE job_id = ? ORDER BY round, created_at', jobId);
}
