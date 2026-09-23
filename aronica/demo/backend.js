// Runs the real Aronica server code inside the browser: SQLite via sql.js,
// and fetch()/EventSource calls to /api, /v1, /mcp routed to the same
// handleRequest() that node:http uses. Nothing leaves the page.
import './shims/globals.js';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { handleRequest, startLoop } from '../src/server.js';

const API = /^\/(api|v1|mcp|openapi\.json)(\/|\?|$)/;

class FakeReq {
  constructor(method, url, headers, body) {
    this.method = method;
    this.url = url;
    this.headers = headers;
    this._body = body;
    this._l = {};
  }
  on(ev, fn) {
    (this._l[ev] ??= []).push(fn);
    if (ev === 'end') {
      setTimeout(() => {
        if (this._body) for (const f of this._l.data ?? []) f(Buffer.from(this._body));
        for (const f of this._l.end ?? []) f();
      }, 0);
    }
    return this;
  }
  emit(ev) { for (const f of this._l[ev] ?? []) f(); }
  destroy() {}
}

class FakeRes {
  constructor({ onHead, onChunk, onEnd }) {
    this.headersSent = false;
    this.statusCode = 200;
    this._h = {};
    this.cb = { onHead, onChunk, onEnd };
    this.chunks = [];
  }
  setHeader(k, v) { this._h[k.toLowerCase()] = v; }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [k, v] of Object.entries(headers)) this._h[k.toLowerCase()] = v;
    this.headersSent = true;
    this.cb.onHead?.(this);
  }
  write(chunk) {
    if (!this.headersSent) this.writeHead(this.statusCode);
    if (this.cb.onChunk) this.cb.onChunk(String(chunk)); else this.chunks.push(String(chunk));
    return true;
  }
  end(chunk) {
    if (chunk != null) this.write(chunk);
    if (!this.headersSent) this.writeHead(this.statusCode);
    this.cb.onEnd?.(this);
  }
}

function pathOf(input) {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const u = new URL(raw, location.href);
    if (u.origin !== location.origin && !raw.startsWith('/')) return null;
    return u.pathname + u.search;
  } catch { return null; }
}

function installFetch() {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const path = pathOf(input);
    if (!path || !API.test(path)) return realFetch(input, init);
    const headers = {};
    new Headers(init.headers ?? {}).forEach((v, k) => { headers[k] = v; });
    const req = new FakeReq((init.method ?? 'GET').toUpperCase(), path, headers, init.body ?? null);
    return new Promise((resolve) => {
      const res = new FakeRes({
        onEnd: (r) => {
          const body = r.chunks.join('');
          const status = r.statusCode;
          resolve(new Response([101, 204, 205, 304].includes(status) ? null : body, { status, headers: r._h }));
        },
      });
      handleRequest(req, res);
    });
  };
}

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this._l = {};
    this.onmessage = null;
    this.onerror = null;
    this._buf = '';
    this._req = new FakeReq('GET', pathOf(url), { accept: 'text/event-stream' }, null);
    const res = new FakeRes({
      onHead: (r) => { this.readyState = r.statusCode === 200 ? 1 : 2; if (r.statusCode !== 200) this.onerror?.(new Event('error')); },
      onChunk: (c) => this._feed(c),
      onEnd: () => { this.readyState = 2; },
    });
    setTimeout(() => handleRequest(this._req, res), 0);
  }
  _feed(chunk) {
    this._buf += chunk;
    let i;
    while ((i = this._buf.indexOf('\n\n')) >= 0) {
      const block = this._buf.slice(0, i);
      this._buf = this._buf.slice(i + 2);
      let type = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      const ev = new MessageEvent(type, { data: data.join('\n') });
      for (const f of this._l[type] ?? []) f(ev);
      if (type === 'message') this.onmessage?.(ev);
    }
  }
  addEventListener(type, fn) { (this._l[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this._l[type] = (this._l[type] ?? []).filter((f) => f !== fn); }
  close() { this.readyState = 2; this._req.emit('close'); }
}

export async function startBackend({ wasmBinary }) {
  globalThis.__SQL = await window.initSqlJs({ wasmBinary });
  openDb(':memory:');
  seed();
  startLoop(1000);
  installFetch();
  window.EventSource = FakeEventSource;
}
