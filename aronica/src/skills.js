// Aronica v1 skill taxonomy: structured field proof that buyers already budget for.
// Anything outside this table fails closed (no "capoeira teacher", nails, dentist...).
import { all, get } from './db.js';

const yesNo = (id, q) => ({ id, q, type: 'yes_no', required: true });
const num = (id, q, required = true) => ({ id, q, type: 'number', required });
const text = (id, q, required = false) => ({ id, q, type: 'text', required });

export const SKILL_SEED = [
  {
    code: 'shelf_check', name_it: 'Verifica scaffale', name_en: 'Shelf check',
    description: 'Verify a product is really on shelf: presence, facings, price tag, photos of the bay.',
    base_price_cents: 1500, typical_minutes: 20,
    default_proof: { photos_min: 3, gps_required: true, gps_radius_m: 250, checklist: [
      yesNo('on_shelf', 'Il prodotto è presente a scaffale?'),
      num('facings', 'Numero di facing visibili'),
      num('price_eur', 'Prezzo esposto (€)', false),
    ] },
    keywords: ['scaffal', 'shelf', 'planogram', 'facing', 'out of stock', 'fuori stock', 'lineare', 'on shelf', 'in stock', 'a scaffale', 'display', 'espositore', 'stock check'],
  },
  {
    code: 'store_photo', name_it: 'Foto punto vendita', name_en: 'Store photo',
    description: 'Geotagged photos of a store, storefront, window display or signage.',
    base_price_cents: 1200, typical_minutes: 15,
    default_proof: { photos_min: 4, gps_required: true, gps_radius_m: 200, checklist: [
      yesNo('open', 'Il punto vendita è aperto?'),
      yesNo('signage', 'Insegna visibile e integra?'),
    ] },
    keywords: ['storefront', 'vetrina', 'insegna', 'photo the store', 'photograph the store', 'foto del negozio', 'foto negozio', 'foto punto vendita', 'punto vendita', 'shop front', 'store photo', 'photo of the store', 'picture of the store', 'foto della vetrina', 'is the store open', 'negozio aperto', 'window display'],
  },
  {
    code: 'price_audit', name_it: 'Rilevazione prezzi', name_en: 'Price audit',
    description: 'Record shelf prices and promotions for a list of SKUs.',
    base_price_cents: 1800, typical_minutes: 30,
    default_proof: { photos_min: 2, gps_required: true, gps_radius_m: 250, checklist: [
      text('prices', 'Prezzi rilevati (SKU: prezzo)', true),
      yesNo('promo', 'Promozioni attive in corsia?'),
    ] },
    keywords: ['price check', 'price audit', 'check prices', 'check the price', 'rilevazione prezz', 'rilevare i prezz', 'rilevare prezz', 'controllare i prezzi', 'controlla i prezzi', 'prezzi a scaffale', 'shelf price', 'competitor price', 'volantino', 'promo in store', 'promozioni in corsia'],
  },
  {
    code: 'presence', name_it: 'Presenza sul posto', name_en: 'On-site presence',
    description: 'Be physically at a place at a given time: wait for a delivery, hold a spot in a queue, meet someone, confirm something is happening.',
    base_price_cents: 2000, typical_minutes: 60,
    default_proof: { photos_min: 1, gps_required: true, gps_radius_m: 150, checklist: [
      yesNo('on_time', 'Sei arrivato entro l\'orario richiesto?'),
      text('notes', 'Note sull\'esito'),
    ] },
    keywords: ['be there', 'essere li', 'essere presente', 'presenza', 'on site', 'sul posto', 'queue', 'in fila', 'fare la fila', 'wait for', 'aspettare', 'attendere', 'meet the', 'incontrare', 'hold a spot', 'tenere il posto', 'ricevere la consegna', 'receive the delivery', 'accept a delivery', 'show up'],
  },
  {
    code: 'property_check', name_it: 'Sopralluogo immobile', name_en: 'Property check',
    description: 'Verify an apartment/office is real and matches the listing; photos of every room and the building.',
    base_price_cents: 3500, typical_minutes: 45,
    default_proof: { photos_min: 6, gps_required: true, gps_radius_m: 150, checklist: [
      yesNo('exists', 'L\'immobile esiste all\'indirizzo indicato?'),
      yesNo('matches_listing', 'Corrisponde all\'annuncio?'),
      text('issues', 'Problemi riscontrati'),
    ] },
    keywords: ['apartment', 'appartamento', 'immobile', 'flat viewing', 'sopralluogo', 'property', 'listing', 'annuncio', 'affitto', 'rental', 'is this apartment real', 'casa in affitto', 'ufficio in affitto', 'viewing'],
  },
  {
    code: 'document_pickup', name_it: 'Ritiro e consegna documenti', name_en: 'Document pickup & drop',
    description: 'Pick up an envelope/document and hand it over with signature photo.',
    base_price_cents: 1600, typical_minutes: 40,
    default_proof: { photos_min: 2, gps_required: true, gps_radius_m: 200, checklist: [
      text('recipient', 'Nome di chi ha ricevuto', true),
      yesNo('sealed', 'Busta integra alla consegna?'),
    ] },
    keywords: ['document', 'documento', 'documenti', 'envelope', 'busta', 'plico', 'pick up the', 'ritirare', 'ritiro', 'deliver the', 'consegnare', 'consegna a mano', 'hand deliver', 'firma', 'signature'],
  },
  {
    code: 'mystery_shop', name_it: 'Mystery shopping', name_en: 'Mystery shop',
    description: 'Visit as a normal customer and score service against a checklist.',
    base_price_cents: 2800, typical_minutes: 40,
    default_proof: { photos_min: 2, gps_required: true, gps_radius_m: 200, checklist: [
      yesNo('greeted', 'Accolto entro 2 minuti?'),
      num('service_score', 'Voto servizio (1-5)'),
      text('notes', 'Note', true),
    ] },
    keywords: ['mystery', 'cliente misterioso', 'secret shopper', 'service quality', 'qualita del servizio', 'customer experience'],
  },
  {
    code: 'event_check', name_it: 'Verifica evento / installazione', name_en: 'Event / install check',
    description: 'Confirm an event, billboard, pop-up or installation is live as contracted.',
    base_price_cents: 2200, typical_minutes: 30,
    default_proof: { photos_min: 4, gps_required: true, gps_radius_m: 250, checklist: [
      yesNo('live', 'Installazione/evento presente e attivo?'),
      num('attendance', 'Stima persone presenti', false),
    ] },
    keywords: ['billboard', 'cartellone', 'affissione', 'pop-up store', 'popup store', 'installazione', 'installation', 'verifica evento', 'event check', 'is the event', 'evento e attivo', 'allestimento', 'insegna luminosa', 'digital signage', 'totem'],
  },
];

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, "").replace(/['’]/g, ' ');

export function listSkills() {
  return all('SELECT * FROM skills ORDER BY base_price_cents');
}

export function getSkill(code) {
  return get('SELECT * FROM skills WHERE code = ?', code);
}

// Lifestyle / professional services Aronica v1 deliberately does NOT do. They die
// on density; we fail closed instead of pretending ("Kill lifestyle cosplay").
export const OUT_OF_SCOPE = [
  'capoeira', 'teacher', 'insegnante', 'lezione', 'lesson', 'tutor', 'nails', 'unghie', 'manicure',
  'pedicure', 'dentist', 'dentista', 'doctor', 'medico', 'haircut', 'parrucchiere', 'barber', 'barbiere',
  'massage', 'massaggio', 'babysit', 'dog walk', 'dog sitter', 'plumber', 'idraulico', 'elettricista',
  'electrician', 'personal trainer', 'yoga', 'cleaning lady', 'pulizie di casa', 'dating', 'escort',
];

// Keyword classifier over the skills that exist in the DB. Returns
// { skill, confidence, matched } or null. Null => fail closed.
export function classify(textIn) {
  const t = ` ${norm(textIn)} `;
  let best = null;
  for (const s of listSkills()) {
    let score = 0;
    const matched = [];
    for (const kw of s.keywords) {
      const k = norm(kw);
      const hit = k.length >= 5 ? t.includes(k) : new RegExp(`\\b${k}\\b`).test(t);
      if (hit) { score += k.split(' ').length; matched.push(kw); }
    }
    if (score > 0 && (!best || score > best.score)) best = { skill: s.code, score, matched };
  }
  const oos = OUT_OF_SCOPE.filter((k) => t.includes(norm(k)));
  if (oos.length && !(best && oos.some((k) => best.matched.some((m) => norm(m).includes(norm(k)))))) {
    return { skill: null, out_of_scope: oos };
  }
  if (!best) return null;
  return { skill: best.skill, confidence: Math.min(1, 0.4 + best.score * 0.15), matched: best.matched };
}
