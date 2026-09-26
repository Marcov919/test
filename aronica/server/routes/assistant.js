// Simulated assistant platform (stands in for the servers of an assistant such
// as Muse / Instinct / ChatGPT). It is NOT part of Aronica's product surface:
// it is the other side of the connector, used to demo the real experience.
//  - it holds its Aronica API key server-side (never in the browser);
//  - it calls Aronica through the same tool layer MCP clients use (callTool);
//  - the "agent" is a deterministic script, no LLM (labelled in the UI).
// The confirm card it renders talks to the Confirm API with the per-job token.
import { callTool, accountFromKey } from '../../gateway/tools.js';
import { HttpError } from '../../core/util.js';
import { json, parseJson } from '../http.js';

const eur = (c) => `€${(c / 100).toFixed(2).replace('.', ',')}`;

async function assistantAccount() {
  const key = process.env.ASSISTANT_API_KEY || 'ak_demo_milano';
  const account = await accountFromKey(key);
  if (!account) throw new HttpError(500, 'assistant_misconfigured', 'ASSISTANT_API_KEY is not a valid Aronica key');
  return account;
}

// Run one tool and keep a transparent trace (shown collapsed in the chat).
async function call(trace, account, name, args) {
  try {
    const out = await callTool(account, name, args);
    trace.push({ tool: name, args, ok: true });
    return { ok: true, out };
  } catch (e) {
    const err = e instanceof HttpError ? { error: e.code, message: e.message, ...e.extra } : { error: 'internal_error', message: e.message };
    trace.push({ tool: name, args, ok: false, error: err.error });
    return { ok: false, err };
  }
}

const tokenOf = (confirmUrl) => new URL(confirmUrl.replace('#/', '')).searchParams.get('t');

function confirmCard(job, confirmUrl) {
  const d = job.deal;
  return {
    job_id: job.id, token: tokenOf(confirmUrl), confirm_url: confirmUrl,
    title: job.title, address: job.location.address, mode: job.mode, slot_label: d.slot_label,
    price_cents: job.price.total_cents, lines: job.price.lines, surcharges: job.price.surcharges,
    lead: { alias: d.lead.alias, kind: d.lead.kind, rating: d.lead.rating, rating_count: d.lead.rating_count, how: d.lead.how ?? null },
    proof: job.proof_requirements?.shots ?? null,
  };
}

export function assistantRoutes(r) {
  // 1) Understand + check supply. Returns a proposal with Adesso / Programma.
  r.post('/api/assistant/plan', async ({ res, body }) => {
    const { text } = parseJson(body);
    if (!text || !String(text).trim()) throw new HttpError(400, 'text_required', 'Scrivi una richiesta');
    const account = await assistantAccount();
    const trace = [];
    const sched = await call(trace, account, 'compile_task', { text });
    if (!sched.ok) {
      return json(res, 200, { kind: 'refusal', reply: sched.err.message, reason: sched.err.reason ?? null, detail: sched.err.detail ?? null, trace });
    }
    const c = sched.out;
    const blocking = c.questions.filter((q) => q.blocking);
    if (blocking.length) {
      return json(res, 200, { kind: 'question', reply: `Per chiedere ad Aronica mi serve ancora: ${blocking.map((q) => q.q).join(' ')}`, trace });
    }
    const now = await call(trace, account, 'compile_task', { text, mode: 'now' });
    const supS = await call(trace, account, 'search_supply', { text, mode: c.mode === 'now' ? 'now' : 'scheduled', limit: 3 });
    const supN = await call(trace, account, 'search_supply', { text, mode: 'now', limit: 3 });
    const availS = supS.ok ? supS.out.available : 0;
    const availN = supN.ok ? supN.out.available : 0;
    if (!availS && !availN) {
      return json(res, 200, { kind: 'refusal', reply: supS.out?.message ?? 'Siamo spiacenti ma al momento non abbiamo persone sufficienti a soddisfare la richiesta.', reason: 'nessun partner disponibile', trace });
    }
    const soft = c.questions.filter((q) => !q.blocking).map((q) => q.q);
    json(res, 200, {
      kind: 'proposal',
      reply: `Posso farlo fare tramite Aronica: ${c.title.toLowerCase()}, ${c.location.address}. Prezzo fisso, persone o attività verificate${availS ? `, ${availS} disponibili` : ''}.${soft.length ? ` Ho ipotizzato: ${soft.join(' ')}` : ''}`,
      proposal: {
        text, title: c.title, service: c.service.name, address: c.location.address,
        proof: c.proof.shots ?? null, duration: c.duration_label,
        scheduled: { window: c.window.label, price_cents: c.price.total_cents, available: availS, mode: c.mode },
        now: now.ok ? { window: now.out.window.label, price_cents: now.out.price.total_cents, available: availN, surcharges: now.out.price.surcharges } : null,
        partners: (supS.ok && availS ? supS.out.partners : supN.ok ? supN.out.partners : []).map((p) => ({ alias: p.alias, kind: p.kind, rating: p.rating, distance_km: p.distance_km, how: p.how, rank: p.rank })),
      },
      trace,
    });
  });

  // 2) Book: create the job and let the supplier agents agree on the slot.
  r.post('/api/assistant/book', async ({ res, body }) => {
    const { text, mode } = parseJson(body);
    const account = await assistantAccount();
    const trace = [];
    const created = await call(trace, account, 'create_job', { text, mode: mode === 'now' ? 'now' : 'scheduled', agent_name: 'Il tuo assistente' });
    if (!created.ok) return json(res, 200, { kind: 'refusal', reply: created.err.message, reason: created.err.reason ?? null, trace });
    const jobId = created.out.job.id;
    const neg = await call(trace, account, 'auto_negotiate', { job_id: jobId });
    if (!neg.ok) return json(res, 200, { kind: 'refusal', reply: neg.err.message, trace });
    if (neg.out.deal) {
      const card = confirmCard(neg.out.job, neg.out.confirm_url);
      return json(res, 200, {
        kind: 'confirm',
        reply: `${card.lead.alias} può ${card.mode === 'now' ? 'adesso' : `il ${card.slot_label}`}. ${eur(card.price_cents)} fissi. Confermi?`,
        confirm: card, trace,
      });
    }
    json(res, 200, {
      kind: 'counters', job_id: jobId,
      reply: neg.out.message ?? 'Nessuno è libero in quella fascia.',
      counters: (neg.out.counters ?? []).slice(0, 3).map((q) => ({ quote_id: q.quote_id, alias: q.alias, slot_label: q.slot_label })),
      trace,
    });
  });

  // 2b) The human picked one of the supplier agents' counter-proposals.
  r.post('/api/assistant/accept', async ({ res, body }) => {
    const { job_id, quote_id } = parseJson(body);
    const account = await assistantAccount();
    const trace = [];
    const acc = await call(trace, account, 'accept_quote', { job_id, quote_id });
    if (!acc.ok) return json(res, 200, { kind: 'refusal', reply: acc.err.message, trace });
    const card = confirmCard(acc.out.job, acc.out.confirm_url ?? acc.out.job.confirm_url);
    json(res, 200, { kind: 'confirm', reply: `Ok: ${card.lead.alias}, ${card.slot_label}. ${eur(card.price_cents)}. Confermi?`, confirm: card, trace });
  });
}
