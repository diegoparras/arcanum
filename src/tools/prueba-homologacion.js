'use strict';

// Prueba de punta a punta de la emision contra ARCA HOMOLOGACION (nunca produccion).
// Saca un CAE real de prueba y verifica todo el circuito:
//   FEDummy -> ultimo numero -> vista previa -> emision -> FECompConsultar (el CAE
//   coincide) -> reintento con la misma clave de idempotencia (devuelve el mismo, sin
//   pedir otro CAE).
//
// Requisito: el CUIT tiene cargado un certificado de HOMOLOGACION (lo emite "Computadores
// Test" desde WSASS) con el servicio wsfe asociado. Ver DESPLIEGUE.md.
//
// Uso (dentro del contenedor):
//   docker compose exec arcanum node src/tools/prueba-homologacion.js --cuit 20111111112 [--pv 1] [--tipo 11] [--total 100]

const { config } = require('../config');

// Este proceso trabaja SOLO en homologacion, sin importar el entorno del servidor.
config.setEnv('homo');
if (!/homo/.test(config.endpoints.wsfev1)) {
  console.error('Abortado: el endpoint de WSFEv1 no es de homologación.');
  process.exit(2);
}

const db = require('../db');
const tenants = require('../auth/tenants');
const wsfev1 = require('../services/wsfev1');
const vistaPrevia = require('../services/vistaPrevia');

function arg(nombre, def) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const pasos = [];
function paso(nombre, ok, detalle) {
  pasos.push({ nombre, ok });
  console.log(`${ok ? '[OK]   ' : '[FALLA]'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  return ok;
}

async function main() {
  await db.waitForDb(5, 1000);
  const lista = (await tenants.list('homo')).filter((t) => t.tieneCertificado && !t.certVencido);
  const cuit = tenants.normalizeCuit(arg('cuit', lista.length === 1 ? lista[0].cuit : ''));
  if (!cuit) {
    console.error(`Indicá --cuit. CUITs con certificado de homologación: ${lista.map((t) => t.cuit).join(', ') || 'ninguno'}.`);
    process.exit(2);
  }
  if (!paso('Certificado de homologación cargado', lista.some((t) => t.cuit === cuit), cuit)) return;

  const tipo = parseInt(arg('tipo', '11'), 10);
  const total = Number(arg('total', '100'));
  let pv = parseInt(arg('pv', '0'), 10);

  const d = await wsfev1.dummy();
  if (!paso('ARCA homologación responde (FEDummy)', [d.appServer, d.dbServer, d.authServer].every((x) => String(x).toUpperCase() === 'OK'), JSON.stringify(d))) return;

  if (!pv) {
    try {
      const pts = await wsfev1.getParams(cuit, 'puntosVenta');
      const hab = pts.find((p) => String(p.Bloqueado || '').toUpperCase() !== 'S' && !(p.FchBaja && String(p.FchBaja).toUpperCase() !== 'NULL'));
      pv = hab ? Number(hab.Nro) : 1;
    } catch {
      pv = 1; // en homologacion suele no haber puntos de venta dados de alta: se usa el 1
    }
  }
  const ultimo = await wsfev1.lastAuthorized(cuit, pv, tipo);
  paso('Último número autorizado (token WSAA + FECompUltimoAutorizado)', true, `pv ${pv}, tipo ${tipo}: ${ultimo.ultimoNumero}`);

  const esC = [11, 12, 13].includes(tipo);
  const neto = esC ? total : +(total / 1.21).toFixed(2);
  const iva = esC ? 0 : +(total - neto).toFixed(2);
  const inv = {
    cuit, puntoVenta: pv, tipoComprobante: tipo, concepto: 1,
    tipoDocReceptor: 99, nroDocReceptor: '0', condicionIvaReceptor: 5,
    importeNeto: neto, importeIva: iva, importeTotal: total,
    alicuotasIva: esC ? [] : [{ id: 5, baseImponible: neto, importe: iva }],
    receptorNombre: 'Prueba de homologacion',
    idempotencyKey: `homo-prueba-${Date.now()}`,
  };

  const prev = await vistaPrevia.vistaPrevia(cuit, inv);
  if (!paso('Vista previa sin problemas', prev.valido, prev.valido ? `número propuesto ${prev.numeroPropuesto}` : prev.problemas.join(' | '))) return;

  const emi = await wsfev1.authorizeInvoice(cuit, inv);
  if (!paso('Emisión aprobada con CAE', emi.aprobado && !!emi.cae, emi.aprobado ? `CAE ${emi.cae}, vence ${emi.caeVencimiento}, número ${emi.numero}` : JSON.stringify({ errores: emi.errores, observaciones: emi.observaciones }))) return;
  paso('El número emitido es el que anticipó la vista previa', emi.numero === prev.numeroPropuesto, `${emi.numero} vs ${prev.numeroPropuesto}`);

  const cons = await wsfev1.consultar(cuit, pv, tipo, emi.numero);
  paso('ARCA devuelve el mismo CAE (FECompConsultar)', String(cons.cae) === String(emi.cae), `${cons.cae}`);

  const rei = await wsfev1.authorizeInvoice(cuit, inv);
  paso('Reintento idempotente: mismo comprobante, sin CAE nuevo', rei.idempotente === true && rei.cae === emi.cae && rei.numero === emi.numero);
}

main()
  .catch((e) => paso('Error inesperado', false, e.message))
  .finally(async () => {
    const fallas = pasos.filter((p) => !p.ok).length;
    console.log(`\n${fallas ? `PRUEBA FALLIDA: ${fallas} de ${pasos.length} pasos` : `PRUEBA OK: ${pasos.length} pasos`} (homologación, nada se emitió en producción)`);
    await db.pool.end().catch(() => {});
    process.exit(fallas ? 1 : 0);
  });
