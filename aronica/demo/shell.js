// Demo shell: the whole product in one page. Buyer console + Partner phone share
// one in-browser backend, plus the Agent Connector (MCP) and Ops views.
import { startBackend } from './backend.js';
import { mountBuyer, openBuyerJob, go } from '../public/js/buyer.js';
import { mountWorker } from '../public/js/worker.js';
import { mountOps } from '../public/js/ops.js';
import { mountAgent } from './agent.js';
import { toast } from '../public/js/common.js';

const $ = (s) => document.querySelector(s);

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let opsMounted = false;
function show(view) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${view}`;
  if (view === 'ops' && !opsMounted) {
    opsMounted = true;
    mountOps({ mainEl: $('#ops-main'), logEl: $('#ops-log'), settingsEl: $('#ops-settings'), mapEl: $('#ops-map') });
  }
  window.dispatchEvent(new Event('resize'));
}

function showSide(side) {
  $('#live').dataset.side = side;
  for (const b of document.querySelectorAll('.seg-live button')) b.classList.toggle('on', b.dataset.side === side);
  window.dispatchEvent(new Event('resize'));
}

async function main() {
  try { localStorage.removeItem('aronica.buyer_jobs'); localStorage.removeItem('aronica.worker_token'); } catch { /* storage blocked */ }
  await startBackend({ wasmBinary: b64ToBytes(document.getElementById('sqlwasm').textContent.trim()) });
  document.body.classList.remove('booting');

  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => show(b.dataset.view));
  for (const b of document.querySelectorAll('.seg-live button')) b.addEventListener('click', () => showSide(b.dataset.side));

  await mountBuyer({ panelEl: $('#buyer-panel'), mapEl: $('#buyer-map'), hash: false });
  $('#new-req').addEventListener('click', () => go('#/'));
  await mountWorker($('#worker-root'), { autoLogin: 'w_giulia', demo: true });
  mountAgent($('#agent-root'), {
    onOpenConfirm: (id, token) => { show('live'); showSide('buyer'); openBuyerJob(id, token); },
  });

  // On narrow screens, jump to the phone when an offer arrives.
  const es = new EventSource('/api/stream?ops=1');
  es.addEventListener('dispatch.offer_sent', (m) => {
    const e = JSON.parse(m.data);
    if (e.worker_id === 'w_giulia' && getComputedStyle($('.seg-live')).display !== 'none') {
      showSide('worker');
      toast('Nuova offerta per Giulia sul telefono');
    }
  });
}

main().catch((e) => {
  console.error(e);
  document.body.classList.remove('booting');
  $('#boot-msg').textContent = `Impossibile avviare la demo: ${e.message}`;
});
