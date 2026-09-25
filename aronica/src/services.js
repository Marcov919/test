// Aronica service catalog (v2). Two segments:
//   casa     — what a personal assistant generates while planning someone's week
//   business — one-shot hiring by companies (events, short-term rentals, inspections)
// Each service is a *structured* job: typed parameters, a price formula (fixed,
// no haggling), a duration formula, and a proof type. Anything not in the table
// fails closed.
import { all, get } from './db.js';

const num = (key, label, opts = {}) => ({ key, type: 'number', label, ...opts });
const bool = (key, label, def = false) => ({ key, type: 'bool', label, default: def });
const oneOf = (key, label, options, def) => ({ key, type: 'enum', label, options, default: def });
const text = (key, label, opts = {}) => ({ key, type: 'text', label, ...opts });
const yesNo = (id, q) => ({ id, q, type: 'yes_no', required: true });
const note = (id, q, required = false) => ({ id, q, type: 'text', required });

export const SERVICE_SEED = [
  // ------------------------------------------------------------------ casa
  {
    code: 'giardinaggio', segment: 'casa', name_it: 'Giardinaggio', name_en: 'Gardening',
    description: 'Taglio prato, siepi, foglie e smaltimento del verde. Squadre con attrezzatura propria.',
    params: [
      num('area_m2', 'Superficie del giardino', { unit: 'm²', default: 100, min: 10, max: 3000, ask: 'Quanti m² circa è il giardino?' }),
      bool('siepi', 'Taglio siepi', false),
      bool('foglie', 'Raccolta foglie', false),
      bool('smaltimento', 'Smaltimento del verde', true),
    ],
    proof: { kind: 'photos', photos_min: 4, gps_radius_m: 200, checklist: [yesNo('done_as_agreed', 'Lavori eseguiti come concordato?'), yesNo('green_removed', 'Verde smaltito o lasciato in sacchi?')] },
    instructions: ['Foto prima di iniziare (visione d\'insieme)', 'Esegui i lavori concordati', 'Foto dopo, dalle stesse angolazioni', 'Lascia il cancello chiuso come l\'hai trovato'],
    keywords: ['giardin', 'prato', 'siepe', 'siepi', 'erba', 'potatur', 'foglie', 'garden', 'lawn', 'hedge', 'giardiniere', 'gardener', 'decespugli'],
    flexible: true,
  },
  {
    code: 'montaggio_mobili', segment: 'casa', name_it: 'Montaggio mobili', name_en: 'Furniture assembly',
    description: 'Montaggio di mobili in kit (IKEA e simili), con attrezzi propri.',
    params: [
      num('pezzi', 'Numero di mobili', { default: 1, min: 1, max: 30, ask: 'Quanti mobili da montare?' }),
      oneOf('taglia', 'Dimensione media', [{ v: 'piccolo', label: 'Piccolo (comodino, sedia)' }, { v: 'medio', label: 'Medio (libreria, cassettiera)' }, { v: 'grande', label: 'Grande (armadio, letto, cucina)' }], 'medio'),
      bool('fissaggio_muro', 'Fissaggio a muro', false),
    ],
    proof: { kind: 'photos', photos_min: 2, gps_radius_m: 150, checklist: [yesNo('assembled', 'Tutti i mobili montati?'), note('notes', 'Pezzi mancanti o problemi')] },
    instructions: ['Verifica che ci siano tutti i pezzi', 'Monta e fissa (a muro se richiesto)', 'Foto dei mobili montati', 'Porta via il cartone solo se concordato'],
    keywords: ['mobili', 'mobile', 'ikea', 'armadio', 'libreria', 'cassettiera', 'comodino', 'montare il letto', 'montare', 'assemblare', 'furniture', 'assemble', 'kallax', 'billy', 'pax'],
    flexible: true,
  },
  {
    code: 'tuttofare', segment: 'casa', name_it: 'Tuttofare', name_en: 'Handyman',
    description: 'Piccoli lavori: appendere quadri, tende e mensole, maniglie, silicone. Niente impianti elettrici o idraulici certificati.',
    params: [
      num('interventi', 'Numero di piccoli interventi', { default: 2, min: 1, max: 15, ask: 'Quanti piccoli lavori (es. 3 quadri = 3)?' }),
      bool('materiale', 'Il materiale lo fornisce il partner', false),
    ],
    proof: { kind: 'photos', photos_min: 2, gps_radius_m: 150, checklist: [yesNo('done', 'Tutti gli interventi completati?'), note('notes', 'Note')] },
    instructions: ['Concorda con il cliente l\'ordine dei lavori', 'Foto di ogni intervento finito'],
    keywords: ['appendere', 'quadri', 'quadro', 'tende', 'tenda', 'mensol', 'maniglia', 'silicone', 'tuttofare', 'handyman', 'piccoli lavori', 'piccole riparazioni', 'bastone', 'specchio'],
    flexible: true,
  },
  {
    code: 'pulizie_casa', segment: 'casa', name_it: 'Pulizie', name_en: 'Cleaning',
    description: 'Pulizie di casa, a fondo o dopo una festa. Prodotti inclusi.',
    params: [
      num('area_m2', 'Superficie', { unit: 'm²', default: 70, min: 20, max: 500, ask: 'Quanti m² è la casa?' }),
      oneOf('tipo', 'Tipo di pulizia', [{ v: 'standard', label: 'Ordinaria' }, { v: 'fondo', label: 'A fondo' }, { v: 'post_festa', label: 'Dopo una festa' }], 'standard'),
    ],
    proof: { kind: 'photos', photos_min: 3, gps_radius_m: 150, checklist: [yesNo('done', 'Tutte le stanze pulite?'), note('notes', 'Note')] },
    instructions: ['Foto prima', 'Pulizia secondo il tipo richiesto', 'Foto dopo di cucina, bagno e soggiorno'],
    keywords: ['pulizi', 'pulire', 'clean', 'dopo la festa', 'post festa', 'sgrassare', 'lavare i pavimenti', 'colf'],
    flexible: true,
  },
  {
    code: 'attesa_in_casa', segment: 'casa', name_it: 'Attesa al posto tuo', name_en: 'Wait at home',
    description: 'Qualcuno aspetta a casa tua il tecnico, il corriere o il letturista, e ti manda foto e conferma.',
    params: [num('ore', 'Durata della finestra di attesa', { unit: 'ore', default: 3, min: 1, max: 10, ask: 'Quante ore dura la finestra di attesa?' })],
    proof: { kind: 'photos', photos_min: 1, gps_radius_m: 100, checklist: [yesNo('arrived', 'Il tecnico/corriere è arrivato?'), note('notes', 'Esito (cosa è stato fatto, consegnato)', true)] },
    instructions: ['Ritira le chiavi come concordato', 'Resta in casa per tutta la finestra', 'Foto della consegna / dell\'intervento concluso'],
    keywords: ['aspettare', 'attendere', 'aspetti', 'attenda', 'il tecnico', 'corriere', 'letturista', 'consegna a casa', 'ricevere il pacco', 'wait for', 'be home', 'essere a casa'],
    flexible: false,
    mentions_ok: true,
  },
  {
    code: 'commissione_acquisto', segment: 'casa', name_it: 'Commissione / acquisto', name_en: 'Errand & purchase',
    description: 'Compra un articolo in un negozio specifico e te lo porta, con scontrino. La spesa è pre-autorizzata fino al tetto indicato.',
    params: [
      text('articolo', 'Articolo', { ask: 'Cosa bisogna comprare (marca, modello, taglia)?', required: true }),
      text('negozio', 'Negozio', { ask: 'In quale negozio?' }),
      num('spesa_max_eur', 'Spesa massima', { unit: '€', min: 5, max: 1000, ask: 'Qual è il tetto di spesa?', required: true }),
    ],
    proof: { kind: 'photos', photos_min: 2, gps_radius_m: 150, checklist: [yesNo('bought', 'Articolo acquistato come richiesto?'), { id: 'spesa_eur', q: 'Importo dello scontrino (€)', type: 'number', required: true }] },
    instructions: ['Foto dell\'articolo in negozio prima di pagare (taglia/modello)', 'Paga entro il tetto di spesa', 'Foto dello scontrino', 'Consegna all\'indirizzo del cliente'],
    keywords: ['comprare', 'comprarmi', 'comprami', 'acquistare', 'compra ', 'prendere al negozio', 'ritirare in negozio', 'ritirare un', 'buy', 'pick up', 'commissione', 'jeans', 'regalo'],
    flexible: true,
    mentions_ok: true,
  },
  // ------------------------------------------------------------------ business
  {
    code: 'facchinaggio_allestimento', segment: 'business', name_it: 'Facchinaggio e allestimento', name_en: 'Load-in & set-up crew',
    description: 'Facchini per allestimento/disallestimento stand, carico e scarico, spostamenti in fiera o in ufficio. Turno con check-in e check-out.',
    params: [
      num('persone', 'Persone', { default: 2, min: 1, max: 30, ask: 'Quante persone servono?' }),
      bool('muletto', 'Serve patentino muletto', false),
    ],
    proof: { kind: 'timesheet', photos_min: 0, gps_radius_m: 400, checklist: [note('notes', 'Note di fine turno')] },
    instructions: ['Check-in all\'ingresso indicato con il QR/GPS', 'Scarpe antinfortunistiche obbligatorie', 'Segui il referente del cliente', 'Check-out a fine turno'],
    keywords: ['facchin', 'allestimento', 'disallestimento', 'montaggio stand', 'smontaggio stand', 'stand', 'scarico', 'carico merce', 'trasloco', 'traslochi', 'movers', 'load-in'],
    flexible: false, multi_seat: true,
  },
  {
    code: 'staff_eventi', segment: 'business', name_it: 'Staff eventi', name_en: 'Event staff',
    description: 'Hostess, steward, runner e guardaroba per eventi, fiere e congressi. Turno con check-in e check-out.',
    params: [
      num('persone', 'Persone', { default: 2, min: 1, max: 40, ask: 'Quante persone servono?' }),
      oneOf('ruolo', 'Ruolo', [{ v: 'hostess', label: 'Hostess / accoglienza' }, { v: 'steward', label: 'Steward' }, { v: 'runner', label: 'Runner' }, { v: 'guardaroba', label: 'Guardaroba' }], 'hostess'),
      bool('inglese', 'Inglese fluente', false),
    ],
    proof: { kind: 'timesheet', photos_min: 0, gps_radius_m: 400, checklist: [note('notes', 'Note di fine turno')] },
    instructions: ['Check-in al desk staff', 'Dress code: nero, scarpe comode', 'Check-out a fine turno'],
    keywords: ['hostess', 'steward', 'accoglienza', 'promoter', 'runner', 'guardaroba', 'staff per', 'personale per l\'evento', 'event staff'],
    flexible: false, multi_seat: true,
  },
  {
    code: 'turnover_affitti', segment: 'business', name_it: 'Turnover affitti brevi', name_en: 'Short-let turnover',
    description: 'Pulizia tra un ospite e l\'altro, cambio biancheria, rifornimento consumabili ed eventuale check-in.',
    params: [
      num('area_m2', 'Superficie', { unit: 'm²', default: 55, min: 20, max: 300, ask: 'Quanti m² è l\'appartamento?' }),
      bool('biancheria', 'Cambio biancheria', true),
      bool('check_in', 'Accoglienza ospite (check-in)', false),
    ],
    proof: { kind: 'photos', photos_min: 6, gps_radius_m: 150, checklist: [yesNo('ready', 'Appartamento pronto per il nuovo ospite?'), yesNo('damages', 'Danni rilevati?'), note('notes', 'Consumabili mancanti / note')] },
    instructions: ['Foto dello stato all\'arrivo', 'Pulizia completa, bagno e cucina a fondo', 'Letti rifatti con biancheria pulita', 'Foto di ogni stanza pronta'],
    keywords: ['airbnb', 'affitto breve', 'affitti brevi', 'turnover', 'cambio biancheria', 'check-in', 'check in', 'ospiti in arrivo', 'booking', 'short let', 'host'],
    flexible: true,
  },
  {
    code: 'sopralluogo_foto', segment: 'business', name_it: 'Sopralluogo fotografico', name_en: 'Photo inspection',
    description: 'Verifica di un immobile o di un sinistro con foto geolocalizzate e report strutturato.',
    params: [oneOf('scopo', 'Scopo', [{ v: 'annuncio', label: 'Verifica annuncio' }, { v: 'sinistro', label: 'Sinistro / danni' }, { v: 'stato', label: 'Stato dell\'immobile' }], 'stato')],
    proof: { kind: 'photos', photos_min: 6, gps_radius_m: 150, checklist: [yesNo('exists', 'L\'immobile corrisponde all\'indirizzo?'), note('findings', 'Rilievi', true)] },
    instructions: ['Foto della facciata e del civico', 'Foto di ogni stanza / del danno da 2 angolazioni', 'Compila i rilievi'],
    keywords: ['sopralluogo', 'perizia', 'sinistro', 'danni', 'immobile', 'appartamento da verificare', 'inspection'],
    flexible: true,
  },
  {
    code: 'verifica_punto_vendita', segment: 'business', name_it: 'Verifica punto vendita', name_en: 'Retail check',
    description: 'Presenza a scaffale, vetrine, prezzi e materiali promozionali, con foto geolocalizzate.',
    params: [num('punti_vendita', 'Punti vendita', { default: 1, min: 1, max: 20 })],
    proof: { kind: 'photos', photos_min: 3, gps_radius_m: 250, checklist: [yesNo('on_shelf', 'Prodotto/materiale presente?'), note('notes', 'Rilievi')] },
    instructions: ['Foto del lineare o della vetrina', 'Foto del cartellino prezzo', 'Compila i rilievi'],
    keywords: ['scaffal', 'vetrina', 'planogram', 'punto vendita', 'retail audit', 'materiali promozionali'],
    flexible: true,
  },
];

// ---- price & duration formulas (fixed price: the platform quotes, nobody haggles)
const P = {
  giardinaggio: (p) => ({
    lines: [
      ['Uscita squadra', 3000],
      [`Prato ${p.area_m2} m²`, Math.round(p.area_m2 * 25)],
      p.siepi && ['Siepi', 3500],
      p.foglie && ['Raccolta foglie', 1500],
      p.smaltimento && ['Smaltimento verde', 1200],
    ],
    minutes: 45 + Math.round(p.area_m2 * 0.6) + (p.siepi ? 60 : 0) + (p.foglie ? 30 : 0),
  }),
  montaggio_mobili: (p) => {
    const unit = { piccolo: 2500, medio: 4500, grande: 8500 }[p.taglia] ?? 4500;
    const mins = { piccolo: 30, medio: 60, grande: 120 }[p.taglia] ?? 60;
    return {
      lines: [[`${p.pezzi} × mobile ${p.taglia}`, unit * p.pezzi], p.fissaggio_muro && ['Fissaggio a muro', 1500 * p.pezzi]],
      minutes: 15 + mins * p.pezzi + (p.fissaggio_muro ? 15 * p.pezzi : 0),
    };
  },
  tuttofare: (p) => ({
    lines: [['Uscita', 2500], [`${p.interventi} interventi`, 1500 * p.interventi], p.materiale && ['Materiale di consumo', 1000]],
    minutes: 30 + 25 * p.interventi,
  }),
  pulizie_casa: (p) => {
    const per = { standard: 1.1, fondo: 1.8, post_festa: 2.0 }[p.tipo] ?? 1.1;
    const minutes = Math.max(120, Math.round(p.area_m2 * per));
    return { lines: [[`Pulizia ${p.tipo.replace('_', ' ')} · ${Math.round(minutes / 6) / 10} h`, Math.round((minutes / 60) * 2200)]], minutes };
  },
  attesa_in_casa: (p) => ({ lines: [[`Attesa ${p.ore} h`, Math.max(2, p.ore) * 1500]], minutes: p.ore * 60 }),
  commissione_acquisto: (p) => ({
    lines: [['Commissione e consegna', 2200]],
    minutes: 90,
    hold: Math.round((p.spesa_max_eur ?? 0) * 100),
  }),
  facchinaggio_allestimento: (p, ctx) => {
    const hours = ctx.minutes / 60;
    return { lines: [[`${p.persone} facchini × ${hours} h`, Math.round(p.persone * hours * (p.muletto ? 2300 : 1900))]], minutes: ctx.minutes };
  },
  staff_eventi: (p, ctx) => {
    const hours = ctx.minutes / 60;
    const rate = { hostess: 2100, steward: 1900, runner: 1700, guardaroba: 1700 }[p.ruolo] ?? 2000;
    return { lines: [[`${p.persone} × ${p.ruolo} × ${hours} h`, Math.round(p.persone * hours * (rate + (p.inglese ? 300 : 0)))]], minutes: ctx.minutes };
  },
  turnover_affitti: (p) => ({
    lines: [[`Pulizia ${p.area_m2} m²`, 2500 + Math.round(p.area_m2 * 30)], p.biancheria && ['Cambio biancheria', 1500], p.check_in && ['Check-in ospite', 2000]],
    minutes: 60 + Math.round(p.area_m2 * 1.2) + (p.check_in ? 30 : 0),
  }),
  sopralluogo_foto: () => ({ lines: [['Sopralluogo e report', 4500]], minutes: 60 }),
  verifica_punto_vendita: (p) => ({ lines: [[`${p.punti_vendita} punti vendita`, 1600 * p.punti_vendita]], minutes: 25 * p.punti_vendita }),
};

export function formula(code) {
  return P[code] ?? ((p, ctx) => ({ lines: [['Servizio', Math.round((ctx.minutes / 60) * 2000)]], minutes: ctx.minutes || 60 }));
}

export function listServices() {
  return all('SELECT * FROM services ORDER BY segment, code');
}

export function getService(code) {
  return get('SELECT * FROM services WHERE code = ?', code);
}

// Fill defaults and coerce types; returns { params, assumed: [keys], missing: [param] }
export function normalizeParams(service, input = {}) {
  const params = {};
  const assumed = [];
  const missing = [];
  for (const f of service.params) {
    let v = input[f.key];
    if (v === '' || v === undefined || v === null) v = undefined;
    if (f.type === 'number' && v !== undefined) v = Number(String(v).replace(',', '.'));
    if (f.type === 'bool' && v !== undefined) v = v === true || v === 'true' || v === 1 || v === '1' || v === 'yes';
    if (f.type === 'enum' && v !== undefined && !f.options.some((o) => o.v === v)) v = undefined;
    if (f.type === 'number' && v !== undefined && (Number.isNaN(v) || (f.min != null && v < f.min) || (f.max != null && v > f.max))) v = undefined;
    if (v === undefined) {
      if (f.default !== undefined) { v = f.default; if (f.ask) assumed.push(f.key); } else if (f.required) missing.push(f);
    }
    if (v !== undefined) params[f.key] = v;
  }
  return { params, assumed, missing };
}
