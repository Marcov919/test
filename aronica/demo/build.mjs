// Builds dist/aronica-demo.html: the whole product (server code + UIs) in ONE
// self-contained page — no network needed. `npm run build:demo`
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const shim = (f) => join(here, 'shims', f);

const out = await build({
  entryPoints: [join(here, 'shell.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  alias: {
    'node:sqlite': shim('sqlite.js'),
    'node:crypto': shim('crypto.js'),
    'node:fs': shim('fs.js'),
    'node:fs/promises': shim('fs.js'),
    'node:path': shim('path.js'),
    'node:url': shim('url.js'),
    'node:os': shim('os.js'),
    'node:http': shim('http.js'),
  },
  logLevel: 'warning',
});

const noClose = (s) => s.replace(/<\/script/gi, '<\\/script');
const tpl = readFileSync(join(here, 'template.html'), 'utf8');
const sqlJs = readFileSync(join(root, 'node_modules/sql.js/dist/sql-wasm-browser.js'), 'utf8');
const wasm = readFileSync(join(root, 'node_modules/sql.js/dist/sql-wasm-browser.wasm')).toString('base64');
const page = tpl
  .replace('/*APP_CSS*/', () => readFileSync(join(root, 'public/css/app.css'), 'utf8'))
  .replace('/*SHELL_CSS*/', () => readFileSync(join(here, 'shell.css'), 'utf8'))
  .replace('/*SQL_WASM_B64*/', () => wasm)
  .replace('/*SQL_JS*/', () => noClose(sqlJs))
  .replace('/*BUNDLE*/', () => noClose(out.outputFiles[0].text));

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/aronica-demo.html'), page);
// Local preview wrapper (the artifact host adds the document skeleton itself).
writeFileSync(join(root, 'dist/preview.html'), `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>${page}</body></html>`);
console.log(`dist/aronica-demo.html ${(page.length / 1024).toFixed(0)} KB`);
