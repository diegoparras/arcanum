'use strict';

// Configuracion central de Arcanum. Todo sale de variables de entorno con
// defaults sensatos para que "docker run" funcione sin tocar nada en homologacion.

const path = require('path');

const ENV = (process.env.ARCANUM_ENV || 'homo').toLowerCase();
const IS_PROD = ENV === 'prod' || ENV === 'produccion' || ENV === 'production';

// Endpoints oficiales de ARCA (ex-AFIP). Dominios .afip.gov.ar siguen vigentes
// y son alias de .arca.gob.ar. Se mantienen los historicos por estabilidad.
const ENDPOINTS = {
  homo: {
    wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    wsfev1: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
    wsfex: 'https://wswhomo.afip.gov.ar/wsfexv1/service.asmx',
    padronA13: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA13',
    constancia: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5',
  },
  prod: {
    wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
    wsfev1: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
    wsfex: 'https://servicios1.afip.gov.ar/wsfexv1/service.asmx',
    padronA13: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA13',
    constancia: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5',
  },
};

const DATA_DIR = process.env.ARCANUM_DATA_DIR || path.join(process.cwd(), 'data');

// Entorno activo: arranca del env var pero es cambiable en caliente (y se
// persiste en DB). Como env/isProd/endpoints son getters, todo el codigo que
// lee config.env ve el valor vigente sin cambios.
let activeEnv = IS_PROD ? 'prod' : 'homo';

const config = {
  get env() { return activeEnv; },
  get isProd() { return activeEnv === 'prod'; },
  get endpoints() { return ENDPOINTS[activeEnv]; },
  setEnv(e) {
    const v = String(e).toLowerCase();
    if (v !== 'homo' && v !== 'prod') throw Object.assign(new Error('Entorno invalido (homo|prod)'), { httpStatus: 400 });
    activeEnv = v;
    return activeEnv;
  },
  port: parseInt(process.env.PORT || '8094', 10),
  // Federacion: cuando OIDC (Lockatus) esta habilitado, el login LOCAL se bloquea
  // por defecto (no se puede saltear el SSO). Escape hatch para dejar admin local:
  // ARCANUM_ALLOW_LOCAL_LOGIN=1.
  allowLocalLogin: ['1', 'true', 'yes'].includes(String(process.env.ARCANUM_ALLOW_LOCAL_LOGIN || '').toLowerCase()),
  // Clave de API para proteger el gateway. Si esta vacia se genera una al
  // arrancar y se imprime UNA vez en el log (patron de la suite).
  apiKey: process.env.ARCANUM_API_KEY || '',
  // Conexion a Postgres. Acepta DATABASE_URL o variables sueltas (patron de paneles).
  databaseUrl:
    process.env.DATABASE_URL ||
    (process.env.POSTGRES_HOST
      ? `postgres://${process.env.POSTGRES_USER || 'arcanum'}:${process.env.POSTGRES_PASSWORD || ''}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT || '5432'}/${process.env.POSTGRES_DB || 'arcanum'}`
      : 'postgres://arcanum:arcanum@localhost:5432/arcanum'),
  // Master key para cifrar claves privadas en reposo (AES-256-GCM).
  // DEBE definirse en produccion. Generar: openssl rand -hex 32
  masterKey: process.env.ARCANUM_MASTER_KEY || '',
  // Directorio persistente (solo para artefactos transitorios; los certs van a DB).
  dataDir: DATA_DIR,
  certsDir: path.join(DATA_DIR, 'certs'),
  cacheDir: path.join(DATA_DIR, 'cache'),
  // El Ticket de Acceso (TA) dura 12hs. Renovamos con margen de seguridad.
  tokenRenewMarginMs: 10 * 60 * 1000, // 10 minutos antes del vencimiento
  // Timeout de las llamadas SOAP a ARCA.
  soapTimeoutMs: parseInt(process.env.ARCANUM_SOAP_TIMEOUT_MS || '15000', 10),
  version: require('../package.json').version,
};

module.exports = { config, ENDPOINTS };
