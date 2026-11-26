'use strict';

// Datos del encabezado legal del PDF (emisor y receptor).
//
// Lo que ARCA expone por web service (padron A5 / constancia de inscripcion) se completa solo:
// razon social, domicilio y condicion frente al IVA del emisor, y nombre y domicilio del receptor
// con CUIT. Lo que ARCA NO expone (Ingresos Brutos, que es provincial, y la fecha de inicio de
// actividades) lo carga el usuario: aca solo se informa como faltante.
//
// Reglas: nunca se pisa un dato cargado a mano; el padron es best-effort (si falla, se emite y se
// imprime igual) y una falla se recuerda un rato para no golpear a ARCA en cada PDF o emision.

const { analizarPadron } = require('./contribuyente');
const { normalizeCuit } = require('../auth/tenants');

const CAMPOS_EMISOR = [
  { campo: 'razonSocial', etiqueta: 'Razón social', padron: 'nombre' },
  { campo: 'domicilio', etiqueta: 'Domicilio comercial', padron: 'domicilio' },
  { campo: 'condicionIva', etiqueta: 'Condición frente al IVA', padron: 'condicionIva' },
  { campo: 'iibb', etiqueta: 'Ingresos Brutos' },
  { campo: 'inicioActividades', etiqueta: 'Fecha de inicio de actividades' },
];
const DEL_PADRON = CAMPOS_EMISOR.filter((c) => c.padron);
const CUIT_DOC = 80;
const ESPERA_FALLA_MS = 6 * 60 * 60 * 1000;
const ESPERA_RECEPTOR_MS = 4000;

const fallas = new Map(); // cuitRepresentada -> momento de la ultima falla del padron

const COND = { MONOTRIBUTISTA: 'MONOTRIBUTO', RESPONSABLE_INSCRIPTO: 'RI', EXENTO: 'EXENTO' };

/** Domicilio fiscal al estilo de la factura de ARCA: "direccion - localidad, provincia". */
function domicilioDe(dg) {
  const d = dg && dg.domicilioFiscal;
  if (!d || !d.direccion) return null;
  const lugar = [d.localidad, d.descripcionProvincia].filter(Boolean)
    .filter((x, i, a) => a.findIndex((y) => String(y).toUpperCase() === String(x).toUpperCase()) === i).join(', ');
  return [String(d.direccion).trim(), lugar].filter(Boolean).join(' - ');
}

/** Ficha para imprimir a partir de la respuesta del padron A5. Pura. */
function fichaDesdePadron(datosA5 = {}) {
  const a = analizarPadron(datosA5 || {});
  return {
    nombre: a.nombre && a.nombre !== 'N/A' ? a.nombre : null,
    domicilio: domicilioDe(a.dg),
    condicionIva: COND[a.tipoContribuyente] || null,
  };
}

/** Datos del emisor que el PDF necesita y no estan cargados. */
function faltantesEmisor(emisor = {}) {
  return CAMPOS_EMISOR.filter((c) => !String((emisor && emisor[c.campo]) || '').trim())
    .map(({ campo, etiqueta, padron }) => ({ campo, etiqueta, desdeArca: !!padron }));
}

function consultarPadronReal(repre, cuit) {
  const padron = require('./padron');
  return padron.consultarPersonaConMeta('a5', repre, cuit).then((r) => fichaDesdePadron(r.datos));
}

async function consultarRecordandoFallas(consultar, repre, cuit, forzar) {
  const ultima = fallas.get(repre);
  if (!forzar && ultima && Date.now() - ultima < ESPERA_FALLA_MS) {
    throw new Error('El padrón de ARCA falló hace poco para este CUIT; se vuelve a intentar más tarde.');
  }
  try {
    const f = await consultar(repre, cuit);
    fallas.delete(repre);
    return f;
  } catch (e) {
    fallas.set(repre, Date.now());
    throw e;
  }
}

/**
 * Completa los datos del emisor que salen del padron y estan vacios; los guarda.
 * @returns {{ emisor, completados: string[], faltan: object[], error?: string }}
 */
async function completarEmisor(cuit, { emisores = require('./emisores'), consultar = consultarPadronReal, forzar = false } = {}) {
  const c = normalizeCuit(cuit);
  const actual = (await emisores.get(c)) || {};
  const vacios = DEL_PADRON.filter((x) => !String(actual[x.campo] || '').trim());
  if (!vacios.length) return { emisor: actual, completados: [], faltan: faltantesEmisor(actual) };

  let ficha;
  try {
    ficha = await consultarRecordandoFallas(consultar, c, c, forzar);
  } catch (e) {
    return { emisor: actual, completados: [], faltan: faltantesEmisor(actual), error: String(e.message || e).slice(0, 300) };
  }
  const nuevo = { ...actual };
  const completados = [];
  for (const x of vacios) {
    if (ficha && ficha[x.padron]) { nuevo[x.campo] = ficha[x.padron]; completados.push(x.campo); }
  }
  const emisor = completados.length ? await emisores.set(c, nuevo) : actual;
  return { emisor, completados, faltan: faltantesEmisor(emisor) };
}

/**
 * Nombre y domicilio del receptor con CUIT que no vinieron en el pedido. Devuelve SOLO los campos
 * a agregar ({} si no hay nada que hacer o el padron no contesta a tiempo). Nunca tira.
 * @param {object} datos { tipoDocReceptor, nroDocReceptor, receptorNombre?, receptorDomicilio? }
 */
async function completarReceptor(cuitEmisor, datos = {}, { consultar = consultarPadronReal, espera = ESPERA_RECEPTOR_MS } = {}) {
  if (Number(datos.tipoDocReceptor) !== CUIT_DOC) return {};
  const nro = normalizeCuit(datos.nroDocReceptor);
  if (!nro || nro.length !== 11) return {};
  const tieneNombre = !!String(datos.receptorNombre || '').trim();
  const tieneDomicilio = !!String(datos.receptorDomicilio || '').trim();
  if (tieneNombre && tieneDomicilio) return {};
  let timer;
  try {
    const ficha = await Promise.race([
      consultarRecordandoFallas(consultar, normalizeCuit(cuitEmisor), nro, false),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('padrón lento')), espera); }),
    ]);
    const out = {};
    if (!tieneNombre && ficha && ficha.nombre) out.receptorNombre = ficha.nombre;
    if (!tieneDomicilio && ficha && ficha.domicilio) out.receptorDomicilio = ficha.domicilio;
    return out;
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fichaDesdePadron, faltantesEmisor, completarEmisor, completarReceptor, CAMPOS_EMISOR, _reset: () => fallas.clear() };
