// Milano seed data: 14 workers (people + businesses) with varied skills,
// distances and reliability histories. Giulia R. near the Duomo is the clear
// top-ranked field worker for the happy path.
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { db, openDb, insert, setSetting, get } from './db.js';
import { SKILL_SEED } from './skills.js';
import { enforce } from './reliability.js';
import { token } from './util.js';

export const DEMO_API_KEY = 'ak_demo_milano';
export const CONSOLE_ACCOUNT = 'acc_console';

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

// n star ratings averaging ~avg (deterministic)
function starHistory(n, avg, rnd) {
  const stars = Array(n).fill(5);
  let sum = 5 * n;
  const target = Math.round(avg * n);
  let guard = 0;
  while (sum > target && guard++ < 10000) {
    const i = Math.floor(rnd() * n);
    const floor = avg < 4.6 ? 1 : 3;
    if (stars[i] > floor && (stars[i] === 5 || rnd() < 0.35)) { stars[i]--; sum--; }
  }
  return stars;
}

const W = [
  // id, kind, name, zone, lat, lng, vehicle, skills, skill_jobs, avg, nRatings, offers(recv, acc), jobs(acc, done, canc, noshow), mult, cap, online, status, color, bio
  { id: 'w_giulia', kind: 'person', name: 'Giulia R.', zone: 'Brera', lat: 45.4702, lng: 9.1878, vehicle: 'bike',
    skills: ['shelf_check', 'store_photo', 'price_audit', 'presence', 'mystery_shop'],
    skill_jobs: { shelf_check: 140, store_photo: 90, price_audit: 50, presence: 20, mystery_shop: 16 },
    avg: 4.97, n: 100, offers: [340, 327], jobs: [318, 316, 2, 0], mult: 1.0, color: '#1f8a70',
    bio: 'Ex visual merchandiser. Foto nitide, sempre in orario.' },
  { id: 'w_marco', kind: 'person', name: 'Marco B.', zone: 'Porta Venezia', lat: 45.4748, lng: 9.2062, vehicle: 'scooter',
    skills: ['shelf_check', 'store_photo', 'document_pickup', 'presence'],
    skill_jobs: { shelf_check: 60, store_photo: 70, document_pickup: 50, presence: 30 },
    avg: 4.89, n: 100, offers: [240, 211], jobs: [212, 206, 4, 0], mult: 0.95, color: '#3b5bdb', bio: 'Scooter, zona est.' },
  { id: 'w_sara', kind: 'person', name: 'Sara M.', zone: 'Navigli', lat: 45.4525, lng: 9.1742, vehicle: 'bike',
    skills: ['store_photo', 'event_check', 'property_check', 'mystery_shop'],
    skill_jobs: { store_photo: 60, event_check: 40, property_check: 30, mystery_shop: 20 },
    avg: 4.93, n: 100, offers: [165, 150], jobs: [152, 150, 2, 0], mult: 1.05, color: '#c2255c', bio: 'Fotografa freelance.' },
  { id: 'w_ahmed', kind: 'person', name: 'Ahmed K.', zone: 'NoLo', lat: 45.4958, lng: 9.2168, vehicle: 'scooter',
    skills: ['document_pickup', 'presence', 'shelf_check'],
    skill_jobs: { document_pickup: 50, presence: 30, shelf_check: 15 },
    avg: 4.81, n: 95, offers: [120, 95], jobs: [98, 94, 4, 0], mult: 0.9, color: '#e8590c', bio: 'Disponibile anche la sera.' },
  { id: 'w_elena', kind: 'person', name: 'Elena P.', zone: 'Città Studi', lat: 45.4781, lng: 9.2262, vehicle: 'walk',
    skills: ['shelf_check', 'price_audit', 'store_photo'],
    skill_jobs: { shelf_check: 2, price_audit: 1 },
    avg: 4.67, n: 3, offers: [4, 3], jobs: [3, 3, 0, 0], mult: 0.9, color: '#7048e8', bio: 'Studentessa al Politecnico. Nuova su Aronica.' },
  { id: 'w_luca', kind: 'person', name: 'Luca F.', zone: 'CityLife', lat: 45.4776, lng: 9.1558, vehicle: 'car',
    skills: ['property_check', 'event_check', 'presence', 'document_pickup'],
    skill_jobs: { property_check: 60, event_check: 30, presence: 20, document_pickup: 10 },
    avg: 4.86, n: 100, offers: [140, 122], jobs: [122, 118, 4, 0], mult: 1.1, color: '#0c8599', bio: 'Auto, zona ovest.' },
  { id: 'w_davide', kind: 'person', name: 'Davide C.', zone: 'Porta Romana', lat: 45.4523, lng: 9.2021, vehicle: 'scooter',
    skills: ['shelf_check', 'store_photo', 'presence'],
    skill_jobs: { shelf_check: 25, store_photo: 15, presence: 3 },
    avg: 4.52, n: 40, offers: [80, 56], jobs: [50, 43, 6, 1], mult: 0.85, color: '#868e96', bio: 'Economico ma discontinuo.' },
  { id: 'w_francesca', kind: 'person', name: 'Francesca L.', zone: 'Isola', lat: 45.4872, lng: 9.1893, vehicle: 'bike',
    skills: ['shelf_check', 'store_photo'],
    skill_jobs: { shelf_check: 20, store_photo: 10 },
    avg: 4.31, n: 30, offers: [60, 40], jobs: [38, 30, 5, 3], mult: 0.9, color: '#adb5bd', bio: '' },
  { id: 'w_paolo', kind: 'person', name: 'Paolo G.', zone: 'Bicocca', lat: 45.5135, lng: 9.2105, vehicle: 'bike', online: 0,
    skills: ['shelf_check', 'price_audit'],
    skill_jobs: { shelf_check: 70, price_audit: 20 },
    avg: 4.9, n: 90, offers: [100, 92], jobs: [92, 91, 1, 0], mult: 1.0, color: '#2b8a3e', bio: 'Solo weekend.' },
  { id: 'w_tommaso', kind: 'person', name: 'Tommaso D.', zone: 'Lambrate', lat: 45.4842, lng: 9.2372, vehicle: 'bike',
    skills: ['shelf_check', 'store_photo', 'presence'],
    skill_jobs: { shelf_check: 30, store_photo: 25, presence: 15 },
    avg: 4.78, n: 70, offers: [110, 77], jobs: [72, 70, 2, 0], mult: 0.95, color: '#5c940d', bio: '' },
  { id: 'w_chiara', kind: 'person', name: 'Chiara V.', zone: 'San Siro', lat: 45.4785, lng: 9.1235, vehicle: 'scooter', online: 0,
    status: 'pending_verification', verified: 0,
    skills: ['store_photo', 'shelf_check'], skill_jobs: {},
    avg: 0, n: 0, offers: [0, 0], jobs: [0, 0, 0, 0], mult: 1.0, color: '#d6336c', bio: 'Registrata ieri, documento in verifica.' },
  { id: 'b_fotopunto', kind: 'business', name: 'FotoPunto Srl', legal: 'FotoPunto S.r.l.', vat: 'IT09876543210', zone: 'Via Tortona', lat: 45.4538, lng: 9.1668, vehicle: 'car', capacity: 3,
    skills: ['store_photo', 'event_check', 'property_check'],
    skill_jobs: { store_photo: 220, event_check: 120, property_check: 60 },
    avg: 4.91, n: 100, offers: [460, 410], jobs: [410, 402, 8, 0], mult: 1.3, color: '#111111', bio: 'Studio fotografico, 3 operatori in città.' },
  { id: 'b_pony', kind: 'business', name: 'Rapido Pony Express', legal: 'Rapido Pony Express Soc. Coop.', vat: 'IT01234567890', zone: 'Stazione Centrale', lat: 45.4858, lng: 9.2041, vehicle: 'scooter', capacity: 5,
    skills: ['document_pickup', 'presence'],
    skill_jobs: { document_pickup: 600, presence: 200 },
    avg: 4.84, n: 100, offers: [900, 820], jobs: [820, 800, 20, 0], mult: 1.0, color: '#f08c00', bio: 'Cooperativa di pony express, 5 rider attivi.' },
  { id: 'b_rilievi', kind: 'business', name: 'Studio Rilievi Navigli', legal: 'Studio Rilievi Navigli di A. Conti', vat: 'IT04567890123', zone: 'Porta Genova', lat: 45.4538, lng: 9.1708, vehicle: 'car', capacity: 2,
    skills: ['property_check', 'mystery_shop'],
    skill_jobs: { property_check: 45, mystery_shop: 15 },
    avg: 4.95, n: 60, offers: [70, 62], jobs: [62, 61, 1, 0], mult: 1.4, color: '#364fc7', bio: 'Geometri: sopralluoghi con report.' },
];

export function seed({ reset = false } = {}) {
  if (reset) {
    for (const t of ['events', 'offers', 'quotes', 'jobs', 'ratings', 'workers', 'accounts', 'skills', 'settings']) db.exec(`DELETE FROM ${t}`);
  }
  if (get('SELECT COUNT(*) AS c FROM workers').c > 0) return false;
  const now = Date.now();
  for (const s of SKILL_SEED) insert('skills', s);
  insert('accounts', { id: 'acc_demo_agent', name: 'Demo Buyer Agent', kind: 'agent', api_key: DEMO_API_KEY, created_at: now });
  insert('accounts', { id: CONSOLE_ACCOUNT, name: 'Aronica Console', kind: 'console', api_key: null, created_at: now });
  setSetting('offer_ttl_s', 20);
  setSetting('simulate_workers', true);
  setSetting('sim_speedup', 30);

  const rnd = prng(42);
  for (const w of W) {
    insert('workers', {
      id: w.id, kind: w.kind, display_name: w.name, legal_name: w.legal ?? null, vat_id: w.vat ?? null, bio: w.bio,
      city: 'milano', zone: w.zone, lat: w.lat, lng: w.lng, vehicle: w.vehicle, skills: w.skills, skill_jobs: w.skill_jobs,
      rate_multiplier: w.mult, capacity: w.capacity ?? 1, online: w.online ?? 1, verified: w.verified ?? 1,
      verification_note: (w.verified ?? 1) ? (w.kind === 'business' ? 'Visura camerale + P.IVA verificate' : 'Documento d\'identità + selfie verificati') : null,
      status: w.status ?? 'active', tier: 'good', tier_reasons: [],
      offers_received: w.offers[0], offers_accepted: w.offers[1], offers_declined: Math.round((w.offers[0] - w.offers[1]) * 0.6),
      offers_expired: Math.round((w.offers[0] - w.offers[1]) * 0.4),
      jobs_accepted: w.jobs[0], jobs_completed: w.jobs[1], jobs_cancelled: w.jobs[2], no_shows: w.jobs[3],
      earnings_cents: w.jobs[1] * 1700, avatar_color: w.color, simulated: 1, token: token(), joined_at: now - 200 * 86400000,
    });
    const stars = starHistory(w.n, w.avg, rnd);
    stars.forEach((s, i) => insert('ratings', {
      id: `r_seed_${w.id}_${i}`, job_id: null, worker_id: w.id, stars: s, tags: [], comment: null, excluded: 0,
      created_at: now - Math.round((i + 1) * (180 * 86400000) / (w.n + 1)),
    }));
    enforce(w.id);
  }
  return true;
}

// `npm run seed` → wipe and reseed
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.env.ARONICA_DB || 'data/aronica.db';
  if (process.argv.includes('--reset')) {
    rmSync('data/uploads', { recursive: true, force: true });
  }
  openDb(path);
  seed({ reset: process.argv.includes('--reset') });
  console.log(`Seeded ${get('SELECT COUNT(*) AS c FROM workers').c} workers into ${path}. Demo API key: ${DEMO_API_KEY}`);
}
