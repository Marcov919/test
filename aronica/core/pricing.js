// Fixed pricing: the platform quotes, the buyer accepts or not. No haggling.
// Surcharges are explicit lines so agents can explain the price to their human.
import { formula } from './services.js';
import { romeParts } from './time.js';
import { round50 } from './util.js';

export const PLATFORM_FEE = 0.15;

export function quote(service, params, { start, minutes = 0, now }) {
  const f = formula(service.code)(params, { minutes });
  const lines = f.lines.filter(Boolean).map(([label, cents]) => ({ label, cents: round50(cents) }));
  const base = lines.reduce((a, l) => a + l.cents, 0);
  const surcharges = [];
  const lead = (start - now) / 3600000;
  if (lead < 3) surcharges.push({ label: 'Preavviso sotto le 3 ore', pct: 30 });
  else if (lead < 24) surcharges.push({ label: 'Preavviso sotto le 24 ore', pct: 15 });
  const p = romeParts(start);
  if (p.dow === 0 || p.h >= 20) surcharges.push({ label: p.dow === 0 ? 'Domenica' : 'Fascia serale', pct: 10 });
  for (const s of surcharges) s.cents = round50((base * s.pct) / 100);
  const total = base + surcharges.reduce((a, s) => a + s.cents, 0);
  const fee = Math.round(total * PLATFORM_FEE);
  const seats = service.multi_seat ? Math.max(1, Number(params.persone) || 1) : 1;
  return {
    currency: 'EUR',
    lines,
    surcharges,
    total_cents: total,
    fee_cents: fee,
    payout_total_cents: total - fee,
    seat_payout_cents: Math.floor((total - fee) / seats),
    seats,
    minutes: f.minutes,
    hold_cents: f.hold ?? 0, // purchases: spending cap pre-authorised on top of the fee
  };
}
