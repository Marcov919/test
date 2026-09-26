// Task compiler: vague intent → structured, priced, verifiable job.
//   "devo sistemare il giardino sabato mattina, sono circa 80 mq con la siepe"
//   → giardinaggio {area_m2: 80, siepi: true} · sab 8:00–13:00 · 2h 33m · €87
// Deterministic (no LLM) so it works offline; LLM agents can instead send the
// typed params directly (see list_services → params) and use this to validate.
import { listServices, getService, normalizeParams } from './services.js';
import { quote } from './pricing.js';
import { geocode, inServiceArea, haversineKm, CITY } from './geo.js';
import { romeParts, romeTime, slotLabel, durationLabel } from './time.js';
import { clock, HttpError, NO_SUPPLY_IT } from './util.js';

const norm = (s) => ` ${String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/['’]/g, ' ').replace(/\s+/g, ' ')} `;

// Lifestyle / regulated services Aronica deliberately does NOT do.
export const ERRAND_RADIUS_KM = 3;

export const OUT_OF_SCOPE = [
  'capoeira', 'insegnante', 'teacher', 'lezione', 'lesson', 'tutor', 'ripetizioni', 'nails', 'unghie', 'manicure',
  'pedicure', 'dentist', 'medico', 'doctor', 'infermier', 'badante', 'parrucchier', 'haircut', 'barbier', 'massagg',
  'massage', 'babysit', 'baby sitter', 'dog sitter', 'dog walk', 'idraulico', 'plumber', 'elettricista', 'electrician',
  'caldaia', 'gas', 'personal trainer', 'yoga', 'escort', 'dating', 'avvocato', 'commercialista',
];

export function classify(textIn) {
  const t = norm(textIn);
  let best = null;
  for (const s of listServices()) {
    let score = 0;
    const matched = [];
    for (const kw of s.keywords) {
      const k = norm(kw).trim();
      const hit = k.length >= 5 ? t.includes(k) : new RegExp(`\\b${k}\\b`).test(t);
      if (hit) { score += k.split(' ').length; matched.push(kw); }
    }
    if (score > 0 && (!best || score > best.score)) best = { service: s, score, matched };
  }
  const oos = OUT_OF_SCOPE.filter((k) => t.includes(k));
  if (oos.length && !(best && best.service.mentions_ok)) return { service: null, out_of_scope: oos };
  if (!best) return null;
  return { service: best.service, confidence: Math.min(1, 0.45 + best.score * 0.15), matched: best.matched };
}

// ---- number / time extraction -------------------------------------------------
const WORDS = { un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, dodici: 12, quindici: 15, venti: 20 };
const N = `(\\d+|${Object.keys(WORDS).join('|')})`;
const toN = (s) => (/^\d+$/.test(s) ? Number(s) : WORDS[s]);

function grab(t, re) { const m = re.exec(t); return m ? toN(m[1]) : undefined; }

function extractParams(service, t) {
  const p = {};
  const area = /(\d+)\s*(m2|m²|mq|metri quadr|metri)/.exec(t);
  if (area) p.area_m2 = Number(area[1]);
  const persone = grab(t, new RegExp(`\\b${N}\\s*(persone|facchini|facchino|hostess|steward|runner|ragazz[ie]|addetti|operatori|persone)\\b`));
  if (persone) p.persone = persone;
  const pezzi = grab(t, new RegExp(`\\b${N}\\s*(mobili|armadi|librerie|pezzi|comodini|cassettiere|scaffali|letti)\\b`));
  if (pezzi) p.pezzi = pezzi;
  const interventi = grab(t, new RegExp(`\\b${N}\\s*(quadri|mensole|tende|lavoretti|lavori|interventi|specchi)\\b`));
  if (interventi) p.interventi = interventi;
  const ore = grab(t, new RegExp(`\\bper\\s*${N}\\s*(ore|h)\\b`));
  if (ore) p.ore = ore;
  const eur = /(?:max(?:imo)?|fino a|budget|spesa)\s*(?:di\s*)?(\d+)\s*(?:€|euro|eur)?|(\d+)\s*(?:€|euro)/.exec(t);
  if (eur) p.spesa_max_eur = Number(eur[1] ?? eur[2]);
  if (/\bsiep/.test(t)) p.siepi = true;
  if (/\bfoglie\b/.test(t)) p.foglie = true;
  if (/\b(armadio|armadi|cucina|letto|letti|pax)\b/.test(t)) p.taglia = 'grande';
  else if (/\b(comodin|sedi[ae])/.test(t)) p.taglia = 'piccolo';
  if (/fissa(re|ggio)? (a|al) muro|a muro/.test(t)) p.fissaggio_muro = true;
  if (/dopo la festa|post festa|post-festa|dopo una festa/.test(t)) p.tipo = 'post_festa';
  else if (/a fondo|profonda/.test(t)) p.tipo = 'fondo';
  if (/\bsteward\b/.test(t)) p.ruolo = 'steward';
  else if (/\brunner\b/.test(t)) p.ruolo = 'runner';
  else if (/guardaroba/.test(t)) p.ruolo = 'guardaroba';
  else if (/hostess|accoglienza/.test(t)) p.ruolo = 'hostess';
  if (/inglese|english/.test(t)) p.inglese = true;
  if (/muletto/.test(t)) p.muletto = true;
  if (/biancheria/.test(t)) p.biancheria = true;
  if (/check.?in|accogliere (gli )?ospit/.test(t)) p.check_in = true;
  if (service.code === 'lavaggio_auto') {
    if (/\b(suv|monovolume|fuoristrada|crossover)\b/.test(t)) p.veicolo = 'suv';
    else if (/\b(utilitaria|city ?car|panda|500|yaris|clio|smart)\b/.test(t)) p.veicolo = 'utilitaria';
    else if (/\b(berlina|station|wagon|sw|golf|audi|bmw)\b/.test(t)) p.veicolo = 'berlina';
    if (/igienizz|sanific|completo/.test(t)) p.tipo = 'completo';
    else if (/intern[oi]\s*(\+|e|ed|and)\s*estern[oi]|estern[oi]\s*(\+|e|ed|and)\s*intern[oi]|dentro e fuori|interni/.test(t)) p.tipo = 'interno_esterno';
    else if (/solo (l )?estern|\bestern[oi]\b/.test(t)) p.tipo = 'esterno';
    if (/sotto casa|a domicilio|carrello|senza spostar|in garage|in cortile/.test(t)) p.ritiro = false;
    else if (/riport|ritir|portala|porta la (mia )?(auto|macchina)|porta l auto|all autolavaggio|pick.?up/.test(t)) p.ritiro = true;
  }
  if (service.code === 'ritiro_consegna') {
    if (/farmac|medicin|ricetta/.test(t)) p.cosa = 'farmaco';
    else if (/\bchiav/.test(t)) p.cosa = 'chiavi';
    else if (/busta|document|lettera|contratto/.test(t)) p.cosa = 'documenti';
    const at = /\b(?:da|dal|dalla|dallo|presso|in|alla|al)\s+((?:farmacia|portineria|negozio|ufficio|tabaccheria|edicola|bar|studio|via|corso|piazza|viale)\b[^,.;]*?)(?=\s+(?:e|entro|per|oggi|domani|stasera|alle|a casa|portal[aoie]|portamel[aoie]|consegna)\b|[,.;]|\s*$)/.exec(t);
    if (at) p.ritiro_presso = at[1].trim();
  }
  if (service.code === 'commissione_acquisto') {
    const art = /(?:comprar(?:e|mi|ci)|comprami|acquistare|prendermi|prendere)\s+(.+?)(?:\s+(?:da|in|al|alla|presso|entro|per|max|massimo|fino)\b|[,.]|$)/.exec(t);
    if (art) p.articolo = art[1].trim();
    const neg = /\b(?:da|presso)\s+([a-z0-9' ]+?)(?:\s+(?:in|a|entro|per|max|massimo|fino)\b|[,.]|$)/.exec(t);
    if (neg) p.negozio = neg[1].trim();
  }
  return p;
}

const DOW = { domenica: 0, lunedi: 1, martedi: 2, mercoledi: 3, giovedi: 4, venerdi: 5, sabato: 6 };
const PARTS = { mattina: [8, 13], mattinata: [8, 13], pranzo: [12, 14], pomeriggio: [14, 19], sera: [18, 22], stasera: [18, 22], serata: [18, 22] };

// Returns { start, end, explicitDay, explicitTime } in epoch ms (Europe/Rome).
export function extractWhen(t, now) {
  const today = romeParts(now);
  let dayOffset = null;
  let explicitDay = false;
  if (/\bdopodomani\b/.test(t)) dayOffset = 2;
  else if (/\bdomani\b/.test(t)) dayOffset = 1;
  else if (/\boggi\b|\bstasera\b|\bstamattina\b|\bentro le\b/.test(t)) dayOffset = 0;
  for (const [name, dow] of Object.entries(DOW)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) { dayOffset = ((dow - today.dow + 7) % 7) || 7; break; }
  }
  if (dayOffset == null && /weekend|fine settimana/.test(t)) dayOffset = ((6 - today.dow + 7) % 7) || 7;
  const date = /\b(\d{1,2})[/.](\d{1,2})\b/.exec(t);
  let y = today.y; let m = today.m; let d = today.d;
  if (date) { d = Number(date[1]); m = Number(date[2]); explicitDay = true; if (m < today.m) y += 1; } else if (dayOffset != null) {
    explicitDay = true;
    const dt = romeParts(romeTime(today.y, today.m, today.d + dayOffset, 12, 0));
    ({ y, m, d } = dt);
  }
  let sh = null; let sm = 0; let eh = null; let em = 0; let explicitTime = false;
  const range = /(?:dalle|ore|h)?\s*\b(\d{1,2})(?:[:.](\d{2}))?\s*(?:-|–|alle|fino alle|a)\s*(\d{1,2})(?:[:.](\d{2}))?\b(?!\s*(?:m2|mq|persone|facchini|hostess|€|euro))/.exec(t);
  if (range && Number(range[1]) <= 23 && Number(range[3]) <= 24 && Number(range[3]) > Number(range[1])) {
    sh = Number(range[1]); sm = Number(range[2] ?? 0); eh = Number(range[3]); em = Number(range[4] ?? 0); explicitTime = true;
  } else {
    const entro = /entro le\s*(\d{1,2})(?:[:.](\d{2}))?/.exec(t);
    const at = /\balle\s*(\d{1,2})(?:[:.](\d{2}))?\b/.exec(t);
    if (entro) { eh = Number(entro[1]); em = Number(entro[2] ?? 0); explicitTime = true; } else if (at) { sh = Number(at[1]); sm = Number(at[2] ?? 0); explicitTime = true; }
    for (const [name, [a, b]] of Object.entries(PARTS)) {
      if (new RegExp(`\\b${name}\\b`).test(t)) { if (sh == null) sh = a; if (eh == null) eh = b; explicitTime = true; break; }
    }
  }
  if (!explicitDay && !explicitTime) return null;
  const dayStart = (h, mi) => romeTime(y, m, d, h, mi);
  let start = sh != null ? dayStart(sh, sm) : null;
  let end = eh != null ? dayStart(eh, em) : null;
  if (start == null) start = end != null && explicitDay === false ? now : dayStart(9, 0);
  if (start < now) start = now + 15 * 60000;
  if (end == null) end = explicitTime && sh != null ? null : dayStart(18, 0);
  return { start, end, explicitDay, explicitTime };
}

// ---- compile ------------------------------------------------------------------
// reason: short machine-friendly label shown next to the honest message.
function failClosed(code, detail, reason) {
  return new HttpError(422, code, NO_SUPPLY_IT, { detail, reason });
}

const NOW_RE = /\b(adesso|subito|al piu presto|appena possibile|asap|right now)\b/;

export function compileTask(input = {}) {
  const now = clock.now();
  const textIn = [input.text, input.title, input.description].filter(Boolean).join(' \n ');
  const t = norm(textIn);
  let service;
  let classification = null;
  if (input.service) {
    service = getService(String(input.service));
    if (!service) throw failClosed('unsupported_service', `Il servizio "${input.service}" non esiste nel catalogo Aronica.`, 'fuori ambito v1');
  } else {
    if (!textIn.trim()) throw new HttpError(400, 'text_required', 'Descrivi il lavoro (text) oppure indica service e params.');
    classification = classify(textIn);
    if (!classification?.service) {
      const why = classification?.out_of_scope?.length
        ? `Lezioni, insegnanti, servizi lifestyle o regolamentati non sono coperti (${classification.out_of_scope.join(', ')}). Nessun partner viene contattato.`
        : 'Nessun servizio del catalogo corrisponde alla richiesta. Nessun partner viene contattato.';
      throw failClosed('unsupported_task', why, 'fuori ambito v1');
    }
    service = classification.service;
  }
  const extracted = extractParams(service, t);
  const { params, assumed, missing } = normalizeParams(service, { ...extracted, ...(input.params ?? {}) });

  // Where
  let location = null;
  const loc = input.location ?? {};
  if (loc.lat != null && loc.lng != null) location = { lat: Number(loc.lat), lng: Number(loc.lng), address: loc.address ?? null };
  else {
    // Errands: the pick-up place is not where the job ends; don't geocode it as the address.
    const where = params.ritiro_presso ? t.replace(norm(params.ritiro_presso).trim(), ' ') : textIn;
    const g = geocode(`${loc.address ?? ''} ${where}`);
    if (g) location = { lat: g.lat, lng: g.lng, address: loc.address || g.matched };
  }
  if (location && !inServiceArea(location)) throw failClosed('outside_service_area', `Fuori dall'area servita (Milano, ${CITY.radius_km} km dal Duomo).`, 'fuori area v1');
  // Tight-radius errands: pick-up and drop-off must be close (v1: 3 km).
  if (service.code === 'ritiro_consegna' && location && params.ritiro_presso) {
    const from = geocode(params.ritiro_presso);
    if (from && haversineKm(from, location) > ERRAND_RADIUS_KM) {
      throw failClosed('outside_errand_radius', `Ritiro a ${Math.round(haversineKm(from, location) * 10) / 10} km dalla consegna: in v1 facciamo solo ritiri entro ${ERRAND_RADIUS_KM} km.`, 'fuori raggio v1');
    }
  }

  // When
  const questions = [];
  let when = null;
  // Adesso (as soon as possible, within 3h) vs Programma (a window).
  const mode = input.mode === 'now' || input.mode === 'scheduled' ? input.mode : (!input.window?.start && NOW_RE.test(t) ? 'now' : 'scheduled');
  if (mode === 'now') {
    when = { start: now, end: now + 3 * 3600000, explicitDay: true, explicitTime: true };
  } else if (input.window?.start) {
    when = { start: Date.parse(input.window.start), end: input.window.end ? Date.parse(input.window.end) : null, explicitDay: true, explicitTime: true };
    if (Number.isNaN(when.start)) throw new HttpError(400, 'invalid_window', 'window.start non è una data valida');
  } else when = extractWhen(t, now);
  if (mode === 'scheduled' && when && when.start < now + 45 * 60000 && !input.window?.start) when.start = now + 45 * 60000;
  const fixed = !service.flexible;
  if (!when) {
    const p = romeParts(now);
    when = { start: romeTime(p.y, p.m, p.d + 1, 9, 0), end: romeTime(p.y, p.m, p.d + 1, fixed ? 13 : 18, 0), assumed: true };
    questions.push({ key: 'window', q: fixed ? 'Orario esatto del turno?' : 'Quando? (ho ipotizzato domani 9–18)', blocking: false });
  }

  // How long / how many
  let minutes;
  if (fixed && service.multi_seat) {
    if (!when.end) when.end = when.start + 4 * 3600000;
    minutes = Math.round((when.end - when.start) / 60000);
  } else if (service.code === 'attesa_in_casa') {
    if (when.end && when.end > when.start) params.ore = Math.max(1, Math.round((when.end - when.start) / 3600000));
    minutes = params.ore * 60;
    when.end = when.start + minutes * 60000;
    if (when.explicitTime) assumed.splice(assumed.indexOf('ore') >>> 0, assumed.includes('ore') ? 1 : 0);
  }
  const q = quote(service, params, { start: when.start, minutes: minutes ?? 0, now });
  minutes = q.minutes;
  if (!when.end || when.end - when.start < minutes * 60000) when.end = when.start + minutes * 60000;
  const flexible = mode === 'now' || (!!service.flexible && when.end - when.start > minutes * 60000);

  for (const k of assumed) {
    const f = service.params.find((x) => x.key === k);
    questions.push({ key: k, q: `${f.ask} (ipotizzato: ${params[k]}${f.unit ? ` ${f.unit}` : ''})`, blocking: false });
  }
  for (const f of missing) questions.push({ key: f.key, q: f.ask ?? f.label, blocking: true });
  if (!location) questions.push({ key: 'location', q: 'Indirizzo o zona di Milano?', blocking: true });

  const headcount = q.seats;
  const title = input.title?.trim() || titleFor(service, params, headcount);
  return {
    ok: true,
    ready: !questions.some((x) => x.blocking),
    service: { code: service.code, name: service.name_it, segment: service.segment, proof_kind: service.proof.kind },
    classification: classification ? { confidence: classification.confidence, matched: classification.matched } : null,
    title,
    params,
    assumed,
    questions,
    location,
    mode,
    window: {
      start: new Date(when.start).toISOString(), end: new Date(when.end).toISOString(), flexible,
      label: mode === 'now' ? `Adesso · appena c'è un partner, entro le ${slotLabel(when.end, 0).split(' · ')[1].split('–')[0]}` : flexible ? `${slotLabel(when.start, Math.round((when.end - when.start) / 60000))} (inizio flessibile)` : slotLabel(when.start, minutes),
    },
    duration_min: minutes,
    duration_label: durationLabel(minutes),
    headcount,
    price: q,
    proof: service.proof,
    instructions: service.instructions,
  };
}

function titleFor(s, p, n) {
  switch (s.code) {
    case 'giardinaggio': return `Giardino ${p.area_m2} m²${p.siepi ? ' + siepi' : ''}${p.foglie ? ' + foglie' : ''}`;
    case 'montaggio_mobili': return `Montaggio ${p.pezzi} ${p.pezzi > 1 ? 'mobili' : 'mobile'} (${p.taglia})`;
    case 'tuttofare': return `Tuttofare · ${p.interventi} interventi`;
    case 'pulizie_casa': return `Pulizie ${p.tipo.replace('_', ' ')} · ${p.area_m2} m²`;
    case 'attesa_in_casa': return `Attesa a casa · ${p.ore} h`;
    case 'commissione_acquisto': return `Acquisto: ${p.articolo ?? 'articolo'}${p.negozio ? ` da ${p.negozio}` : ''}`;
    case 'facchinaggio_allestimento': return `${n} facchini · allestimento`;
    case 'staff_eventi': return `${n} ${p.ruolo}${n > 1 && p.ruolo === 'hostess' ? '' : ''} per evento`;
    case 'turnover_affitti': return `Turnover appartamento ${p.area_m2} m²${p.biancheria ? ' + biancheria' : ''}`;
    case 'lavaggio_auto': return `Lavaggio auto ${p.veicolo} · ${{ esterno: 'solo esterno', interno_esterno: 'interno + esterno', completo: 'completo' }[p.tipo] ?? p.tipo}${p.ritiro ? ' · ritiro e riconsegna' : ' · sotto casa'}`;
    case 'ritiro_consegna': return `Ritiro ${{ farmaco: 'farmaco', chiavi: 'chiavi', documenti: 'busta/documenti', pacco: 'pacco' }[p.cosa] ?? ''}${p.ritiro_presso ? ` da ${p.ritiro_presso}` : ''} e consegna`;
    default: return s.name_it;
  }
}
