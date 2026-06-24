'use strict';

// Catalogo de servicios de ARCA respaldado por Postgres y editable EN VIVO.
//
// Por que en DB: ARCA cambia endpoints, namespaces y saca servicios nuevos
// seguido. El superadmin edita el catalogo desde la UI sin tocar codigo ni
// redeployar. Los DEFAULTS del codigo (catalog.defaults.js) son solo la semilla
// inicial y el "restaurar al default".
//
// Lectura cacheada en memoria; cualquier escritura refresca la cache.

const { DEFAULTS, REL, CERT_PORTAL, pasosActivacion } = require('./catalog.defaults');
const db = require('./db');

let cache = new Map(); // id -> { ...definition, enabled, origin }
let loaded = false;

async function seed() {
  // Inserta los defaults que falten y ACTUALIZA los builtins que el usuario no
  // edito (updated_by = 'seed'), para que las correcciones de endpoints/namespace
  // se propaguen en cada deploy sin pisar ediciones manuales del superadmin.
  for (const def of DEFAULTS) {
    await db.query(
      `INSERT INTO services (id, definition, enabled, origin, updated_by)
       VALUES ($1, $2, true, 'builtin', 'seed')
       ON CONFLICT (id) DO UPDATE SET definition = $2
       WHERE services.updated_by = 'seed' AND services.origin = 'builtin'`,
      [def.id, JSON.stringify(def)],
    );
  }
}

async function reload() {
  const { rows } = await db.query('SELECT id, definition, enabled, origin FROM services');
  const next = new Map();
  for (const r of rows) {
    next.set(r.id, { ...r.definition, id: r.id, enabled: r.enabled, origin: r.origin });
  }
  cache = next;
  loaded = true;
}

async function init() {
  await seed();
  await reload();
}

function ensureLoaded() {
  if (!loaded) throw new Error('Catalogo no inicializado: llamar a catalog.init() al arrancar');
}

// --- API de lectura (misma firma que antes; ahora dinamica) ---
function get(id) {
  ensureLoaded();
  return cache.get(id) || null;
}
function list({ includeDisabled = true } = {}) {
  ensureLoaded();
  const all = [...cache.values()];
  return includeDisabled ? all : all.filter((s) => s.enabled);
}
function endpoint(service, env) {
  const s = typeof service === 'string' ? get(service) : service;
  if (!s || !s.endpoints) return null;
  return s.endpoints[env] || s.endpoints.homo;
}
function categorias() {
  const c = {};
  for (const s of list()) (c[s.categoria || 'otros'] = c[s.categoria || 'otros'] || []).push(s.id);
  return c;
}

// --- API de escritura (solo superadmin; el router valida el rol) ---
function validateDef(def) {
  if (!def || typeof def !== 'object') throw err('Definicion invalida', 400);
  if (!def.id || !/^[a-z0-9_]+$/.test(def.id)) throw err('id invalido (use minusculas, numeros y guion bajo)', 400);
  if (!def.wsaaService) throw err('Falta wsaaService (nombre del servicio para WSAA)', 400);
  if (!def.endpoints || !def.endpoints.homo || !def.endpoints.prod) throw err('Faltan endpoints homo y prod', 400);
  if (!def.soapNamespace) throw err('Falta soapNamespace', 400);
  return def;
}

async function upsert(def, user) {
  validateDef(def);
  const enabled = def.enabled !== false;
  const exists = cache.get(def.id);
  const origin = exists ? exists.origin : 'custom';
  // Guardamos la definicion sin los campos de control (enabled/origin van en columnas).
  const clean = { ...def };
  delete clean.enabled;
  delete clean.origin;
  await db.query(
    `INSERT INTO services (id, definition, enabled, origin, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET definition = $2, enabled = $3, updated_by = $5, updated_at = now()`,
    [def.id, JSON.stringify(clean), enabled, origin, user || 'admin'],
  );
  await reload();
  return get(def.id);
}

async function setEnabled(id, enabled, user) {
  if (!cache.has(id)) throw err('Servicio no encontrado', 404);
  await db.query('UPDATE services SET enabled = $2, updated_by = $3, updated_at = now() WHERE id = $1', [id, !!enabled, user || 'admin']);
  await reload();
  return get(id);
}

async function remove(id, user) {
  const s = cache.get(id);
  if (!s) throw err('Servicio no encontrado', 404);
  // Un builtin no se borra: se restaura al default (para no romper el sistema).
  if (s.origin === 'builtin') {
    return reset(id, user);
  }
  await db.query('DELETE FROM services WHERE id = $1', [id]);
  await reload();
  return { removed: id };
}

async function reset(id, user) {
  const def = DEFAULTS.find((d) => d.id === id);
  if (!def) throw err('No hay default para restaurar este servicio', 404);
  await db.query(
    `INSERT INTO services (id, definition, enabled, origin, updated_by, updated_at)
     VALUES ($1, $2, true, 'builtin', $3, now())
     ON CONFLICT (id) DO UPDATE SET definition = $2, enabled = true, updated_by = $3, updated_at = now()`,
    [id, JSON.stringify(def), user || 'admin'],
  );
  await reload();
  return get(id);
}

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

module.exports = {
  init,
  reload,
  get,
  list,
  endpoint,
  categorias,
  upsert,
  setEnabled,
  remove,
  reset,
  REL,
  CERT_PORTAL,
  pasosActivacion,
};
