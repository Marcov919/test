// Europe/Rome wall-clock helpers (the server may run in UTC; availability,
// "sabato mattina" and invoices are all local to Milano).
const TZ = 'Europe/Rome';
const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
});
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function romeParts(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, dow: WD[p.weekday] };
}

function offsetAt(ms) {
  const p = romeParts(ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(ms / 60000) * 60000;
}

// Local Rome date/time → epoch ms.
export function romeTime(y, m, d, h = 0, min = 0) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}

export function minutesOfDay(ms) { const p = romeParts(ms); return p.h * 60 + p.min; }

export function startOfRomeDay(ms, addDays = 0) {
  const p = romeParts(ms);
  return romeTime(p.y, p.m, p.d + addDays, 0, 0);
}

const DAYS_IT = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
export function slotLabel(startMs, durationMin) {
  const s = romeParts(startMs);
  const e = romeParts(startMs + durationMin * 60000);
  const hh = (p) => `${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
  return `${DAYS_IT[s.dow]} ${s.d}/${s.m} · ${hh(s)}–${hh(e)}`;
}

export function durationLabel(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}
