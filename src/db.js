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

// Corre fn() serializado por `key` con un advisory lock de Postgres (distribuido,
// entre requests y entre instancias). Se libera al terminar la transaccion. Se usa
// para serializar la emision por punto de venta (numeracion ultimo+1 sin carrera).
async function withLock(key, fn) {
  return tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(key)]);
    return fn(client);
  });
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

-- Claves de API con rol (integraciones: n8n, SecretarIA). Solo se guarda el hash.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS prefix TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS cuit_allow TEXT[];
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys (key_hash);
-- Vencimiento, limite por minuto y rotacion (la nueva apunta a la anterior).
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit INT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rotated_from INT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS aviso_vence_at TIMESTAMPTZ;
-- Uso por clave (auditoria): que clave hizo cada pedido.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS clave_id INT;
CREATE INDEX IF NOT EXISTS requests_clave_idx ON requests (clave_id, ts DESC) WHERE clave_id IS NOT NULL;
-- e-Ventanilla: comunicaciones ya vistas (para avisar solo las nuevas).
CREATE TABLE IF NOT EXISTS ventanilla_vistas (
  cuit             TEXT NOT NULL,
  entorno          TEXT NOT NULL,
  id_comunicacion  BIGINT NOT NULL,
  vista_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cuit, entorno, id_comunicacion)
);

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

-- Mis Comprobantes (0.9): clave fiscal cifrada por CUIT, corridas y comprobantes bajados.
CREATE TABLE IF NOT EXISTS mc_credenciales (
  cuit            TEXT PRIMARY KEY,
  cuit_login      TEXT NOT NULL,
  clave_cifrada   TEXT,
  sincronizar     BOOLEAN NOT NULL DEFAULT false,
  actualizada_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizada_por TEXT
);
CREATE TABLE IF NOT EXISTS mc_corridas (
  id           SERIAL PRIMARY KEY,
  cuit         TEXT NOT NULL,
  tipo         TEXT NOT NULL,
  desde        DATE NOT NULL,
  hasta        DATE NOT NULL,
  estado       TEXT NOT NULL,
  token_fb     TEXT,
  origen       TEXT,
  usuario      TEXT,
  iniciada_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminada_at TIMESTAMPTZ,
  cantidad     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  log          JSONB
);
ALTER TABLE mc_credenciales ADD COLUMN IF NOT EXISTS rechazada_at TIMESTAMPTZ;
ALTER TABLE mc_corridas ADD COLUMN IF NOT EXISTS latido_at TIMESTAMPTZ;
ALTER TABLE mc_corridas ADD COLUMN IF NOT EXISTS progreso JSONB;
ALTER TABLE mc_credenciales ADD COLUMN IF NOT EXISTS rechazo_motivo TEXT;
CREATE INDEX IF NOT EXISTS mc_corridas_cuit_idx ON mc_corridas (cuit, iniciada_at DESC);
-- Ultima pantalla del navegador de Fisherboy cuando una corrida falla (JPEG). Aparte de
-- mc_corridas para que el detalle de la corrida no arrastre la imagen. Se purga a los 30 dias.
CREATE TABLE IF NOT EXISTS mc_capturas (
  corrida_id INTEGER PRIMARY KEY REFERENCES mc_corridas(id) ON DELETE CASCADE,
  img        BYTEA NOT NULL,
  tomada_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mc_comprobantes (
  id             SERIAL PRIMARY KEY,
  cuit           TEXT NOT NULL,
  tipo           TEXT NOT NULL,
  fecha          DATE,
  cbte_tipo      INTEGER NOT NULL,
  punto_venta    INTEGER NOT NULL DEFAULT 0,
  numero_desde   BIGINT NOT NULL,
  numero_hasta   BIGINT,
  cae            TEXT,
  doc_tipo       INTEGER,
  doc_nro        TEXT NOT NULL DEFAULT '',
  contraparte    TEXT,
  moneda         TEXT,
  tipo_cambio    NUMERIC,
  neto_gravado   NUMERIC,
  no_gravado     NUMERIC,
  exento         NUMERIC,
  iva            NUMERIC,
  total          NUMERIC,
  corrida_id     INTEGER,
  constatacion   JSONB,
  actualizado_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cuit, tipo, cbte_tipo, punto_venta, numero_desde, doc_nro)
);
CREATE INDEX IF NOT EXISTS mc_comprobantes_fecha_idx ON mc_comprobantes (cuit, tipo, fecha DESC);

-- Emisiones en vuelo (0.10): pedido mandado a ARCA cuya respuesta todavia no se conoce.
CREATE TABLE IF NOT EXISTS emisiones_en_vuelo (
  idempotency_key TEXT PRIMARY KEY,
  cuit            TEXT NOT NULL,
  entorno         TEXT NOT NULL,
  punto_venta     INTEGER NOT NULL,
  tipo_cbte       INTEGER NOT NULL,
  numero          INTEGER NOT NULL,
  importe_total   NUMERIC,
  doc_nro         TEXT,
  fecha           TEXT,
  creado_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cola de emision (0.10): comprobantes que esperan a que ARCA vuelva.
CREATE TABLE IF NOT EXISTS emision_cola (
  id                 SERIAL PRIMARY KEY,
  cuit               TEXT NOT NULL,
  entorno            TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL UNIQUE,
  cuerpo             JSONB NOT NULL,
  fecha              DATE,
  concepto           INTEGER,
  estado             TEXT NOT NULL,
  intentos           INTEGER NOT NULL DEFAULT 0,
  proximo_intento_at TIMESTAMPTZ,
  numero_intentado   INTEGER,
  ultimo_error       TEXT,
  resultado          JSONB,
  modo               TEXT NOT NULL DEFAULT 'CAE',
  creado_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  creado_por         TEXT,
  origen             TEXT
);
CREATE INDEX IF NOT EXISTS emision_cola_estado_idx ON emision_cola (estado, proximo_intento_at);

-- CAEA (0.10): opcional por CUIT. Fechas como AAAAMMDD (asi las da ARCA).
CREATE TABLE IF NOT EXISTS caea_config (
  cuit            TEXT PRIMARY KEY,
  activo          BOOLEAN NOT NULL DEFAULT false,
  punto_venta     INTEGER,
  minutos_espera  INTEGER NOT NULL DEFAULT 30,
  actualizado_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_por TEXT
);
CREATE TABLE IF NOT EXISTS caea (
  id          SERIAL PRIMARY KEY,
  cuit        TEXT NOT NULL,
  entorno     TEXT NOT NULL,
  periodo     INTEGER NOT NULL,
  orden       INTEGER NOT NULL,
  caea        TEXT NOT NULL,
  vig_desde   TEXT NOT NULL,
  vig_hasta   TEXT NOT NULL,
  tope_inf    TEXT NOT NULL,
  obtenido_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cuit, entorno, periodo, orden)
);
ALTER TABLE caea ADD COLUMN IF NOT EXISTS punto_venta INTEGER;
CREATE TABLE IF NOT EXISTS caea_sin_mov (
  caea_id      INTEGER NOT NULL,
  punto_venta  INTEGER NOT NULL,
  informado_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resultado    JSONB,
  PRIMARY KEY (caea_id, punto_venta)
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

module.exports = { pool, query, tx, withLock, migrate, waitForDb };
