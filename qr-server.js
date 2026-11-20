#!/usr/bin/env node
/*
 * QR Studio Pro — servidor de QR dinámicos (Node.js 18+, sin dependencias)
 *
 *   node qr-server.js
 *
 * Variables de entorno opcionales:
 *   PORT=8787                  Puerto HTTP
 *   HOST=0.0.0.0               Interfaz de escucha
 *   DATA_FILE=./qr-data.json   Dónde se guardan enlaces y estadísticas
 *   ADMIN_TOKEN=...            Clave de administración (si no se indica, se genera y se guarda en DATA_FILE)
 *   PUBLIC_URL=https://qr.midominio.com   URL pública (para construir los enlaces cortos detrás de un proxy)
 *
 * Qué hace:
 *   GET  /r/:id               Redirige al destino (cuenta el escaneo; respeta pausa, “activo desde” y caducidad)
 *   GET  /api/health          Comprobar conexión (sin clave)
 *   GET  /api/links           Listar enlaces                       (Authorization: Bearer <clave>)
 *   POST /api/links           Crear  { target, title?, slug?, validFrom?, expiresAt?, expiredMessage?, active? }
 *   GET  /api/links/:id       Detalle + estadísticas
 *   PATCH /api/links/:id      Modificar cualquiera de los campos anteriores
 *   DELETE /api/links/:id     Eliminar
 *   GET  /  y los archivos de la app (qr-studio-pro.html, sw.js, manifest, iconos)
 *
 * Privacidad: no se guardan direcciones IP. Solo fecha, tipo de dispositivo y sistema operativo aproximados.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(ROOT, 'qr-data.json'));
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const VERSION = 1;
const MAX_BODY = 64 * 1024;
const MAX_LINKS = 10000;
const RECENT_SCANS = 50;

/* ------------------------------------------------------------------ datos */
try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); } catch (e) { /* se informará al guardar */ }
let db = { version: VERSION, token: '', links: {} };
try {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (raw && typeof raw === 'object' && raw.links && typeof raw.links === 'object') db = { ...db, ...raw };
} catch (e) {
  if (e.code !== 'ENOENT') { console.error(`No se pudo leer ${DATA_FILE}: ${e.message}`); process.exit(1); }
}
let tokenGenerated = false;
if (process.env.ADMIN_TOKEN) db.token = process.env.ADMIN_TOKEN;
else if (!db.token) { db.token = crypto.randomBytes(24).toString('base64url'); tokenGenerated = true; }

let saveTimer = null, saving = false, dirty = false;
function save(now = false) {
  dirty = true;
  if (now) return flush();
  if (!saveTimer) saveTimer = setTimeout(flush, 800);
}
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  if (saving || !dirty) return;
  saving = true; dirty = false;
  const tmp = DATA_FILE + '.tmp';
  const data = { ...db, token: process.env.ADMIN_TOKEN ? '' : db.token };
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, DATA_FILE); // escritura atómica
  } catch (e) { console.error('Error al guardar datos:', e.message); dirty = true; }
  saving = false;
  if (dirty) save();
}
if (tokenGenerated) save(true);

/* ------------------------------------------------------------- utilidades */
const ID_RE = /^[A-Za-z0-9_-]{3,40}$/;
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newId() {
  for (;;) {
    const b = crypto.randomBytes(7);
    const id = Array.from(b, x => ALPHABET[x % ALPHABET.length]).join('');
    if (!db.links[id]) return id;
  }
}
function validTarget(t) {
  if (typeof t !== 'string' || t.length > 4000) return false;
  try { const u = new URL(t); return u.protocol === 'https:' || u.protocol === 'http:'; } catch (e) { return false; }
}
function validTime(v) { return v === null || v === 0 || (typeof v === 'number' && isFinite(v) && v > 0 && v < 1e14); }
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
  const host = (req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}`;
}
function linkStatus(l, now = Date.now()) {
  if (!l.active) return 'paused';
  if (l.validFrom && now < l.validFrom) return 'scheduled';
  if (l.expiresAt && now >= l.expiresAt) return 'expired';
  return 'active';
}
function publicLink(l, req, full = false) {
  const out = {
    id: l.id, title: l.title, target: l.target, active: l.active, validFrom: l.validFrom || null, expiresAt: l.expiresAt || null,
    expiredMessage: l.expiredMessage || '', createdAt: l.createdAt, updatedAt: l.updatedAt,
    status: linkStatus(l), shortUrl: `${baseUrl(req)}/r/${l.id}`,
    scans: l.stats.total, bots: l.stats.bots, lastScan: l.stats.last || null
  };
  if (full) out.stats = l.stats;
  return out;
}
function device(ua) {
  ua = ua || '';
  const bot = /bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|curl|wget|python-requests|headless/i.test(ua);
  const os = /android/i.test(ua) ? 'Android' : /iphone|ipad|ipod/i.test(ua) ? 'iOS' : /windows/i.test(ua) ? 'Windows'
    : /mac os/i.test(ua) ? 'macOS' : /linux/i.test(ua) ? 'Linux' : 'Otro';
  const type = bot ? 'bot' : /mobile|iphone|android/i.test(ua) ? 'móvil' : /ipad|tablet/i.test(ua) ? 'tablet' : 'ordenador';
  return { bot, os, type };
}

/* --------------------------------------------- límite de intentos fallidos */
const fails = new Map();
function clientKey(req) { return req.socket.remoteAddress || '?'; }
function tooManyFails(req) {
  const f = fails.get(clientKey(req));
  return f && f.n >= 20 && Date.now() - f.t < 10 * 60e3;
}
function noteFail(req) {
  const k = clientKey(req), f = fails.get(k);
  if (!f || Date.now() - f.t > 10 * 60e3) fails.set(k, { n: 1, t: Date.now() });
  else f.n++;
}
function authorized(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = Buffer.from(m[1].trim()), b = Buffer.from(db.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------- respuestas */
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SEC_HEADERS, ...headers });
  res.end(body);
}
// La API usa una clave en la cabecera (no cookies), así que se puede llamar desde la app alojada en otro dominio
const CORS = {
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Max-Age': '600'
};
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS });
}
function page(res, status, icon, title, msg, extra = '') {
  send(res, status, `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">
<style>:root{color-scheme:light dark;--bg:#f3f4fb;--card:#fff;--txt:#151935;--mut:#565d8c;--line:#d6d9ee}
@media (prefers-color-scheme:dark){:root{--bg:#0a0c16;--card:#12152a;--txt:#e9ecff;--mut:#8f96c8;--line:#272c52}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--txt);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
.c{max-width:460px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px 22px;text-align:center}
.i{font-size:52px;line-height:1}h1{font-size:21px;margin:10px 0 6px}p{color:var(--mut);margin:6px 0}</style></head>
<body><div class="c"><div class="i">${icon}</div><h1>${esc(title)}</h1><p>${esc(msg)}</p>${extra}</div></body></html>`,
  { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false; const chunks = [];
    req.on('data', c => {
      if (tooBig) return; // descartar el resto sin acumularlo
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; chunks.length = 0; reject(Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch (e) { reject(Object.assign(new Error('JSON no válido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/* --------------------------------------------------- validación de enlaces */
function applyFields(l, b, creating) {
  if (creating || 'target' in b) {
    if (!validTarget(b.target)) throw Object.assign(new Error('Destino no válido: debe ser un enlace http(s)'), { status: 400 });
    l.target = b.target;
  }
  if ('title' in b) l.title = String(b.title || '').slice(0, 120);
  if ('active' in b) l.active = !!b.active;
  if ('expiredMessage' in b) l.expiredMessage = String(b.expiredMessage || '').slice(0, 280);
  for (const k of ['validFrom', 'expiresAt']) {
    if (k in b) {
      const v = b[k] == null || b[k] === '' ? null : Number(b[k]);
      if (!validTime(v)) throw Object.assign(new Error(`Fecha no válida: ${k}`), { status: 400 });
      l[k] = v || null;
    }
  }
  if (l.validFrom && l.expiresAt && l.validFrom >= l.expiresAt) throw Object.assign(new Error('«Activo desde» debe ser anterior a la caducidad'), { status: 400 });
}

/* --------------------------------------------------------------- estáticos */
const STATIC = {
  '/': ['qr-studio-pro.html', 'text/html; charset=utf-8'],
  '/qr-studio-pro.html': ['qr-studio-pro.html', 'text/html; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icons/icon.svg': ['icons/icon.svg', 'image/svg+xml'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
  '/icons/icon-maskable-512.png': ['icons/icon-maskable-512.png', 'image/png']
};
function serveStatic(req, res, p) {
  const [file, type] = STATIC[p];
  fs.readFile(path.join(ROOT, file), (err, buf) => {
    if (err) return page(res, 404, '🔍', 'No encontrado', 'Este archivo no está disponible en el servidor.');
    const headers = { 'Content-Type': type, 'Cache-Control': p === '/sw.js' || type.startsWith('text/html') ? 'no-cache' : 'public, max-age=86400' };
    if (p === '/sw.js') headers['Service-Worker-Allowed'] = '/';
    if (req.method === 'HEAD') return send(res, 200, '', headers);
    send(res, 200, buf, headers);
  });
}

/* --------------------------------------------------------- redirección /r/ */
function handleRedirect(req, res, id) {
  const l = db.links[id];
  if (!l) return page(res, 404, '🔍', 'Código no encontrado', 'Este código QR no existe o fue eliminado.');
  const st = linkStatus(l);
  if (st === 'paused') return page(res, 410, '⏸️', 'Código desactivado', 'El propietario ha pausado este código QR.');
  if (st === 'scheduled') return page(res, 403, '🕒', 'Todavía no está activo', `Estará disponible a partir del ${new Date(l.validFrom).toLocaleString('es')} (hora UTC del servidor).`);
  if (st === 'expired') return page(res, 410, '⛔', 'Código caducado', l.expiredMessage || 'Este código QR ha caducado y ya no está disponible.');
  if (req.method === 'GET') {
    const d = device(req.headers['user-agent']), s = l.stats;
    if (d.bot) s.bots++;
    else {
      s.total++;
      const day = today();
      s.days[day] = (s.days[day] || 0) + 1;
      s.os[d.os] = (s.os[d.os] || 0) + 1;
      s.types[d.type] = (s.types[d.type] || 0) + 1;
      s.last = Date.now();
      s.recent.unshift({ t: s.last, os: d.os, type: d.type });
      if (s.recent.length > RECENT_SCANS) s.recent.length = RECENT_SCANS;
      // Conservar solo los últimos 400 días de recuento diario
      const keys = Object.keys(s.days);
      if (keys.length > 400) keys.sort().slice(0, keys.length - 400).forEach(k => delete s.days[k]);
    }
    save();
  }
  send(res, 302, '', { Location: l.target, 'Cache-Control': 'no-store, max-age=0' });
}

/* ----------------------------------------------------------------- la API */
async function handleApi(req, res, parts) {
  if (req.method === 'OPTIONS') return send(res, 204, '', CORS);
  if (parts[1] === 'health' && parts.length === 2) return json(res, 200, { ok: true, app: 'qr-studio-server', version: VERSION, time: Date.now() });
  if (tooManyFails(req)) return json(res, 429, { error: 'Demasiados intentos fallidos. Espera unos minutos.' });
  if (!authorized(req)) { noteFail(req); return json(res, 401, { error: 'Clave de administración incorrecta' }); }
  if (parts[1] !== 'links') return json(res, 404, { error: 'Ruta no encontrada' });
  const id = parts[2];

  if (!id) {
    if (req.method === 'GET') {
      const list = Object.values(db.links).sort((a, b) => b.createdAt - a.createdAt).map(l => publicLink(l, req));
      return json(res, 200, { links: list });
    }
    if (req.method === 'POST') {
      if (Object.keys(db.links).length >= MAX_LINKS) return json(res, 507, { error: 'Límite de enlaces alcanzado' });
      const b = await readBody(req);
      let lid;
      if (b.slug) {
        if (!ID_RE.test(b.slug)) return json(res, 400, { error: 'Identificador no válido (3-40 letras, números, - o _)' });
        if (db.links[b.slug]) return json(res, 409, { error: 'Ese identificador ya está en uso' });
        lid = b.slug;
      } else lid = newId();
      const now = Date.now();
      const l = { id: lid, title: '', target: '', active: true, validFrom: null, expiresAt: null, expiredMessage: '', createdAt: now, updatedAt: now,
        stats: { total: 0, bots: 0, last: null, days: {}, os: {}, types: {}, recent: [] } };
      applyFields(l, b, true);
      db.links[lid] = l;
      save(true);
      return json(res, 201, { link: publicLink(l, req, true) });
    }
    return json(res, 405, { error: 'Método no permitido' });
  }

  if (!ID_RE.test(id) || !db.links[id]) return json(res, 404, { error: 'Enlace no encontrado' });
  const l = db.links[id];
  if (req.method === 'GET') return json(res, 200, { link: publicLink(l, req, true) });
  if (req.method === 'PATCH') {
    const b = await readBody(req);
    const copy = JSON.parse(JSON.stringify(l));
    applyFields(copy, b, false); // validar todo antes de modificar
    Object.assign(l, copy, { updatedAt: Date.now() });
    if (b.resetStats) l.stats = { total: 0, bots: 0, last: null, days: {}, os: {}, types: {}, recent: [] };
    save(true);
    return json(res, 200, { link: publicLink(l, req, true) });
  }
  if (req.method === 'DELETE') {
    delete db.links[id];
    save(true);
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { error: 'Método no permitido' });
}

/* ---------------------------------------------------------------- servidor */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const parts = p.split('/').filter(Boolean);
    if (parts[0] === 'api') return await handleApi(req, res, parts);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido', { 'Content-Type': 'text/plain; charset=utf-8' });
    if (parts[0] === 'r' && parts.length === 2 && ID_RE.test(parts[1])) return handleRedirect(req, res, parts[1]);
    if (STATIC[p]) return serveStatic(req, res, p);
    return page(res, 404, '🔍', 'No encontrado', 'La página que buscas no existe.');
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) {
      if (status === 413) { res.setHeader('Connection', 'close'); res.on('finish', () => req.destroy()); }
      json(res, status, { error: status === 500 ? 'Error interno' : e.message });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\nQR Studio Pro · servidor de QR dinámicos`);
  console.log(`  App:    http://localhost:${PORT}/`);
  console.log(`  Datos:  ${DATA_FILE}`);
  if (process.env.ADMIN_TOKEN) console.log('  Clave:  (definida en ADMIN_TOKEN)');
  else console.log(`  Clave de administración: ${db.token}`);
  console.log('  Para publicarlo en internet usa HTTPS (Render, Railway, Fly.io, un VPS con Caddy/Nginx…) y define PUBLIC_URL.\n');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });
