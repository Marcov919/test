// Geography for the single launch city (Milano). No external geocoder: a small
// gazetteer resolves common places; otherwise agents must send lat/lng.

export const CITY = {
  code: 'milano',
  name: 'Milano',
  center: { lat: 45.4642, lng: 9.19 }, // Duomo
  radius_km: 11, // service area
};

export const GAZETTEER = [
  { name: 'Duomo', lat: 45.4642, lng: 9.19, aliases: ['piazza duomo', 'duomo di milano'] },
  { name: 'Brera', lat: 45.4719, lng: 9.1881, aliases: ['via brera', 'pinacoteca'] },
  { name: 'Via Montenapoleone', lat: 45.4685, lng: 9.1955, aliases: ['montenapoleone', 'quadrilatero'] },
  { name: 'Corso Buenos Aires', lat: 45.4786, lng: 9.2097, aliases: ['buenos aires', 'c.so buenos aires'] },
  { name: 'Porta Venezia', lat: 45.4745, lng: 9.205, aliases: ['venezia'] },
  { name: 'Stazione Centrale', lat: 45.4861, lng: 9.2046, aliases: ['centrale', 'milano centrale', 'central station'] },
  { name: 'Porta Garibaldi', lat: 45.4847, lng: 9.1875, aliases: ['garibaldi', 'gae aulenti', 'piazza gae aulenti', 'porta nuova'] },
  { name: 'Corso Como', lat: 45.4822, lng: 9.1867, aliases: [] },
  { name: 'Isola', lat: 45.487, lng: 9.189, aliases: ['quartiere isola'] },
  { name: 'Navigli', lat: 45.452, lng: 9.175, aliases: ['naviglio grande', 'darsena', 'ripa di porta ticinese'] },
  { name: 'Via Tortona', lat: 45.4535, lng: 9.1665, aliases: ['tortona', 'zona tortona'] },
  { name: 'Porta Romana', lat: 45.452, lng: 9.203, aliases: ['romana'] },
  { name: 'CityLife', lat: 45.478, lng: 9.155, aliases: ['city life', 'tre torri'] },
  { name: 'Sempione', lat: 45.4755, lng: 9.172, aliases: ['arco della pace', 'parco sempione', 'corso sempione'] },
  { name: 'Città Studi', lat: 45.478, lng: 9.227, aliases: ['citta studi', 'politecnico', 'piazza leonardo da vinci'] },
  { name: 'Lambrate', lat: 45.484, lng: 9.238, aliases: ['ventura', 'lambrate stazione'] },
  { name: 'NoLo', lat: 45.4955, lng: 9.2175, aliases: ['nolo', 'via padova', 'loreto', 'piazzale loreto'] },
  { name: 'Bicocca', lat: 45.514, lng: 9.211, aliases: ['universita bicocca'] },
  { name: 'Bovisa', lat: 45.503, lng: 9.16, aliases: [] },
  { name: 'San Siro', lat: 45.478, lng: 9.123, aliases: ['stadio', 'meazza'] },
  { name: 'Porta Genova', lat: 45.4535, lng: 9.1705, aliases: ['genova'] },
  { name: 'Corso Vittorio Emanuele', lat: 45.4655, lng: 9.1935, aliases: ['vittorio emanuele', 'galleria'] },
  { name: 'Cadorna', lat: 45.468, lng: 9.1755, aliases: ['piazzale cadorna', 'castello sforzesco', 'castello'] },
  { name: 'Porta Ticinese', lat: 45.4555, lng: 9.181, aliases: ['colonne di san lorenzo', 'ticinese'] },
];

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Urban speeds in Milano (km/h) and fixed prep time.
export const VEHICLES = {
  walk: { speed: 4.8, label_it: 'A piedi' },
  bike: { speed: 14, label_it: 'Bici' },
  scooter: { speed: 20, label_it: 'Scooter' },
  car: { speed: 16, label_it: 'Auto' },
};
const ROUTE_FACTOR = 1.3; // streets are not straight lines
const PREP_MIN = 3;

export function etaMinutes(from, to, vehicle) {
  const km = haversineKm(from, to) * ROUTE_FACTOR;
  const speed = VEHICLES[vehicle]?.speed ?? 12;
  return Math.max(2, Math.round((km / speed) * 60 + PREP_MIN));
}

export function inServiceArea(p) {
  return haversineKm(p, CITY.center) <= CITY.radius_km;
}

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, "").trim();

export function geocode(address) {
  if (!address) return null;
  const q = norm(address);
  let best = null;
  for (const place of GAZETTEER) {
    for (const cand of [place.name, ...place.aliases]) {
      const c = norm(cand);
      if (q.includes(c) && (!best || c.length > best.len)) best = { place, len: c.length };
    }
  }
  return best ? { lat: best.place.lat, lng: best.place.lng, matched: best.place.name } : null;
}
