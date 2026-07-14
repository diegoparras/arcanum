'use strict';

// Capa de acceso a Postgres: pool, helpers y migracion idempotente del esquema.

const { Pool } = require('pg');
const { config } = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('[arcanum][db] error inesperado del pool:', err.message));

function query(text, params) {
  return pool.query(text, params);
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id              SERIAL PRIMARY KEY,
  cuit            TEXT NOT NULL,
  entorno         TEXT NOT NULL DEFAULT 'homo',
  nombre          TEXT,
  cert_pem        TEXT,
  key_enc         TEXT,
  key_fingerprint TEXT,
  cert_not_before TIMESTAMPTZ,
  cert_not_after  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cuit, entorno)
);

CREATE TABLE IF NOT EXISTS access_tickets (
  cuit            TEXT NOT NULL,
  service         TEXT NOT NULL,
  entorno         TEXT NOT NULL DEFAULT 'homo',
  token           TEXT NOT NULL,
  sign            TEXT NOT NULL,
  generation_time TIMESTAMPTZ,
  expiration_time TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cuit, service, entorno)
);

CREATE TABLE IF NOT EXISTS requests (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  cuit          TEXT,
  service       TEXT,
  operation     TEXT,
  http_method   TEXT,
  path          TEXT,
  status        INT,
  ok            BOOLEAN,
  duration_ms   INT,
  error         TEXT,
  request_json  JSONB,
  response_json JSONB,
  idempotency_key TEXT
);
CREATE INDEX IF NOT EXISTS requests_ts_idx ON requests (ts DESC);
CREATE INDEX IF NOT EXISTS requests_cuit_idx ON requests (cuit);
CREATE INDEX IF NOT EXISTS requests_service_idx ON requests (service);

CREATE TABLE IF NOT EXISTS comprobantes (
  id            BIGSERIAL PRIMARY KEY,
  cuit          TEXT NOT NULL,
  entorno       TEXT NOT NULL DEFAULT 'homo',
  punto_venta   INT NOT NULL,
  tipo_cbte     INT NOT NULL,
  numero        INT NOT NULL,
  cae           TEXT,
  cae_vto       DATE,
  resultado     TEXT,
  fecha         DATE,
  importe_total NUMERIC(18,2),
  doc_tipo      INT,
  doc_nro       TEXT,
  idempotency_key TEXT,
  raw           JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cuit, entorno, punto_venta, tipo_cbte, numero)
);
CREATE UNIQUE INDEX IF NOT EXISTS comprobantes_idem_idx
  ON comprobantes (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS service_status (
  id          BIGSERIAL PRIMARY KEY,
  service     TEXT NOT NULL,
  entorno     TEXT NOT NULL,
  ok          BOOLEAN NOT NULL,
  latency_ms  INT,
  detail      TEXT,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_status_idx ON service_status (service, checked_at DESC);

CREATE TABLE IF NOT EXISTS usuarios (
  id          SERIAL PRIMARY KEY,
  username    TEXT UNIQUE NOT NULL,
  pass_hash   TEXT NOT NULL,
  totp_secret TEXT,
  role        TEXT NOT NULL DEFAULT 'operador',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          SERIAL PRIMARY KEY,
  nombre      TEXT NOT NULL,
  key_hash    TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'operador',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used   TIMESTAMPTZ
);

-- Facturador masivo: lotes de solicitudes con seguimiento y aging.
CREATE TABLE IF NOT EXISTS lotes (
  id          BIGSERIAL PRIMARY KEY,
  cuit        TEXT NOT NULL,
  entorno     TEXT NOT NULL DEFAULT 'homo',
  nombre      TEXT NOT NULL,
  perfil      TEXT NOT NULL DEFAULT 'pyme',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lote_items (
  id            BIGSERIAL PRIMARY KEY,
  lote_id       BIGINT NOT NULL REFERENCES lotes(id) ON DELETE CASCADE,
  nombre        TEXT,
  cuit          TEXT,
  doc_tipo      INT,
  doc_nro       TEXT,
  email         TEXT,
  concepto      INT DEFAULT 1,
  periodo       TEXT,
  tipo_comprobante INT,
  punto_venta   INT,
  importe_neto  NUMERIC(18,2),
  importe_iva   NUMERIC(18,2),
  importe_total NUMERIC(18,2),
  estado        TEXT NOT NULL DEFAULT 'pendiente',
  cae           TEXT,
  numero        INT,
  cae_vto       DATE,
  solicitado_at TIMESTAMPTZ,
  resuelto_at   TIMESTAMPTZ,
  nota          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lote_items_lote_idx ON lote_items (lote_id);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS csr_pem TEXT;
-- Datos fiscales del emisor POR CUIT (para el encabezado legal del PDF).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS emisor JSONB;
-- Comprobantes importados (no emitidos por nosotros): origen y constatacion ARCA.
ALTER TABLE comprobantes ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'emitido';
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cuit_allow TEXT[];
ALTER TABLE requests ADD COLUMN IF NOT EXISTS usuario TEXT;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS ip TEXT;

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS services (
  id          TEXT PRIMARY KEY,
  definition  JSONB NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  origin      TEXT NOT NULL DEFAULT 'custom',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS webhooks (
  id          SERIAL PRIMARY KEY,
  url         TEXT NOT NULL,
  eventos     TEXT[] NOT NULL DEFAULT '{}',
  secret      TEXT,
  activo      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function migrate() {
  await pool.query(SCHEMA);
}

async function waitForDb(retries = 30, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (e) {
      if (i === retries - 1) throw e;
      console.log(`[arcanum][db] esperando Postgres... (${i + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { pool, query, tx, migrate, waitForDb };
