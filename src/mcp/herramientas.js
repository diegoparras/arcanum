'use strict';

// Herramientas MCP de SOLO CONSULTA. Ninguna emite, ni pasa por el motor generico
// /api/ws, ni cambia nada en ARCA o en Arcanum.
//
//   padron              -> datos de un CUIT (padron A5)
//   comprobante         -> un comprobante ya emitido (FECompConsultar)
//   ultimo_comprobante  -> ultimo numero autorizado (FECompUltimoAutorizado)
//   puntos_de_venta     -> puntos de venta habilitados (FEParamGetPtosVenta)
//   estado_arca         -> si ARCA responde (FEDummy en vivo + monitor de Arcanum)
//
// Las respuestas son datos (JSON), no instrucciones para un asistente.

const db = require('../db');
const { config } = require('../config');
const tenants = require('../auth/tenants');
const { assertCuitAllowed } = require('../auth/permisos');
const wsfev1 = require('../services/wsfev1');
const padron = require('../services/padron');
const { analizarPadron, asArray } = require('../services/contribuyente');
const reglas = require('../services/reglas-comprobante');

const TIPOS = {
  1: 'Factura A', 2: 'Nota de Debito A', 3: 'Nota de Credito A',
  6: 'Factura B', 7: 'Nota de Debito B', 8: 'Nota de Credito B',
  11: 'Factura C', 12: 'Nota de Debito C', 13: 'Nota de Credito C',
  51: 'Factura M', 52: 'Nota de Debito M', 53: 'Nota de Credito M',
  201: 'Factura de Credito Electronica MiPyME A', 206: 'Factura de Credito Electronica MiPyME B',
  211: 'Factura de Credito Electronica MiPyME C',
};
const ALIAS_TIPO = { A: 1, FA: 1, NDA: 2, NCA: 3, B: 6, FB: 6, NDB: 7, NCB: 8, C: 11, FC: 11, NDC: 12, NCC: 13, M: 51, FM: 51 };
const DOC_TIPOS = { 80: 'CUIT', 86: 'CUIL', 87: 'CDI', 89: 'LE', 90: 'LC', 91: 'CI extranjera', 94: 'Pasaporte', 96: 'DNI', 99: 'Consumidor final (sin identificar)' };
const NO_EXISTE = /no existen datos|602/i;

function error(msg) {
  return Object.assign(new Error(msg), { httpStatus: 400 });
}

// ---------- parsers (puros) ----------
function cuit11(v, campo = 'cuit') {
  const c = tenants.normalizeCuit(v);
  if (!/^\d{11}$/.test(c)) throw error(`"${campo}" debe ser un CUIT de 11 digitos`);
  return c;
}

/** Tipo de comprobante: codigo ARCA (11) o letra/alias ("C", "FC", "NCB"). */
function parseTipo(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
    const n = parseInt(v, 10);
    if (!n) throw error('"tipo" invalido');
    return n;
  }
  const a = ALIAS_TIPO[String(v).trim().toUpperCase().replace(/[^A-Z]/g, '')];
  if (!a) throw error(`"tipo" no reconocido: ${v}. Usa el codigo de ARCA (11 = Factura C, 6 = Factura B, 1 = Factura A) o la letra.`);
  return a;
}

/** "0003-00000124", "3-124" o "FC 0003-00000124" -> { puntoVenta, numero, tipo? } */
function parseComprobante(texto) {
  if (!texto) return null;
  const m = String(texto).trim().match(/^(?:([A-Za-z]{1,3})[\s-]*)?(\d{1,5})\s*-\s*(\d{1,8})$/);
  if (!m) throw error(`"comprobante" debe tener la forma 0003-00000124 (punto de venta-numero); recibido: ${texto}`);
  return { puntoVenta: parseInt(m[2], 10), numero: parseInt(m[3], 10), tipo: m[1] ? parseTipo(m[1]) : null };
}

function formatearNumero(pv, n) {
  return `${String(pv).padStart(4, '0')}-${String(n).padStart(8, '0')}`;
}

function fechaIso(v) {
  if (!v) return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

function entero(v, campo) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw error(`"${campo}" debe ser un numero entero positivo`);
  return n;
}

// ---------- CUIT emisor ----------
/**
 * CUIT con certificado con el que se consulta. Si no viene, y el principal ve un
 * solo CUIT con certificado en el entorno activo, se usa ese.
 */
async function resolverEmisor(ctx, valor, campo = 'cuit_emisor') {
  const principal = ctx.principal;
  if (valor) {
    const c = cuit11(valor, campo);
    assertCuitAllowed(principal, c);
    return c;
  }
  let lista = (await tenants.list(config.env)).filter((t) => t.tieneCertificado);
  if (principal.cuitAllow && principal.cuitAllow.length) lista = lista.filter((t) => principal.cuitAllow.includes(t.cuit));
  if (lista.length === 1) return lista[0].cuit;
  if (!lista.length) throw error(`No hay ningun CUIT con certificado cargado en Arcanum (entorno ${config.env}).`);
  throw error(`Hay ${lista.length} CUITs con certificado; indica "${campo}". Opciones: ${lista.map((t) => `${t.cuit}${t.nombre ? ` (${t.nombre})` : ''}`).join(', ')}.`);
}

// ---------- padron ----------
function resumirPadron(cuit, datos) {
  const a = analizarPadron(datos);
  const dg = a.dg;
  const dom = dg.domicilioFiscal || {};
  const actividades = [];
  const vistas = new Set();
  for (const act of [
    ...asArray(datos.datosRegimenGeneral && datos.datosRegimenGeneral.actividad),
    ...asArray(datos.datosMonotributo && datos.datosMonotributo.actividad),
  ]) {
    if (!act || vistas.has(String(act.idActividad))) continue;
    vistas.add(String(act.idActividad));
    actividades.push({ codigo: act.idActividad || null, descripcion: act.descripcionActividad || null, orden: act.orden ? Number(act.orden) : null });
  }
  actividades.sort((x, y) => (x.orden || 99) - (y.orden || 99));
  const cat = a.esMonotributo ? datos.datosMonotributo.categoriaMonotributo : null;
  const errores = asArray(datos.errorConstancia && datos.errorConstancia.error).map(String);
  return {
    cuit,
    nombre: a.nombre,
    tipoPersona: dg.tipoPersona || null,
    estadoClave: a.estadoClave,
    condicionIVA: a.condicionIVA,
    tipoContribuyente: a.tipoContribuyente,
    condicionIvaReceptorId: reglas.idDesdeTipoContribuyente(a.tipoContribuyente),
    monotributo: cat ? { categoria: cat.idCategoria || null, descripcion: cat.descripcionCategoria || null, periodo: cat.periodo || null } : null,
    domicilioFiscal: dg.domicilioFiscal
      ? {
        direccion: dom.direccion || null,
        localidad: dom.localidad || null,
        codigoPostal: dom.codPostal || null,
        provincia: dom.descripcionProvincia || null,
      }
      : null,
    actividades: actividades.slice(0, 50),
    impuestos: a.impuestos.slice(0, 50).map((i) => ({ codigo: i.idImpuesto || null, descripcion: i.descripcionImpuesto || null, estado: i.estadoImpuesto || i.estado || null })),
    ...(errores.length ? { erroresArca: errores } : {}),
    fuente: 'ARCA, padron A5 (constancia de inscripcion)',
    entorno: config.env,
  };
}

const padronTool = {
  nombre: 'padron',
  titulo: 'Padron de ARCA por CUIT',
  descripcion:
    'Consulta en ARCA (padron A5, constancia de inscripcion) los datos de un CUIT y devuelve JSON con: nombre o razon social, '
    + 'tipo de persona, estado de la clave fiscal, condicion frente al IVA (responsable inscripto, monotributo con su categoria, '
    + 'exento, etc.), el codigo de condicion de IVA del receptor que usa ARCA para facturar, domicilio fiscal, actividades e '
    + 'impuestos inscriptos. Solo lectura.',
  esquema: {
    type: 'object',
    properties: {
      cuit: { type: 'string', description: 'CUIT a consultar, 11 digitos (con o sin guiones).' },
      cuit_representada: { type: 'string', description: 'CUIT con certificado en Arcanum con el que se consulta. Opcional si hay uno solo.' },
    },
    required: ['cuit'],
    additionalProperties: false,
  },
  async ejecutar(args, ctx) {
    const objetivo = cuit11(args.cuit, 'cuit');
    const repre = await resolverEmisor(ctx, args.cuit_representada, 'cuit_representada');
    ctx.cuit = repre;
    const datos = await padron.consultarPersona('a5', repre, objetivo);
    return resumirPadron(objetivo, datos);
  },
};

// ---------- comprobante ----------
/** Tipos a probar si no se indico: los que el registro local tiene para ese pv/numero o pv. */
async function tiposCandidatos(cuit, pv, numero) {
  try {
    const exacto = await db.query(
      'SELECT DISTINCT tipo_cbte FROM comprobantes WHERE cuit=$1 AND entorno=$2 AND punto_venta=$3 AND numero=$4',
      [cuit, config.env, pv, numero],
    );
    if (exacto.rows.length) return exacto.rows.map((r) => Number(r.tipo_cbte));
    const usados = await db.query(
      `SELECT tipo_cbte FROM comprobantes WHERE cuit=$1 AND entorno=$2 AND punto_venta=$3
       GROUP BY tipo_cbte ORDER BY count(*) DESC LIMIT 3`,
      [cuit, config.env, pv],
    );
    if (usados.rows.length) return usados.rows.map((r) => Number(r.tipo_cbte));
  } catch { /* sin base: se usan los mas comunes */ }
  return [11, 6, 1];
}

async function registroLocal(cuit, pv, tipo, numero) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM comprobantes WHERE cuit=$1 AND entorno=$2 AND punto_venta=$3 AND tipo_cbte=$4 AND numero=$5',
      [cuit, config.env, pv, tipo, numero],
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

function salidaComprobante(emisor, r, local, fuente) {
  const raw = (local && local.raw) || {};
  return {
    emisor,
    comprobante: `${TIPOS[r.tipoComprobante] || `Tipo ${r.tipoComprobante}`} ${formatearNumero(r.puntoVenta, r.numero)}`,
    tipo: r.tipoComprobante,
    tipoNombre: TIPOS[r.tipoComprobante] || null,
    puntoVenta: r.puntoVenta,
    numero: r.numero,
    fecha: fechaIso(r.fecha),
    importeTotal: r.importeTotal,
    moneda: r.moneda || 'PES',
    cae: r.cae || null,
    caeVencimiento: fechaIso(r.caeVencimiento),
    resultado: r.resultado === 'A' ? 'Aprobado' : r.resultado === 'R' ? 'Rechazado' : r.resultado || null,
    receptor: {
      tipoDocumento: DOC_TIPOS[r.docTipo] || (r.docTipo != null ? String(r.docTipo) : null),
      numeroDocumento: r.docNro && r.docNro !== '0' ? r.docNro : null,
      nombre: raw.receptorNombre || null,
    },
    fuente,
    entorno: config.env,
  };
}

const comprobanteTool = {
  nombre: 'comprobante',
  titulo: 'Comprobante emitido',
  descripcion:
    'Busca en ARCA un comprobante electronico ya emitido por el emisor y devuelve JSON con: fecha, importe total, moneda, CAE, '
    + 'vencimiento del CAE, resultado (aprobado o rechazado) y documento y nombre del receptor. Se indica el comprobante como '
    + 'texto "0003-00000124" (punto de venta-numero) o con punto_venta y numero. El tipo es opcional (11 = Factura C, 6 = Factura B, '
    + '1 = Factura A, o la letra): si falta, se prueban los tipos que usa ese punto de venta. Solo lectura.',
  esquema: {
    type: 'object',
    properties: {
      comprobante: { type: 'string', description: 'Punto de venta y numero, ej. "0003-00000124". Alternativa a punto_venta + numero.' },
      punto_venta: { type: 'integer', minimum: 1, description: 'Punto de venta, ej. 3.' },
      numero: { type: 'integer', minimum: 1, description: 'Numero de comprobante, ej. 124.' },
      tipo: { type: ['integer', 'string'], description: 'Opcional. Codigo ARCA (11, 6, 1...) o letra (C, B, A, NCC...).' },
      cuit_emisor: { type: 'string', description: 'CUIT emisor con certificado en Arcanum. Opcional si hay uno solo.' },
    },
    additionalProperties: false,
  },
  async ejecutar(args, ctx) {
    const emisor = await resolverEmisor(ctx, args.cuit_emisor);
    ctx.cuit = emisor;
    const delTexto = parseComprobante(args.comprobante);
    const pv = delTexto ? delTexto.puntoVenta : args.punto_venta != null ? entero(args.punto_venta, 'punto_venta') : null;
    const numero = delTexto ? delTexto.numero : args.numero != null ? entero(args.numero, 'numero') : null;
    if (!pv || !numero) throw error('Indica "comprobante" (ej. 0003-00000124) o "punto_venta" y "numero".');
    const tipo = parseTipo(args.tipo) || (delTexto && delTexto.tipo) || null;

    const candidatos = tipo ? [tipo] : await tiposCandidatos(emisor, pv, numero);
    let ultimoError = null;
    for (const t of candidatos.slice(0, 4)) {
      try {
        const r = await wsfev1.consultar(emisor, pv, t, numero);
        return salidaComprobante(emisor, r, await registroLocal(emisor, pv, t, numero), 'ARCA (FECompConsultar)');
      } catch (e) {
        if (NO_EXISTE.test(e.message) || (e.extra && (e.extra.errors || []).some((x) => String(x.code) === '602'))) continue;
        ultimoError = e;
        break;
      }
    }
    // ARCA no respondio: si Arcanum lo tiene registrado, se devuelve el registro local, avisando.
    if (ultimoError) {
      for (const t of candidatos) {
        const local = await registroLocal(emisor, pv, t, numero);
        if (local) {
          return {
            ...salidaComprobante(emisor, {
              puntoVenta: local.punto_venta, tipoComprobante: local.tipo_cbte, numero: local.numero, fecha: local.fecha,
              importeTotal: Number(local.importe_total), moneda: (local.raw && local.raw.moneda) || 'PES', cae: local.cae,
              caeVencimiento: local.cae_vto, resultado: local.resultado, docTipo: local.doc_tipo, docNro: local.doc_nro,
            }, local, 'Registro local de Arcanum'),
            aviso: `ARCA no respondio (${ultimoError.message}); son los datos guardados por Arcanum al emitir.`,
          };
        }
      }
      throw ultimoError;
    }
    throw error(`ARCA no tiene el comprobante ${formatearNumero(pv, numero)} del emisor ${emisor} (tipos probados: ${candidatos.slice(0, 4).join(', ')}).`);
  },
};

// ---------- ultimo_comprobante ----------
const ultimoTool = {
  nombre: 'ultimo_comprobante',
  titulo: 'Ultimo comprobante autorizado',
  descripcion:
    'Devuelve el ultimo numero de comprobante autorizado por ARCA para un punto de venta y un tipo, y el proximo numero que '
    + 'corresponde usar. JSON con ultimoNumero, proximoNumero y ambos formateados (0003-00000124). Solo lectura: no reserva el numero.',
  esquema: {
    type: 'object',
    properties: {
      punto_venta: { type: 'integer', minimum: 1, description: 'Punto de venta, ej. 3.' },
      tipo: { type: ['integer', 'string'], description: 'Codigo ARCA (11 = Factura C, 6 = Factura B, 1 = Factura A) o letra.' },
      cuit_emisor: { type: 'string', description: 'CUIT emisor con certificado en Arcanum. Opcional si hay uno solo.' },
    },
    required: ['punto_venta', 'tipo'],
    additionalProperties: false,
  },
  async ejecutar(args, ctx) {
    const emisor = await resolverEmisor(ctx, args.cuit_emisor);
    ctx.cuit = emisor;
    const pv = entero(args.punto_venta, 'punto_venta');
    const tipo = parseTipo(args.tipo);
    if (!tipo) throw error('Falta "tipo" (ej. 11 = Factura C).');
    const r = await wsfev1.lastAuthorized(emisor, pv, tipo);
    const ultimo = Number(r.ultimoNumero) || 0;
    return {
      emisor,
      puntoVenta: pv,
      tipo,
      tipoNombre: TIPOS[tipo] || null,
      ultimoNumero: ultimo,
      ultimoFormateado: ultimo ? formatearNumero(pv, ultimo) : null,
      proximoNumero: ultimo + 1,
      proximoFormateado: formatearNumero(pv, ultimo + 1),
      fuente: 'ARCA (FECompUltimoAutorizado)',
      entorno: config.env,
    };
  },
};

// ---------- puntos_de_venta ----------
const puntosTool = {
  nombre: 'puntos_de_venta',
  titulo: 'Puntos de venta habilitados',
  descripcion:
    'Lista los puntos de venta del emisor dados de alta en ARCA para factura electronica por web service. JSON con, por cada '
    + 'uno: numero, tipo de emision, si esta bloqueado, fecha de baja y si esta habilitado para facturar. Solo lectura.',
  esquema: {
    type: 'object',
    properties: {
      cuit_emisor: { type: 'string', description: 'CUIT emisor con certificado en Arcanum. Opcional si hay uno solo.' },
    },
    additionalProperties: false,
  },
  async ejecutar(args, ctx) {
    const emisor = await resolverEmisor(ctx, args.cuit_emisor);
    ctx.cuit = emisor;
    let valores;
    try {
      valores = await wsfev1.getParams(emisor, 'puntosVenta');
    } catch (e) {
      if (NO_EXISTE.test(e.message) || /sin resultados/i.test(e.message)) valores = [];
      else throw e;
    }
    const puntos = valores.slice(0, 200).map((p) => {
      const bloqueado = String(p.Bloqueado || '').toUpperCase() === 'S';
      const baja = p.FchBaja && String(p.FchBaja).toUpperCase() !== 'NULL' ? fechaIso(p.FchBaja) : null;
      return { numero: Number(p.Nro), tipoEmision: p.EmisionTipo || null, bloqueado, fechaBaja: baja, habilitado: !bloqueado && !baja };
    }).sort((a, b) => a.numero - b.numero);
    return { emisor, cantidad: puntos.length, puntosDeVenta: puntos, fuente: 'ARCA (FEParamGetPtosVenta)', entorno: config.env };
  },
};

// ---------- estado_arca ----------
const estadoTool = {
  nombre: 'estado_arca',
  titulo: 'Estado de los servicios de ARCA',
  descripcion:
    'Indica si los servicios de ARCA estan respondiendo. JSON con un chequeo en vivo del servicio de factura electronica '
    + '(WSFEv1: servidor de aplicacion, base de datos y autenticacion, con la latencia) y el ultimo resultado del monitor de '
    + 'Arcanum para cada servicio que vigila (se chequea cada 5 minutos). estadoGeneral: operativo, parcial o caido. Solo lectura.',
  esquema: { type: 'object', properties: {}, additionalProperties: false },
  async ejecutar() {
    const t0 = Date.now();
    let fe;
    try {
      const d = await wsfev1.dummy();
      const ok = [d.appServer, d.dbServer, d.authServer].every((x) => String(x).toUpperCase() === 'OK');
      fe = { ok, servidorAplicacion: d.appServer, baseDeDatos: d.dbServer, autenticacion: d.authServer, latenciaMs: Date.now() - t0 };
    } catch (e) {
      fe = { ok: false, error: e.message, latenciaMs: Date.now() - t0 };
    }
    let monitor = [];
    try {
      const { rows } = await db.query(
        `SELECT DISTINCT ON (service) service, ok, latency_ms, checked_at
         FROM service_status WHERE entorno = $1 ORDER BY service, checked_at DESC`,
        [config.env],
      );
      monitor = rows.map((r) => ({ servicio: r.service, ok: r.ok, latenciaMs: r.latency_ms, ultimoChequeo: r.checked_at }));
    } catch { /* sin datos del monitor */ }
    const caidos = monitor.filter((m) => !m.ok).map((m) => m.servicio);
    const estadoGeneral = !fe.ok ? 'caido' : caidos.length ? 'parcial' : 'operativo';
    return {
      estadoGeneral,
      entorno: config.env,
      consultado: new Date().toISOString(),
      facturaElectronica: fe,
      ...(caidos.length ? { serviciosConFalla: caidos } : {}),
      monitor,
    };
  },
};

const HERRAMIENTAS = [padronTool, comprobanteTool, ultimoTool, puntosTool, estadoTool];

module.exports = {
  HERRAMIENTAS,
  // Funciones puras expuestas para tests.
  _internos: { parseTipo, parseComprobante, formatearNumero, fechaIso, cuit11, resumirPadron, TIPOS },
};
