import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;
globalThis.process = globalThis.process ?? { env: {}, argv: [], cwd: () => '/' };
Object.assign(globalThis.process.env, { ARONICA_PUBLIC_URL: '', ARONICA_NEG_DELAY_MS: '800' });
globalThis.ARONICA_INLINE_UPLOADS = true;
export { Buffer };
