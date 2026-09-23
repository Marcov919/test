import { Buffer } from 'buffer';
export function randomBytes(n) {
  const b = Buffer.from(crypto.getRandomValues(new Uint8Array(n)));
  const orig = b.toString.bind(b);
  b.toString = (enc, ...rest) => (enc === 'base64url'
    ? orig('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    : orig(enc, ...rest));
  return b;
}
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
export default { randomBytes, timingSafeEqual };
