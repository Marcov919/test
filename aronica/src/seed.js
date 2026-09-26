// Milano seed data (v1.1): local people and small businesses that unblock a
// private person's day (car wash, waiting at home, errands, IKEA), plus the
// experimental business-staffing supply. Weekly availability and reliability
// histories are seeded; there is deliberately zero supply for lessons/lifestyle.
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { db, openDb, insert, setSetting, get } from './db.js';
import { SERVICE_SEED } from './services.js';
import { enforce } from './reliability.js';
import { token } from './util.js';

export const DEMO_API_KEY = 'ak_demo_milano';
export const DEMO_BUSINESS_KEY = 'ak_demo_business';
export const CONSOLE_ACCOUNT = 'acc_console';
export const CONSOLE_BUSINESS_ACCOUNT = 'acc_console_biz';
export const SEED_VERSION = 3; // bump to reseed databases created by older versions

const ORG = {
  legal_name: 'Aurora Eventi & Hospitality Srl', vat_id: 'IT11223344556', sdi: 'M5UXCR1', employees: 8,
  auto_approve_max_cents: 60000, // policy: under €600 the company agent books without a human tap
};

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function starHistory(n, avg, rnd) {
  const stars = Array(n).fill(5);
  let sum = 5 * n;
  const target = Math.round(avg * n);
  for (let guard = 0; sum > target && guard < 10000; guard++) {
    const i = Math.floor(rnd() * n);
    const floor = avg < 4.6 ? 1 : 3;
    if (stars[i] > floor && (stars[i] === 5 || rnd() < 0.35)) { stars[i]--; sum--; }
  }
  return stars;
}

// weekly availability: days (0=Sun..6=Sat) × [fromHour, toHour]
const avail = (days, from, to) => Object.fromEntries(days.map((d) => [d, [[from * 60, to * 60]]]));
const WEEK = [1, 2, 3, 4, 5];
const MON_SAT = [1, 2, 3, 4, 5, 6];
const ALL = [0, 1, 2, 3, 4, 5, 6];

const W = [
  { id: 'b_washgo', kind: 'business', name: 'Wash&Go Navigli Snc', legal: 'Wash&Go Navigli di Ferri e Colombo Snc', vat: 'IT08811223344', zone: 'Navigli', lat: 45.4508, lng: 9.1762, vehicle: 'car', capacity: 3,
    skills: ['lavaggio_auto'], skill_jobs: { lavaggio_auto: 640 },
    availability: avail(MON_SAT, 8, 19), min_hourly: 1800, avg: 4.95, n: 100, offers: [700, 668], jobs: [668, 662, 6, 0], color: '#0b7285', insured: 1,
    notes: { lavaggio_auto: 'Autista viene a prendere l\'auto, lavaggio a mano in sede (Alzaia Naviglio Grande), riconsegna nello stesso punto.' },
    bio: 'Autolavaggio a mano sui Navigli. Ritiro e riconsegna con autista assicurato. Lun–sab 8–19.' },
  { id: 'b_autospa', kind: 'business', name: 'AutoSpa Porta Romana Srl', legal: 'AutoSpa Porta Romana Srl', vat: 'IT09900112233', zone: 'Porta Romana', lat: 45.4508, lng: 9.2048, vehicle: 'car', capacity: 2,
    skills: ['lavaggio_auto'], skill_jobs: { lavaggio_auto: 310 },
    availability: avail(ALL, 8, 20), min_hourly: 2000, avg: 4.78, n: 100, offers: [380, 330], jobs: [330, 322, 8, 0], color: '#5f3dc4', insured: 1,
    notes: { lavaggio_auto: 'Ritiro con autista, lavaggio e igienizzazione in sede, riconsegna.' },
    bio: 'Car care e igienizzazione interni. Aperto anche la domenica.' },
  { id: 'w_giulia', kind: 'person', name: 'Giulia R.', zone: 'Brera', lat: 45.4702, lng: 9.1878, vehicle: 'bike',
    skills: ['tuttofare', 'montaggio_mobili', 'attesa_in_casa', 'ritiro_consegna', 'commissione_acquisto', 'staff_eventi'],
    skill_jobs: { tuttofare: 120, montaggio_mobili: 90, attesa_in_casa: 40, ritiro_consegna: 60, commissione_acquisto: 35, staff_eventi: 20 },
    availability: avail(MON_SAT, 8, 20), min_hourly: 1200, avg: 4.97, n: 100, offers: [340, 327], jobs: [318, 316, 2, 0], color: '#1f8a70', insured: 1,
    bio: 'Tuttofare con attrezzi propri. Montaggi IKEA in metà tempo.' },
  { id: 'b_verde', kind: 'business', name: 'Verde Navigli Snc', legal: 'Verde Navigli di Conti e Bassi Snc', vat: 'IT07788990011', zone: 'Navigli', lat: 45.4522, lng: 9.1735, vehicle: 'car', capacity: 3,
    skills: ['giardinaggio', 'tuttofare'], skill_jobs: { giardinaggio: 410, tuttofare: 60 },
    availability: avail(MON_SAT, 7, 18), min_hourly: 1800, avg: 4.93, n: 100, offers: [460, 420], jobs: [420, 414, 6, 0], color: '#2b8a3e', insured: 1,
    bio: 'Giardinieri dal 1998. Furgone, decespugliatori, smaltimento verde autorizzato.' },
  { id: 'w_luca', kind: 'person', name: 'Luca F.', zone: 'CityLife', lat: 45.4776, lng: 9.1558, vehicle: 'car',
    skills: ['lavaggio_auto', 'montaggio_mobili', 'giardinaggio', 'facchinaggio_allestimento'], skill_jobs: { lavaggio_auto: 180, montaggio_mobili: 60, giardinaggio: 45, facchinaggio_allestimento: 30 },
    availability: avail([2, 3, 4, 5, 6, 0], 8, 18), min_hourly: 1500, avg: 4.86, n: 100, offers: [140, 122], jobs: [122, 118, 4, 0], color: '#0c8599',
    notes: { lavaggio_auto: 'Vengo io con il carrello mobile (acqua e corrente autonomi): lavaggio sotto casa, l\'auto non si sposta.' },
    bio: 'Lavaggio auto a domicilio con carrello mobile. Anche montaggi, patentino muletto.' },
  { id: 'w_ahmed', kind: 'person', name: 'Ahmed K.', zone: 'NoLo', lat: 45.4958, lng: 9.2168, vehicle: 'scooter',
    skills: ['ritiro_consegna', 'attesa_in_casa', 'commissione_acquisto', 'facchinaggio_allestimento', 'montaggio_mobili'], skill_jobs: { ritiro_consegna: 140, attesa_in_casa: 30, commissione_acquisto: 25, facchinaggio_allestimento: 70, montaggio_mobili: 20 },
    availability: avail(ALL, 6, 22), min_hourly: 1100, avg: 4.81, n: 95, offers: [120, 95], jobs: [98, 94, 4, 0], color: '#e8590c', bio: 'Disponibile anche la sera e nel weekend.' },
  { id: 'w_sara', kind: 'person', name: 'Sara M.', zone: 'Navigli', lat: 45.4525, lng: 9.1742, vehicle: 'bike',
    skills: ['attesa_in_casa', 'ritiro_consegna', 'staff_eventi'], skill_jobs: { attesa_in_casa: 85, ritiro_consegna: 70, staff_eventi: 140 },
    availability: avail([3, 4, 5, 6, 0], 8, 23), min_hourly: 1300, avg: 4.93, n: 100, offers: [165, 150], jobs: [152, 150, 2, 0], color: '#c2255c', bio: 'Studentessa ai Navigli: attese a casa, ritiri in zona, qualche evento.' },
  { id: 'w_marco', kind: 'person', name: 'Marco B.', zone: 'Porta Venezia', lat: 45.4748, lng: 9.2062, vehicle: 'scooter',
    skills: ['facchinaggio_allestimento', 'staff_eventi', 'attesa_in_casa'], skill_jobs: { facchinaggio_allestimento: 110, staff_eventi: 60, attesa_in_casa: 15 },
    availability: avail(MON_SAT, 6, 20), min_hourly: 1200, avg: 4.89, n: 100, offers: [240, 211], jobs: [212, 206, 4, 0], color: '#3b5bdb', bio: 'Allestimenti fieristici da 5 anni.' },
  { id: 'w_nadia', kind: 'person', name: 'Nadia L.', zone: 'Portello', lat: 45.4815, lng: 9.1525, vehicle: 'walk',
    skills: ['staff_eventi', 'turnover_affitti'], skill_jobs: { staff_eventi: 90, turnover_affitti: 40 },
    availability: avail(ALL, 8, 22), min_hourly: 1300, avg: 4.9, n: 90, offers: [120, 108], jobs: [108, 106, 2, 0], color: '#9c36b5', bio: 'Accoglienza al MiCo e check-in per host.' },
  { id: 'w_elena', kind: 'person', name: 'Elena P.', zone: 'Città Studi', lat: 45.4781, lng: 9.2262, vehicle: 'walk',
    skills: ['pulizie_casa', 'turnover_affitti', 'attesa_in_casa'], skill_jobs: { pulizie_casa: 2, turnover_affitti: 1 },
    availability: avail(WEEK, 9, 18), min_hourly: 1100, avg: 4.67, n: 3, offers: [4, 3], jobs: [3, 3, 0, 0], color: '#7048e8', bio: 'Nuova su Aronica.' },
  { id: 'b_pulito', kind: 'business', name: 'Pulito Brera Coop', legal: 'Pulito Brera Soc. Coop.', vat: 'IT05566778899', zone: 'Brera', lat: 45.4731, lng: 9.1858, vehicle: 'car', capacity: 4,
    skills: ['pulizie_casa', 'turnover_affitti'], skill_jobs: { pulizie_casa: 380, turnover_affitti: 520 },
    availability: avail(ALL, 7, 21), min_hourly: 1500, avg: 4.9, n: 100, offers: [620, 560], jobs: [560, 552, 8, 0], color: '#1971c2', insured: 1,
    bio: 'Cooperativa di pulizie, 12 operatori. Specialisti turnover Airbnb.' },
  { id: 'b_rhostaff', kind: 'business', name: 'Rho Staff Service Srl', legal: 'Rho Staff Service Srl', vat: 'IT09988776655', zone: 'Fiera Milano Rho', lat: 45.5185, lng: 9.0905, vehicle: 'car', capacity: 6,
    skills: ['staff_eventi', 'facchinaggio_allestimento'], skill_jobs: { staff_eventi: 300, facchinaggio_allestimento: 450 },
    availability: avail(ALL, 6, 23), min_hourly: 1500, avg: 4.84, n: 100, offers: [900, 820], jobs: [820, 800, 20, 0], color: '#f08c00', insured: 1,
    bio: 'Squadre per fiere ed eventi, a 5 minuti dai padiglioni.' },
  { id: 'w_kevin', kind: 'person', name: 'Kevin O.', zone: 'Rho', lat: 45.5275, lng: 9.0405, vehicle: 'bike',
    skills: ['facchinaggio_allestimento'], skill_jobs: { facchinaggio_allestimento: 60 },
    availability: avail(MON_SAT, 6, 20), min_hourly: 1200, avg: 4.72, n: 60, offers: [90, 70], jobs: [70, 67, 3, 0], color: '#495057', bio: '' },
  { id: 'w_tommaso', kind: 'person', name: 'Tommaso D.', zone: 'Lambrate', lat: 45.4842, lng: 9.2372, vehicle: 'bike',
    skills: ['facchinaggio_allestimento', 'staff_eventi', 'montaggio_mobili'], skill_jobs: { facchinaggio_allestimento: 30, staff_eventi: 25, montaggio_mobili: 15 },
    availability: avail(ALL, 7, 20), min_hourly: 1200, avg: 4.78, n: 70, offers: [110, 77], jobs: [72, 70, 2, 0], color: '#5c940d', bio: '' },
  { id: 'w_davide', kind: 'person', name: 'Davide C.', zone: 'Porta Romana', lat: 45.4523, lng: 9.2021, vehicle: 'scooter',
    skills: ['facchinaggio_allestimento', 'montaggio_mobili', 'attesa_in_casa'], skill_jobs: { facchinaggio_allestimento: 25, montaggio_mobili: 15, attesa_in_casa: 3 },
    availability: avail(ALL, 7, 21), min_hourly: 900, avg: 4.52, n: 40, offers: [80, 56], jobs: [50, 43, 6, 1], color: '#868e96', bio: 'Economico ma discontinuo.' },
  { id: 'w_francesca', kind: 'person', name: 'Francesca L.', zone: 'Isola', lat: 45.4872, lng: 9.1893, vehicle: 'bike',
    skills: ['staff_eventi', 'pulizie_casa'], skill_jobs: { staff_eventi: 20, pulizie_casa: 10 },
    availability: avail(ALL, 8, 20), min_hourly: 1000, avg: 4.31, n: 30, offers: [60, 40], jobs: [38, 30, 5, 3], color: '#adb5bd', bio: '' },
  { id: 'w_paolo', kind: 'person', name: 'Paolo G.', zone: 'Bicocca', lat: 45.5135, lng: 9.2105, vehicle: 'car', online: 0,
    skills: ['giardinaggio', 'tuttofare'], skill_jobs: { giardinaggio: 70, tuttofare: 20 },
    availability: avail([6, 0], 8, 17), min_hourly: 1600, avg: 4.9, n: 90, offers: [100, 92], jobs: [92, 91, 1, 0], color: '#2f9e44', bio: 'Solo weekend.' },
  { id: 'w_chiara', kind: 'person', name: 'Chiara V.', zone: 'San Siro', lat: 45.4785, lng: 9.1235, vehicle: 'scooter', online: 0,
    status: 'pending_verification', verified: 0, skills: ['staff_eventi'], skill_jobs: {},
    availability: avail(ALL, 8, 22), min_hourly: 1300, avg: 0, n: 0, offers: [0, 0], jobs: [0, 0, 0, 0], color: '#d6336c', bio: 'Registrata ieri, documento in verifica.' },
];

export function seed({ reset = false } = {}) {
  if (reset) {
    for (const t of ['events', 'offers', 'quotes', 'assignments', 'jobs', 'ratings', 'workers', 'accounts', 'services', 'settings']) db.exec(`DELETE FROM ${t}`);
  }
  let version = 0;
  try { version = Number(get("SELECT value FROM settings WHERE key = 'seed_version'")?.value ?? 0); } catch { /* */ }
  if (!reset && version !== SEED_VERSION && get('SELECT COUNT(*) AS c FROM workers').c > 0) return seed({ reset: true });
  if (get('SELECT COUNT(*) AS c FROM workers').c > 0) return false;
  const now = Date.now();
  for (const s of SERVICE_SEED) {
    insert('services', {
      code: s.code, segment: s.segment, name_it: s.name_it, name_en: s.name_en, description: s.description,
      params: s.params, proof: s.proof, instructions: s.instructions, keywords: s.keywords,
      flexible: s.flexible ? 1 : 0, multi_seat: s.multi_seat ? 1 : 0, mentions_ok: s.mentions_ok ? 1 : 0,
    });
  }
  insert('accounts', { id: 'acc_demo_agent', name: 'Assistente personale (demo)', kind: 'consumer', api_key: DEMO_API_KEY, org: null, created_at: now });
  insert('accounts', { id: 'acc_demo_business', name: 'Agente di Aurora Eventi (demo)', kind: 'business', api_key: DEMO_BUSINESS_KEY, org: ORG, created_at: now });
  insert('accounts', { id: CONSOLE_ACCOUNT, name: 'Privato', kind: 'consumer', api_key: null, org: null, created_at: now });
  insert('accounts', { id: CONSOLE_BUSINESS_ACCOUNT, name: 'Aurora Eventi', kind: 'business', api_key: null, org: ORG, created_at: now });
  setSetting('seed_version', SEED_VERSION);
  setSetting('offer_ttl_s', 20);
  setSetting('simulate_workers', true);
  setSetting('sim_speedup', 30);

  const rnd = prng(42);
  for (const w of W) {
    insert('workers', {
      id: w.id, kind: w.kind, display_name: w.name, legal_name: w.legal ?? null, vat_id: w.vat ?? null, bio: w.bio,
      city: 'milano', zone: w.zone, lat: w.lat, lng: w.lng, vehicle: w.vehicle, skills: w.skills, skill_jobs: w.skill_jobs,
      availability: w.availability, min_hourly_cents: w.min_hourly, capacity: w.capacity ?? 1, insured: w.insured ?? 0,
      online: w.online ?? 1, verified: w.verified ?? 1,
      verification_note: (w.verified ?? 1) ? (w.kind === 'business' ? 'Visura camerale, P.IVA e RC professionale verificate' : 'Documento d\'identità + selfie verificati') : null,
      status: w.status ?? 'active', tier: 'good', tier_reasons: [],
      offers_received: w.offers[0], offers_accepted: w.offers[1], offers_declined: Math.round((w.offers[0] - w.offers[1]) * 0.6),
      offers_expired: Math.round((w.offers[0] - w.offers[1]) * 0.4),
      jobs_accepted: w.jobs[0], jobs_completed: w.jobs[1], jobs_cancelled: w.jobs[2], no_shows: w.jobs[3],
      earnings_cents: w.jobs[1] * 4200, avatar_color: w.color, service_notes: w.notes ?? {}, simulated: 1, token: token(), joined_at: now - 200 * 86400000,
    });
    starHistory(w.n, w.avg, rnd).forEach((s, i) => insert('ratings', {
      id: `r_seed_${w.id}_${i}`, job_id: null, worker_id: w.id, stars: s, tags: [], comment: null, excluded: 0,
      created_at: now - Math.round((i + 1) * (180 * 86400000) / (w.n + 1)),
    }));
    enforce(w.id);
  }
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.env.ARONICA_DB || 'data/aronica.db';
  if (process.argv.includes('--reset')) rmSync('data/uploads', { recursive: true, force: true });
  openDb(path);
  seed({ reset: process.argv.includes('--reset') });
  console.log(`Seeded ${get('SELECT COUNT(*) AS c FROM workers').c} partners into ${path}. API keys: ${DEMO_API_KEY} (consumer), ${DEMO_BUSINESS_KEY} (business)`);
}
