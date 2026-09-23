import { randomBytes } from 'node:crypto';

// Injectable clock so the dispatch engine can be tested deterministically.
let clockOffset = 0;
let frozen = null;
export const clock = {
  now: () => (frozen ?? Date.now()) + clockOffset,
  freeze(t) { frozen = t; },
  advance(ms) { clockOffset += ms; },
  reset() { frozen = null; clockOffset = 0; },
};

export function id(prefix) {
  return `${prefix}_${randomBytes(6).toString('base64url').replace(/[-_]/g, 'x')}`;
}

export function token(bytes = 18) {
  return randomBytes(bytes).toString('base64url');
}

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
export const round50 = (cents) => Math.round(cents / 50) * 50;
export const eur = (cents) => `€${(cents / 100).toFixed(2).replace('.', ',')}`;
export const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseTime(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number') return value;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new HttpError(400, 'invalid_time', `Invalid timestamp: ${value}`);
  return t;
}

export function toCents(eurValue, centsValue) {
  if (centsValue != null) return Math.round(Number(centsValue));
  if (eurValue != null) return Math.round(Number(eurValue) * 100);
  return null;
}

// Aronica's honest empty state (PRD, verbatim).
export const NO_SUPPLY_IT =
  'Siamo spiacenti ma al momento non abbiamo persone sufficienti a soddisfare la richiesta.';
