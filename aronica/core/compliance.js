// Contract routing for one-shot work in Italy. The hard part of "a company hires
// a person for half a day" is not matching, it's the legal wrapper. For every
// assignment Aronica picks a route and checks the annual caps.
//
// ⚠ Values are INDICATIVE (PrestO, art. 54-bis DL 50/2017, as commonly cited)
// and must be validated with a consulente del lavoro before real use.
import { all } from './db.js';
import { clock, eur } from './util.js';
import { romeParts, romeTime, slotLabel } from './time.js';

export const CAPS = {
  presto_worker_total_cents: 500000,  // per prestatore, from all utilizzatori, per year
  presto_buyer_total_cents: 1000000,  // per utilizzatore, per year
  presto_pair_cents: 250000,          // same utilizzatore ↔ same prestatore, per year
  presto_max_employees: 10,           // utilizzatori above this size cannot use PrestO
};

export const ROUTES = {
  fattura_b2b: { label_it: 'Partner con P.IVA · fattura al cliente (stub)', who: 'Il partner (attività con P.IVA) fattura al cliente; Aronica fa matching, dispatch e verifica della prova e trattiene la commissione. Aronica non è il datore di lavoro.' },
  occasionale_privato: { label_it: 'Partner privato · ricevuta occasionale (stub)', who: 'Il partner emette al cliente una ricevuta di prestazione occasionale; Aronica fa matching, dispatch e verifica della prova. Aronica non è il datore di lavoro.' },
  presto: { label_it: 'Contratto PrestO (INPS)', who: 'Contratto di prestazione occasionale PrestO: l\'azienda utilizzatrice versa tramite la piattaforma INPS.' },
  somministrazione: { label_it: 'Somministrazione tramite agenzia partner', who: 'Il partner è assunto per il turno da un\'agenzia per il lavoro autorizzata, che fattura all\'azienda.' },
};

function yearStart() {
  const p = romeParts(clock.now());
  return romeTime(p.y, 1, 1, 0, 0);
}

// Sum of PrestO payouts in the current year (optionally filtered).
async function prestoTotal({ workerId = null, accountId = null } = {}) {
  const rows = await all(
    "SELECT a.payout_cents, a.worker_id, j.account_id, a.contract FROM assignments a JOIN jobs j ON j.id = a.job_id WHERE a.assigned_at >= ? AND a.status != 'cancelled'",
    yearStart(),
  );
  return rows
    .filter((r) => r.contract?.route === 'presto' && (!workerId || r.worker_id === workerId) && (!accountId || r.account_id === accountId))
    .reduce((a, r) => a + r.payout_cents, 0);
}

export async function routeContract({ account, worker, payoutCents }) {
  if (worker.kind === 'business') return { route: 'fattura_b2b', ...ROUTES.fattura_b2b, checks: [] };
  if (account.kind !== 'business') return { route: 'occasionale_privato', ...ROUTES.occasionale_privato, checks: [] };
  const employees = account.org?.employees ?? 0;
  const w = await prestoTotal({ workerId: worker.id });
  const b = await prestoTotal({ accountId: account.id });
  const pair = (await all(
    "SELECT a.payout_cents, a.contract FROM assignments a JOIN jobs j ON j.id = a.job_id WHERE a.worker_id = ? AND j.account_id = ? AND a.assigned_at >= ? AND a.status != 'cancelled'",
    worker.id, account.id, yearStart(),
  )).filter((r) => r.contract?.route === 'presto').reduce((a, r) => a + r.payout_cents, 0);
  const checks = [
    { rule: `Dipendenti utilizzatore ≤ ${CAPS.presto_max_employees}`, ok: employees <= CAPS.presto_max_employees, value: employees },
    { rule: `Compensi PrestO del prestatore nell'anno ≤ ${eur(CAPS.presto_worker_total_cents)}`, ok: w + payoutCents <= CAPS.presto_worker_total_cents, value: eur(w + payoutCents) },
    { rule: `Compensi PrestO dell'utilizzatore nell'anno ≤ ${eur(CAPS.presto_buyer_total_cents)}`, ok: b + payoutCents <= CAPS.presto_buyer_total_cents, value: eur(b + payoutCents) },
    { rule: `Stesso utilizzatore ↔ prestatore nell'anno ≤ ${eur(CAPS.presto_pair_cents)}`, ok: pair + payoutCents <= CAPS.presto_pair_cents, value: eur(pair + payoutCents) },
  ];
  const route = checks.every((c) => c.ok) ? 'presto' : 'somministrazione';
  return { route, ...ROUTES[route], checks, indicative: true };
}

export function contractText({ route, account, worker, job, payoutCents }) {
  const who = account.org?.legal_name ?? account.name;
  const r = ROUTES[route];
  return [
    `${r.label_it.toUpperCase()} — bozza generata da Aronica (stub, non firmata)`,
    `Committente: ${who}${account.org?.vat_id ? ` · P.IVA ${account.org.vat_id}` : ''}`,
    `Prestatore: ${worker.legal_name ?? worker.display_name}${worker.vat_id ? ` · P.IVA ${worker.vat_id}` : ''}`,
    `Oggetto: ${job.title} — ${job.address}`,
    `Quando: ${slotLabel(job.slot_start ?? job.window_start, job.duration_min)}`,
    `Compenso: ${eur(payoutCents)} (lordo per il prestatore)`,
    r.who,
  ].join('\n');
}
