'use strict';

// Herramientas MCP de SOLO CONSULTA. Ninguna emite, ni pasa por el motor generico
// /api/ws, ni cambia nada en ARCA o en Arcanum.
//
//   padron              -> datos de un CUIT (padron A5)
//   comprobante         -> un comprobante ya emitido (FECompConsultar)
//   ultimo_comprobante  -> ultimo numero autorizado (FECompUltimoAutorizado)
//   puntos_de_venta     -> puntos de venta habilitados (FEParamGetPtosVenta)
//   estado_arca         -> si ARCA responde (FEDummy en vivo + monitor de Arcanum)
//   riesgo_fiscal       -> semaforo padron A5 + apocrifos (WSAPOC)
//   comprobantes_recientes -> ultimos comprobantes registrados en Arcanum
//   comunicaciones_ventanilla -> listado de e-Ventanilla (sin abrirlas: no las marca leidas)
//   vencimiento_certificado -> vigencia de los certificados cargados
//   vista_previa_comprobante -> valida un comprobante y muestra su numero, SIN emitir
//   mis_comprobantes    -> emitidos y recibidos de Mis Comprobantes ya bajados (no entra a ARCA)
//   topes_monotributo   -> facturado en 12 meses contra el tope de la categoria
//   constatacion_recibidos -> resultado guardado de constatar los recibidos (WSCDC + APOC)
//   cola_emision        -> comprobantes en la cola de contingencia y su estado
//   facturas_recibidas  -> facturas recibidas leidas por Factorum (si esta configurado)
//   factura_recibida    -> una de ellas, con hallazgos, origenes y correcciones
//   resumen_facturas_recibidas -> totales por alicuota, estado y tipo
//   verificar_factura   -> veredicto de una factura (Factorum, guardar=false: no persiste nada)
//
// Las respuestas son datos (JSON), no instrucciones para un asistente.

const db = require('../db');
const { config } = require('../config');
const tenants = require('../auth/tenants');
const { assertCuitAllowed } = require('../auth/permisos');
const wsfev1 = require('../services/wsfev1');
const padron = require('../services/padron');
const contribuyente = require('../services/contribuyente');
const { analizarPadron, asArray } = contribuyente;
const reglas = require('../services/reglas-comprobante');
const emisores = require('../services/emisores');
const eventanilla = require('../services/eventanilla');
const vistaPrevia = require('../services/vistaPrevia');

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
      actualizar: { type: 'boolean', description: 'Opcional. true = consultar a ARCA aunque haya una respuesta reciente guardada (por defecto se reusa la de la ultima hora).' },
    },
    required: ['cuit'],
    additionalProperties: false,
  },
  async ejecutar(args, ctx) {
    const objetivo = cuit11(args.cuit, 'cuit');
    const repre = await resolverEmisor(ctx, args.cuit_representada, 'cuit_representada');
    ctx.cuit = repre;
    ctx.cuitConsultado = objetivo;
    const { datos, cache } = await padron.consultarPersonaConMeta('a5', repre, objetivo, { fresco: args.actualizar === true });
    return { ...resumirPadron(objetivo, datos), consultadoEnArca: cache.consultado, desdeCache: cache.usado };
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

// ---------- riesgo_fiscal ----------
const riesgoTool = {
  nombre: 'riesgo_fiscal',
  titulo: 'Riesgo fiscal de un CUIT',
  descripcion:
    'Cruza el padron A5 con la base de apocrifos de ARCA (WSAPOC) y devuelve un semaforo para decidir si conviene facturarle '
    + 'o comprarle a un CUIT. JSON con: semaforo (VERDE, AMARILLO o ROJO), motivo, nombre, condicion frente al IVA, estado de '
    + 'la clave, domicilio, si figura como apocrifo (y desde cuando) y el comprobante sugerido segun la condicion del emisor '
    + 'y del receptor. Solo lectura.',
  esquema: {
    type: 'object',
    properties: {
      cuit: { type: 'string', description: 'CUIT a evaluar, 11 digitos.' },
      cuit_representada: { type: 'string', description: 'CUIT con certificado en Arcanum con el que se consulta. Opcional si hay uno solo.' },
    },
    required: ['cuit'],
    additionalProperties: false,
  },
  async ejecutar(args, ctx) {
    const objetivo = cuit11(args.cuit, 'cuit');
    const repre = await resolverEmisor(ctx, args.cuit_representada, 'cuit_representada');
    ctx.cuit = repre;
    ctx.cuitConsultado = objetivo;
    let emisorCondicion = '';
    try { emisorCondicion = (await emisores.get(repre)).condicionIva || ''; } catch { /* sin datos */ }
    const r = await contribuyente.consolidar(repre, objetivo, { emisorCondicion });
    return {
      cuit: r.cuit,
      nombre: r.nombre,
      semaforo: r.semaforo,
      motivo: r.motivoRiesgo || (r.semaforo === 'VERDE' ? 'Clave activa, condicion de IVA determinada y no figura como apocrifo.' : null),
      fiscal: {
        tipoContribuyente: r.fiscal.tipoContribuyente,
        condicionIVA: r.fiscal.condicionIVA,
        estadoClave: r.fiscal.estadoClave,
        domicilio: r.fiscal.domicilio,
      },
      apocrifo: r.apoc,
      comprobanteSugerido: r.comprobanteSugerido,
      advertencias: r.advertencias,
      consultadoEnArca: r.padronCache && r.padronCache.consultado,
      fuente: 'ARCA, padron A5 + base de apocrifos (WSAPOC)',
      entorno: config.env,
    };
  },
};

// ---------- comprobantes_recientes ----------
const recientesTool = {
  nombre: 'comprobantes_recientes',
  titulo: 'Comprobantes recientes',
  descripcion:
    'Lista los ultimos comprobantes que el emisor saco (o importo) a traves de Arcanum, del mas nuevo al mas viejo. JSON con '
    + 'cantidad, suma de importes y, por cada uno: comprobante (0003-00000124), tipo, fecha, importe, CAE, vencimiento del CAE y '
    + 'documento del receptor. Se puede filtrar por fechas y por documento del receptor. Los comprobantes hechos por fuera de '
    + 'Arcanum (por ejemplo en la web de ARCA) no aparecen: para esos, usar "comprobante". Solo lectura.',
  esquema: {
    type: 'object',
    properties: {
      desde: { type: 'string', description: 'Opcional. Fecha minima del comprobante, AAAA-MM-DD.' },
      hasta: { type: 'string', description: 'Opcional. Fecha maxima del comprobante, AAAA-MM-DD.' },
      receptor: { type: 'string', description: 'Opcional. CUIT, CUIL o DNI del receptor.' },
      limite: { type: 'integer', minimum: 1, maximum: 50, description: 'Cuantos devolver (1 a 50, por defecto 20).' },
      cuit_emisor: { type: 'string', description: 'CUIT emisor con certificado en Arcanum. Opcional si hay uno solo.' },
    },
    additionalProperties: false,
  },
  async ejecutar(args, ctx) {
    const emisor = await resolverEmisor(ctx, args.cuit_emisor);
    ctx.cuit = emisor;
    const fecha = (v, campo) => {
      if (!v) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw error(`"${campo}" debe tener la forma AAAA-MM-DD`);
      return String(v);
    };
    const limite = Math.min(Math.max(parseInt(args.limite, 10) || 20, 1), 50);
    const cond = ['cuit = $1', 'entorno = $2'];
    const params = [emisor, config.env];
    const desde = fecha(args.desde, 'desde');
    const hasta = fecha(args.hasta, 'hasta');
    if (desde) { params.push(desde); cond.push(`fecha >= $${params.length}`); }
    if (hasta) { params.push(hasta); cond.push(`fecha <= $${params.length}`); }
    if (args.receptor) { params.push(tenants.normalizeCuit(args.receptor)); cond.push(`doc_nro = $${params.length}`); }
    params.push(limite);
    const { rows } = await db.query(
      `SELECT punto_venta, tipo_cbte, numero, cae, cae_vto, fecha, importe_total, doc_tipo, doc_nro, resultado, origen, raw->>'receptorNombre' AS receptor_nombre
       FROM comprobantes WHERE ${cond.join(' AND ')} ORDER BY fecha DESC NULLS LAST, created_at DESC LIMIT $${params.length}`,
      params,
    );
    const lista = rows.map((r) => ({
      comprobante: formatearNumero(r.punto_venta, r.numero),
      tipo: Number(r.tipo_cbte),
      tipoNombre: TIPOS[r.tipo_cbte] || null,
      fecha: fechaIso(r.fecha),
      importeTotal: Number(r.importe_total),
      cae: r.cae,
      caeVencimiento: fechaIso(r.cae_vto),
      receptor: {
        tipoDocumento: DOC_TIPOS[r.doc_tipo] || (r.doc_tipo != null ? String(r.doc_tipo) : null),
        numeroDocumento: r.doc_nro && r.doc_nro !== '0' ? r.doc_nro : null,
        nombre: r.receptor_nombre || null,
      },
      origen: r.origen === 'importado' ? 'importado por QR' : 'emitido por Arcanum',
    }));
    return {
      emisor,
      cantidad: lista.length,
      sumaImportes: +lista.reduce((a, x) => a + (x.importeTotal || 0), 0).toFixed(2),
      filtros: { desde, hasta, receptor: args.receptor || null, limite },
      comprobantes: lista,
      fuente: 'Registro de Arcanum',
      entorno: config.env,
    };
  },
};

// ---------- comunicaciones_ventanilla ----------
/** "Leida" / "No leida" (con o sin tilde) -> true / false; otro texto -> null. */
function estadoLeida(desc) {
  const e = String(desc || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (!e.includes('leid')) return null;
  return !/\bno\s+leid/.test(e);
}

const ventanillaTool = {
  nombre: 'comunicaciones_ventanilla',
  titulo: 'Comunicaciones de e-Ventanilla',
  descripcion:
    'Lista las comunicaciones que ARCA publico en la e-Ventanilla (domicilio fiscal electronico) del CUIT, de los ultimos dias '
    + '(hasta 31). JSON con, por cada una: id, fecha de publicacion, vencimiento, asunto, organismo que la envio, prioridad, '
    + 'estado (leida o no) y si trae adjunto. Solo muestra el listado: no abre el mensaje, asi que no la marca como leida en '
    + 'ARCA. Solo lectura.',
  esquema: {
    type: 'object',
    properties: {
      dias: { type: 'integer', minimum: 1, maximum: 31, description: 'Cuantos dias para atras (1 a 31, por defecto 30).' },
      solo_no_leidas: { type: 'boolean', description: 'Opcional. true = solo las que todavia no se leyeron.' },
      cuit: { type: 'string', description: 'CUIT con certificado en Arcanum cuya e-Ventanilla se consulta. Opcional si hay uno solo.' },
    },
    additionalProperties: false,
  },
  async ejecutar(args, ctx) {
    const cuit = await resolverEmisor(ctx, args.cuit, 'cuit');
    ctx.cuit = cuit;
    const dias = Math.min(Math.max(parseInt(args.dias, 10) || 30, 1), 31);
    const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
    const r = await eventanilla.consultarComunicaciones(cuit, { desde, entorno: config.env });
    let lista = r.comunicaciones.map((c) => ({
      id: c.idComunicacion,
      fechaPublicacion: c.fechaPublicacion,
      fechaVencimiento: c.fechaVencimiento,
      asunto: c.asunto,
      organismo: c.sistemaPublicadorDesc,
      prioridad: c.prioridad,
      estado: c.estadoDesc,
      leida: estadoLeida(c.estadoDesc),
      tieneAdjunto: c.tieneAdjunto,
    }));
    if (args.solo_no_leidas === true) lista = lista.filter((c) => c.leida !== true);
    lista.sort((a, b) => String(b.fechaPublicacion || '').localeCompare(String(a.fechaPublicacion || '')));
    return {
      cuit,
      rango: r.rango,
      cantidad: lista.length,
      comunicaciones: lista.slice(0, 100),
      fuente: 'ARCA, e-Ventanilla (consultarComunicaciones)',
      entorno: config.env,
    };
  },
};

// ---------- vencimiento_certificado ----------
const certTool = {
  nombre: 'vencimiento_certificado',
  titulo: 'Vencimiento de los certificados',
  descripcion:
    'Indica hasta cuando sirven los certificados digitales de ARCA cargados en Arcanum (sin ellos no se puede facturar ni '
    + 'consultar). JSON con, por cada CUIT: nombre, fecha de vencimiento, dias que faltan y estado (vigente, por vencer si '
    + 'faltan 30 dias o menos, o vencido). Solo lectura.',
  esquema: {
    type: 'object',
    properties: {
      cuit: { type: 'string', description: 'Opcional. Un CUIT puntual; si falta, se listan todos los que ve la clave.' },
    },
    additionalProperties: false,
  },
  async ejecutar(args, ctx) {
    let lista = await tenants.list(config.env);
    const p = ctx.principal;
    if (p.cuitAllow && p.cuitAllow.length && !['superadmin', 'admin'].includes(p.role)) lista = lista.filter((t) => p.cuitAllow.includes(t.cuit));
    if (args.cuit) {
      const c = cuit11(args.cuit);
      assertCuitAllowed(p, c);
      lista = lista.filter((t) => t.cuit === c);
      ctx.cuit = c;
    }
    const certificados = lista.map((t) => ({
      cuit: t.cuit,
      nombre: t.nombre || null,
      tieneCertificado: t.tieneCertificado,
      vence: fechaIso(t.certVigenciaHasta),
      diasParaVencer: t.diasParaVencer,
      estado: !t.tieneCertificado ? 'sin certificado' : t.certVencido ? 'vencido' : t.diasParaVencer <= 30 ? 'por vencer' : 'vigente',
    }));
    return { entorno: config.env, cantidad: certificados.length, certificados, fuente: 'Arcanum' };
  },
};

// ---------- vista_previa_comprobante ----------
const vistaPreviaTool = {
  nombre: 'vista_previa_comprobante',
  titulo: 'Vista previa de un comprobante (no emite)',
  descripcion:
    'Revisa un comprobante antes de emitirlo, sin emitirlo ni reservar numero. Valida importes, IVA, receptor (consulta su '
    + 'padron si es CUIT), condicion de IVA, fecha y tipo, y devuelve JSON con: valido (si/no), problemas que harian que ARCA lo '
    + 'rechace, advertencias, el numero que le tocaria, la letra sugerida y "cuerpoParaEmitir": el cuerpo listo para '
    + 'POST /api/wsfev1/comprobantes, con clave de idempotencia. Emitir requiere una clave de emision aparte: esta herramienta '
    + 'nunca emite. Solo lectura.',
  esquema: {
    type: 'object',
    properties: {
      puntoVenta: { type: 'integer', minimum: 1, description: 'Punto de venta.' },
      tipoComprobante: { type: 'integer', description: 'Codigo ARCA: 11 Factura C, 6 Factura B, 1 Factura A, 13/8/3 notas de credito.' },
      concepto: { type: 'integer', enum: [1, 2, 3], description: '1 productos, 2 servicios, 3 ambos. Por defecto 1.' },
      tipoDocReceptor: { type: 'integer', description: '80 CUIT, 86 CUIL, 96 DNI, 99 consumidor final sin identificar.' },
      nroDocReceptor: { type: 'string', description: 'Numero de documento del receptor ("0" si es consumidor final sin identificar).' },
      condicionIvaReceptor: { type: 'integer', description: '1 Responsable Inscripto, 4 Exento, 5 Consumidor Final, 6 Monotributo. Si falta y el receptor es CUIT, se sugiere segun el padron.' },
      receptorNombre: { type: 'string', description: 'Opcional. Nombre o razon social del receptor (para el PDF). Con CUIT, si falta se toma del padron.' },
      receptorDomicilio: { type: 'string', description: 'Opcional. Domicilio del receptor (para el PDF). Con CUIT, si falta se toma del padron.' },
      fecha: { type: 'string', description: 'Opcional. AAAA-MM-DD; por defecto hoy.' },
      importeNeto: { type: 'number', description: 'Neto gravado. En comprobantes C, el total.' },
      importeIva: { type: 'number', description: 'IVA total (0 en comprobantes C).' },
      importeExento: { type: 'number' },
      importeNoGravado: { type: 'number' },
      importeTributos: { type: 'number' },
      importeTotal: { type: 'number', description: 'Total del comprobante.' },
      alicuotasIva: {
        type: 'array',
        description: 'IVA por alicuota (A y B). id: 5 = 21%, 4 = 10,5%, 6 = 5%, 3 = 27%, 8 = 2,5%, 9 = 0%.',
        items: { type: 'object', properties: { id: { type: 'integer' }, baseImponible: { type: 'number' }, importe: { type: 'number' } }, required: ['id', 'baseImponible', 'importe'] },
      },
      comprobantesAsociados: {
        type: 'array',
        description: 'Obligatorio en notas de credito y debito: el comprobante que corrigen.',
        items: { type: 'object', properties: { tipo: { type: 'integer' }, puntoVenta: { type: 'integer' }, numero: { type: 'integer' }, cuit: { type: 'string' }, fecha: { type: 'string' } }, required: ['tipo', 'puntoVenta', 'numero'] },
      },
      fechaServicioDesde: { type: 'string' },
      fechaServicioHasta: { type: 'string' },
      fechaVtoPago: { type: 'string' },
      moneda: { type: 'string', description: 'PES por defecto. DOL, 060 (euro), etc.' },
      cotizacion: { type: 'number', description: 'Obligatoria si la moneda no es PES.' },
      idempotencyKey: { type: 'string', description: 'Opcional. Si ya se emitio uno con esta clave, se avisa.' },
      cuit_emisor: { type: 'string', description: 'CUIT emisor con certificado en Arcanum. Opcional si hay uno solo.' },
    },
    required: ['puntoVenta', 'tipoComprobante', 'importeTotal'],
    additionalProperties: false,
  },
  async ejecutar(args, ctx) {
    const emisor = await resolverEmisor(ctx, args.cuit_emisor);
    ctx.cuit = emisor;
    const inv = { ...args };
    delete inv.cuit_emisor;
    if (inv.tipoDocReceptor === 80 && inv.nroDocReceptor) ctx.cuitConsultado = tenants.normalizeCuit(inv.nroDocReceptor);
    return vistaPrevia.vistaPrevia(emisor, inv);
  },
};

// ---------- mis_comprobantes ----------
/** Filas de mc_comprobantes -> resumen por tipo (las notas de credito restan) + ultimos 50. */
function resumirMc(filas) {
  const { conSigno } = require('../services/tiposCbte');
  const grupo = () => ({ cantidad: 0, neto: 0, porTipo: {} });
  const out = { emitidos: grupo(), recibidos: grupo() };
  for (const f of filas) {
    const g = f.tipo === 'recibido' ? out.recibidos : out.emitidos;
    g.cantidad += 1;
    g.neto += conSigno(f.cbte_tipo, f.total);
    const nombre = TIPOS[f.cbte_tipo] || `Tipo ${f.cbte_tipo}`;
    g.porTipo[nombre] = (g.porTipo[nombre] || 0) + 1;
  }
  for (const g of [out.emitidos, out.recibidos]) g.neto = +g.neto.toFixed(2);
  const orden = [...filas].sort((a, b) => String(fechaIso(b.fecha)).localeCompare(String(fechaIso(a.fecha))));
  out.comprobantes = orden.slice(0, 50).map((f) => ({
    tipo: f.tipo,
    comprobante: formatearNumero(f.punto_venta, f.numero_desde),
    tipoComprobante: Number(f.cbte_tipo),
    tipoNombre: TIPOS[f.cbte_tipo] || null,
    fecha: fechaIso(f.fecha),
    importeTotal: Number(f.total),
    contraparte: { nombre: f.contraparte || null, documento: f.doc_nro || null },
    cae: f.cae || null,
  }));
  return out;
}

const misComprobantesTool = {
  nombre: 'mis_comprobantes',
  titulo: 'Mis Comprobantes (emitidos y recibidos)',
  descripcion:
    'Resumen de los comprobantes emitidos y recibidos de un CUIT segun Mis Comprobantes de ARCA, tal como Arcanum los '
    + 'bajo en su ultima sincronizacion (incluye los hechos por fuera de Arcanum). JSON con cantidad y neto por emitidos y '
    + 'recibidos (las notas de credito restan), cantidad por tipo, los ultimos 50 y la fecha de la ultima sincronizacion. No '
    + 'entra a ARCA ni dispara una sincronizacion: lee lo ya guardado. Solo lectura.',
  esquema: {
    type: 'object',
    properties: {
      cuit: { type: 'string', description: 'CUIT del contribuyente. Opcional si Arcanum tiene uno solo con Mis Comprobantes.' },
      tipo: { type: 'string', enum: ['emitido', 'recibido'], description: 'Opcional. Solo emitidos o solo recibidos.' },
      desde: { type: 'string', description: 'Opcional. Fecha minima, AAAA-MM-DD.' },
      hasta: { type: 'string', description: 'Opcional. Fecha maxima, AAAA-MM-DD.' },
    },
    additionalProperties: false,
  },
  async ejecutar(args, ctx) {
    let cuit;
    if (args.cuit) {
      cuit = cuit11(args.cuit);
    } else {
      const { rows } = await db.query('SELECT DISTINCT cuit FROM mc_comprobantes ORDER BY cuit');
      let lista = rows.map((r) => r.cuit);
      if (ctx.principal.cuitAllow && ctx.principal.cuitAllow.length) lista = lista.filter((c) => ctx.principal.cuitAllow.includes(c));
      if (lista.length !== 1) throw error(lista.length ? `Hay ${lista.length} CUITs con Mis Comprobantes; indica "cuit": ${lista.join(', ')}.` : 'Todavia no se sincronizo Mis Comprobantes para ningun CUIT.');
      cuit = lista[0];
    }
    assertCuitAllowed(ctx.principal, cuit);
    ctx.cuit = cuit;
    for (const campo of ['desde', 'hasta']) {
      if (args[campo] && !/^\d{4}-\d{2}-\d{2}$/.test(String(args[campo]))) throw error(`"${campo}" debe tener la forma AAAA-MM-DD`);
    }
    const mc = require('../services/misComprobantes').servicio();
    const filas = await mc.listar(cuit, { tipo: args.tipo, desde: args.desde, hasta: args.hasta, limite: 5000 });
    const corridas = await mc.corridas(cuit, 10);
    const ultima = corridas.find((c) => c.estado === 'terminado');
    return {
      cuit,
      filtros: { tipo: args.tipo || null, desde: args.desde || null, hasta: args.hasta || null },
      ...resumirMc(filas),
      ultimaSincronizacion: ultima ? { fecha: ultima.terminada_at, desde: fechaIso(ultima.desde), hasta: fechaIso(ultima.hasta), tipo: ultima.tipo } : null,
      fuente: 'Mis Comprobantes de ARCA, bajado por Arcanum',
    };
  },
};

// ---------- topes_monotributo ----------
const topesMonotributoTool = {
  nombre: 'topes_monotributo',
  titulo: 'Topes de Monotributo',
  descripcion:
    'Cuanto facturo un monotributista en los ultimos 12 meses contra el tope de su categoria. Suma Mis Comprobantes emitidos '
    + '(ya bajados) mas lo emitido por Arcanum que no este ahi, con las notas de credito restando. JSON con total, ventana de '
    + 'fechas, porcentaje usado, alerta (ok, 80 o 100), margen, categoria sugerida y la vigencia de los topes cargados (que '
    + 'conviene verificar). La categoria sale del padron o se indica. No es asesoramiento: es un calculo. Solo lectura.',
  esquema: {
    type: 'object',
    properties: {
      cuit: { type: 'string', description: 'CUIT del monotributista.' },
      categoria: { type: 'string', description: 'Opcional. Letra A a K si no se quiere tomar la del padron.' },
    },
    required: ['cuit'],
    additionalProperties: false,
  },
  async ejecutar(args, ctx) {
    const cuit = cuit11(args.cuit);
    assertCuitAllowed(ctx.principal, cuit);
    ctx.cuit = cuit;
    if (args.categoria && !/^[A-Ka-k]$/.test(String(args.categoria))) throw error('"categoria" debe ser una letra de la A a la K');
    const r = await require('../services/monotributo').topes(cuit, args.categoria ? { categoria: String(args.categoria).toUpperCase() } : {});
    return { ...r, fuente: 'Mis Comprobantes de ARCA + registro de Arcanum; topes cargados en Arcanum' };
  },
};

// ---------- constatacion_recibidos ----------
const constatacionTool = {
  nombre: 'constatacion_recibidos',
  titulo: 'Constatacion de comprobantes recibidos',
  descripcion:
    'Resultado ya guardado de la constatacion de los comprobantes RECIBIDOS de un CUIT (bajados de Mis Comprobantes): cuantos '
    + 'confirmo ARCA (WSCDC), cuantos no, cuantos falta constatar y cuantos emisores estan en la base de apocrifos (WSAPOC), '
    + 'mas el detalle de hasta 50 observados. No vuelve a consultar a ARCA: muestra lo ya constatado. Solo lectura.',
  esquema: {
    type: 'object',
    properties: { cuit: { type: 'string', description: 'CUIT que recibio los comprobantes.' } },
    required: ['cuit'],
    additionalProperties: false,
  },
  async ejecutar(args, ctx) {
    const cuit = cuit11(args.cuit);
    assertCuitAllowed(ctx.principal, cuit);
    ctx.cuit = cuit;
    const r = await require('../services/constatacion').resumenGuardado(cuit);
    return {
      cuit,
      recibidos: r.total,
      pendientes: r.pendientes,
      validos: r.validos,
      invalidos: r.invalidos,
      emisoresApocrifos: r.emisores_apocrifos,
      observados: r.observados.map((o) => ({
        comprobante: formatearNumero(o.punto_venta, o.numero_desde),
        tipoComprobante: Number(o.cbte_tipo),
        tipoNombre: TIPOS[o.cbte_tipo] || null,
        fecha: fechaIso(o.fecha),
        importeTotal: Number(o.total),
        emisor: { cuit: o.doc_nro, nombre: o.contraparte || null },
        valido: o.constatacion ? o.constatacion.valido : null,
        apocrifo: o.constatacion && o.constatacion.apoc ? o.constatacion.apoc.esApocrifo : null,
        observaciones: o.constatacion ? o.constatacion.observaciones || [] : [],
      })),
      fuente: 'WSCDC y WSAPOC de ARCA (resultado guardado por Arcanum)',
    };
  },
};

// ---------- cola_emision ----------
const colaTool = {
  nombre: 'cola_emision',
  titulo: 'Cola de emision (contingencia)',
  descripcion:
    'Comprobantes que quedaron en la cola porque ARCA no respondia al emitir: estado (pendiente, emitido, rechazado, '
    + 'requiere_humano, cancelado), intentos, proximo intento, ultimo error y, si ya salieron, el CAE. Sirve para saber si '
    + 'una factura pedida durante una caida de ARCA ya se emitio. No reintenta ni cancela nada. Solo lectura.',
  esquema: {
    type: 'object',
    properties: {
      cuit: { type: 'string', description: 'Opcional. CUIT emisor.' },
      estado: { type: 'string', enum: ['pendiente', 'procesando', 'emitido', 'rechazado', 'requiere_humano', 'cancelado'], description: 'Opcional.' },
    },
    additionalProperties: false,
  },
  async ejecutar(args, ctx) {
    const cuit = args.cuit ? cuit11(args.cuit) : undefined;
    if (cuit) { assertCuitAllowed(ctx.principal, cuit); ctx.cuit = cuit; }
    let lista = await require('../services/colaEmision').servicio().listar({ cuit, estado: args.estado, limite: 100 });
    if (ctx.principal.cuitAllow && ctx.principal.cuitAllow.length) lista = lista.filter((x) => ctx.principal.cuitAllow.includes(x.cuit));
    const porEstado = {};
    for (const x of lista) porEstado[x.estado] = (porEstado[x.estado] || 0) + 1;
    return {
      cantidad: lista.length,
      porEstado,
      items: lista.slice(0, 50).map((x) => ({
        id: x.id, cuit: x.cuit, estado: x.estado, modo: x.modo, intentos: x.intentos,
        fecha: fechaIso(x.fecha), importeTotal: Number(x.cuerpo && x.cuerpo.importeTotal),
        proximoIntento: x.proximo_intento_at, ultimoError: x.ultimo_error || null,
        cae: x.resultado && x.resultado.cae ? x.resultado.cae : null,
        comprobante: x.resultado && x.resultado.numero ? formatearNumero(x.resultado.puntoVenta, x.resultado.numero) : null,
      })),
      fuente: 'Cola de emision de Arcanum',
    };
  },
};

// ---------- Factorum (facturas recibidas) ----------
// Proxy de solo consulta a Factorum, el lector de facturas. Sin Factorum configurado, cada
// herramienta devuelve un error claro (no se cae ni inventa datos).
const IMPORTES_FACTORUM = ['neto_gravado', 'no_gravado', 'exento', 'iva_27', 'iva_21', 'iva_10_5', 'iva_5', 'iva_2_5', 'otros_tributos', 'total'];

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Comprobante de Factorum (campos de modelo.Comprobante, planos o en `comprobante`) -> datos clave. */
function resumirCbteFactorum(c) {
  const x = c && c.comprobante && typeof c.comprobante === 'object' ? { ...c, ...c.comprobante } : (c || {});
  const importes = {};
  for (const k of IMPORTES_FACTORUM) {
    const v = num(x[k]);
    if (v !== null && (v !== 0 || k === 'total')) importes[k] = v;
  }
  const hallazgos = Array.isArray(x.hallazgos) ? x.hallazgos : [];
  const cons = x.constatacion && typeof x.constatacion === 'object' ? x.constatacion : null;
  return {
    id: x.id !== undefined ? x.id : null,
    lote: x.lote_id !== undefined ? x.lote_id : null,
    cliente: x.cliente_cuit || null,
    archivo: x.archivo || null,
    tipoComprobante: x.tipo ? Number(x.tipo) : null,
    tipoNombre: TIPOS[x.tipo] || null,
    letra: x.letra || null,
    comprobante: x.punto_venta !== undefined && x.numero !== undefined ? formatearNumero(x.punto_venta, x.numero) : null,
    fecha: x.fecha || null,
    emisor: { cuit: x.cuit_emisor || null, nombre: x.razon_social_emisor || null },
    receptor: x.doc_nro_receptor ? { documento: x.doc_nro_receptor, nombre: x.razon_social_receptor || null } : null,
    moneda: x.moneda || null,
    importes,
    cae: x.cae || null,
    vtoCae: x.vto_cae || null,
    estado: x.estado || null,
    confianza: num(x.confianza),
    hallazgos: hallazgos.slice(0, 20).map((h) => ({ nivel: h.nivel, codigo: h.codigo, mensaje: h.mensaje, campo: h.campo || null })),
    constatacion: cons ? { valido: cons.valido === undefined ? null : cons.valido, resultado: cons.resultado || null, apocrifo: cons.apoc ? !!cons.apoc.esApocrifo : null, observaciones: cons.observaciones || [] } : null,
    duplicadoDe: x.duplicado_de || null,
    revisadoPor: x.revisado_por || null,
  };
}

function crearHerramientasFactorum({ factorum } = {}) {
  const fa = () => factorum || require('../services/factorum');
  const { clienteDelAlcance, consultanteDelAlcance, assertRecursoEnAlcance } = require('../rutas/factorum');
  const FUENTE = 'Factorum (lector de facturas conectado a Arcanum)';
  const fecha = (v, campo) => {
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw error(`"${campo}" debe tener la forma AAAA-MM-DD`);
    return v || undefined;
  };
  const filtros = (args, ctx) => {
    const cliente = clienteDelAlcance(ctx.principal, args.cliente);
    if (cliente) ctx.cuit = cliente;
    return {
      cliente,
      emisor: args.emisor ? cuit11(args.emisor, 'emisor') : undefined,
      estado: args.estado || undefined,
      desde: fecha(args.desde, 'desde'),
      hasta: fecha(args.hasta, 'hasta'),
      q: args.q || undefined,
      lote: args.lote !== undefined && args.lote !== null && args.lote !== '' ? entero(args.lote, 'lote') : undefined,
    };
  };
  const filtrosEsquema = {
    cliente: { type: 'string', description: 'Opcional. CUIT del cliente del estudio al que pertenecen. Obligatorio si la clave esta limitada a varios CUITs.' },
    emisor: { type: 'string', description: 'Opcional. CUIT del emisor (el proveedor).' },
    estado: { type: 'string', enum: ['ok', 'revisar', 'error', 'aprobado'], description: 'Opcional. Estado en Factorum.' },
    desde: { type: 'string', description: 'Opcional. Fecha de emision minima, AAAA-MM-DD.' },
    hasta: { type: 'string', description: 'Opcional. Fecha de emision maxima, AAAA-MM-DD.' },
    q: { type: 'string', description: 'Opcional. Busca en razon social, CUIT y numero.' },
    lote: { type: 'integer', minimum: 1, description: 'Opcional. Id del lote.' },
  };

  const buscar = {
    nombre: 'facturas_recibidas',
    titulo: 'Facturas recibidas (Factorum)',
    descripcion:
      'Busca las facturas recibidas que leyo Factorum (el lector de facturas conectado a Arcanum: QR, texto, OCR e IA). '
      + 'JSON con el total y hasta 50 comprobantes: tipo, numero, fecha, emisor, importes por alicuota, CAE, estado (ok, '
      + 'revisar, error, aprobado), hallazgos de los controles y la constatacion con ARCA. Filtros por cliente, emisor, estado, '
      + 'fechas, texto y lote. Si Factorum no esta configurado, devuelve un error. Solo lectura.',
    esquema: {
      type: 'object',
      properties: { ...filtrosEsquema, limite: { type: 'integer', minimum: 1, maximum: 50, description: 'Opcional. Cuantos traer (hasta 50; por defecto 20).' } },
      additionalProperties: false,
    },
    async ejecutar(args, ctx) {
      const f = filtros(args, ctx);
      const limite = args.limite ? Math.min(50, entero(args.limite, 'limite')) : 20;
      const r = await fa().comprobantes({ ...f, limite });
      const lista = Array.isArray(r.comprobantes) ? r.comprobantes : [];
      return {
        filtros: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)),
        total: r.total !== undefined ? r.total : lista.length,
        cantidad: Math.min(lista.length, limite),
        comprobantes: lista.slice(0, limite).map(resumirCbteFactorum),
        fuente: FUENTE,
      };
    },
  };

  const una = {
    nombre: 'factura_recibida',
    titulo: 'Una factura recibida (Factorum)',
    descripcion:
      'Una factura recibida leida por Factorum, por su id: todos sus datos clave, los hallazgos de los controles, la '
      + 'constatacion con ARCA, de donde salio cada campo y las correcciones hechas a mano (antes, despues, quien y cuando). '
      + 'Si Factorum no esta configurado, devuelve un error. Solo lectura.',
    esquema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1, description: 'Id del comprobante en Factorum (sale de facturas_recibidas).' } },
      required: ['id'],
      additionalProperties: false,
    },
    async ejecutar(args, ctx) {
      const id = entero(args.id, 'id');
      const r = await fa().comprobante(id);
      if (!r || !r.comprobante) throw error('No existe ese comprobante en Factorum');
      assertRecursoEnAlcance(ctx.principal, r.comprobante.cliente_cuit);
      if (r.comprobante.cliente_cuit) ctx.cuit = r.comprobante.cliente_cuit;
      return {
        ...resumirCbteFactorum(r.comprobante),
        origenes: r.comprobante.origenes || {},
        correcciones: (r.correcciones || []).slice(0, 50),
        fuente: FUENTE,
      };
    },
  };

  const resumen = {
    nombre: 'resumen_facturas_recibidas',
    titulo: 'Resumen de facturas recibidas (Factorum)',
    descripcion:
      'Totales de las facturas recibidas que leyo Factorum: cantidad, neto gravado, IVA por alicuota, otros tributos y '
      + 'total (las notas de credito restan), mas la cantidad por estado y por tipo. Mismos filtros que facturas_recibidas. '
      + 'Sirve para el libro IVA compras de un cliente en un periodo. Si Factorum no esta configurado, devuelve un error. '
      + 'Solo lectura.',
    esquema: { type: 'object', properties: filtrosEsquema, additionalProperties: false },
    async ejecutar(args, ctx) {
      const f = filtros(args, ctx);
      const r = await fa().resumen(f);
      return {
        filtros: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)),
        resumen: r.resumen || {},
        fuente: FUENTE,
      };
    },
  };

  const verificar = {
    nombre: 'verificar_factura',
    titulo: 'Verificar una factura (Factorum)',
    descripcion:
      'Dice si una factura es legal: Factorum la lee (QR, texto, OCR), corre los controles, la constata con ARCA (WSCDC) y '
      + 'busca al emisor en la base de apocrifos. JSON con el veredicto (valida, invalida, apocrifa, con_errores o '
      + 'no_verificable), el motivo, los datos clave de cada comprobante del archivo y sus hallazgos. No guarda nada: ni el '
      + 'archivo ni el resultado quedan en Factorum. Archivo en base64 (PDF, JPG, PNG o WEBP; por MCP, hasta 1,4 MB). Si '
      + 'Factorum no esta configurado, devuelve un error. Solo lectura.',
    esquema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre del archivo, con su extension (ej. factura.pdf).' },
        contenido_base64: { type: 'string', description: 'El archivo en base64.' },
        cuit_consultante: { type: 'string', description: 'Opcional. CUIT con certificado en Arcanum con el que se constata (quien recibio la factura). Si falta y la clave tiene un unico CUIT, se usa ese.' },
      },
      required: ['nombre', 'contenido_base64'],
      additionalProperties: false,
    },
    async ejecutar(args, ctx) {
      if (!args.nombre || !args.contenido_base64) throw error('Faltan "nombre" y "contenido_base64"');
      const cuitConsultante = consultanteDelAlcance(ctx.principal, args.cuit_consultante);
      if (cuitConsultante) ctx.cuit = cuitConsultante;
      const r = await fa().verificar({ nombre: String(args.nombre), contenidoBase64: String(args.contenido_base64), cuitConsultante });
      const res = r.resultado || {};
      return {
        veredicto: r.veredicto || null,
        mensaje: r.mensaje || null,
        archivo: { nombre: res.archivo || String(args.nombre), sha256: res.sha256 || null, paginas: res.paginas || null },
        comprobantes: (Array.isArray(res.comprobantes) ? res.comprobantes : []).slice(0, 20).map(resumirCbteFactorum),
        constatacion: (Array.isArray(r.constatacion) ? r.constatacion : []).slice(0, 20),
        guardado: false,
        fuente: FUENTE,
      };
    },
  };

  return [buscar, una, resumen, verificar];
}

const HERRAMIENTAS = [
  padronTool, comprobanteTool, ultimoTool, puntosTool, estadoTool,
  riesgoTool, recientesTool, ventanillaTool, certTool, vistaPreviaTool,
  misComprobantesTool, topesMonotributoTool, constatacionTool, colaTool,
  ...crearHerramientasFactorum(),
];

module.exports = {
  HERRAMIENTAS,
  crearHerramientasFactorum,
  // Funciones puras expuestas para tests.
  _internos: { parseTipo, parseComprobante, formatearNumero, fechaIso, cuit11, resumirPadron, estadoLeida, resumirMc, resumirCbteFactorum, TIPOS },
};
