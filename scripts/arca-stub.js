'use strict';

// Stub de ARCA (WSAA + WSFEv1) para pruebas de punta a punta. NUNCA se usa contra ARCA real:
// Arcanum se apunta acá con ARCANUM_ENDPOINT_WSAA / ARCANUM_ENDPOINT_WSFEV1 (solo homologación).
//
// Imita lo que importa: numeración por (CUIT, punto de venta, tipo), CAE, consultas, puntos de
// venta (uno CAE y uno CAEA), CAEA por quincena, informe y "sin movimiento". Valida los nombres
// de elemento como ARCA: si falta FeCabReq responde la misma NullReferenceException.
//
// Modos (POST /_modo?m=...):  ok | caido (HTTP 503) | lento (otorga el CAE y no contesta a tiempo)
// POST /_fuera { cuit, pv, tipo, importe, fecha }  -> comprobante "emitido por fuera de Arcanum"
// GET  /_estado                                     -> estado interno (JSON)

const http = require('http');

const PUERTO = Number(process.argv[2] || process.env.PUERTO || 8099);
const DEMORA_LENTO_MS = Number(process.env.DEMORA_LENTO_MS || 6000);

let modo = 'ok';
const ultimos = {}; // "cuit|pv|tipo" -> número
const cbtes = {}; // "cuit|pv|tipo|n" -> datos
const caeas = {}; // "cuit|periodo|orden" -> datos
const informados = [];
const sinMov = [];
let cae = 76000000000000;

const PTOS = [{ Nro: 1, EmisionTipo: 'CAE - Factura Electronica', Bloqueado: 'N', FchBaja: 'NULL' }, { Nro: 9, EmisionTipo: 'CAEA', Bloqueado: 'N', FchBaja: 'NULL' }];

const tag = (xml, t) => { const m = String(xml).match(new RegExp(`<(?:\\w+:)?${t}>([^<]*)</(?:\\w+:)?${t}>`)); return m ? m[1] : null; };
const hoyYmd = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
const masDias = (ymd, d) => { const f = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + d)); return f.toISOString().slice(0, 10).replace(/-/g, ''); };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function obj(o) {
  if (o === null || o === undefined) return '';
  if (Array.isArray(o)) return o.map(obj).join('');
  if (typeof o !== 'object') return esc(o);
  return Object.entries(o).map(([k, v]) => (Array.isArray(v) ? v.map((x) => `<${k}>${obj(x)}</${k}>`).join('') : `<${k}>${obj(v)}</${k}>`)).join('');
}

function sobre(metodo, resultado) {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>`
    + `<${metodo}Response xmlns="http://ar.gov.afip.dif.FEV1/"><${metodo}Result>${obj(resultado)}</${metodo}Result></${metodo}Response></soap:Body></soap:Envelope>`;
}

function fault(msg) {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>${esc(msg)}</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
}

const errNoExiste = { Errors: { Err: { Code: 602, Msg: 'No existen datos en nuestros registros para los parametros ingresados.' } } };

function wsaa(res) {
  const exp = new Date(Date.now() + 12 * 3600000).toISOString();
  const ta = `<?xml version="1.0" encoding="UTF-8"?><loginTicketResponse version="1.0"><header><source>stub</source><destination>stub</destination><uniqueId>1</uniqueId><generationTime>${new Date().toISOString()}</generationTime><expirationTime>${exp}</expirationTime></header><credentials><token>TOKEN-STUB</token><sign>SIGN-STUB</sign></credentials></loginTicketResponse>`;
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(`<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><loginCmsResponse><loginCmsReturn>${esc(ta)}</loginCmsReturn></loginCmsResponse></soapenv:Body></soapenv:Envelope>`);
}

async function wsfev1(body, res) {
  const metodo = (body.match(/<(?:\w+:)?(FE\w+)>/) || [])[1] || 'desconocido';
  const responder = (r) => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(sobre(metodo, r)); };
  if (metodo === 'FEDummy') return responder({ AppServer: 'OK', DbServer: 'OK', AuthServer: 'OK' });
  if (modo === 'caido') { res.writeHead(503); return res.end('Service Unavailable'); }
  const cuit = tag(body, 'Cuit');

  if (metodo === 'FECompUltimoAutorizado') {
    const pv = tag(body, 'PtoVta'); const tipo = tag(body, 'CbteTipo');
    return responder({ PtoVta: pv, CbteTipo: tipo, CbteNro: ultimos[`${cuit}|${pv}|${tipo}`] || 0 });
  }
  if (metodo === 'FEParamGetPtosVenta') return responder({ ResultGet: { PtoVenta: PTOS } });
  if (metodo === 'FECompConsultar') {
    const c = cbtes[`${cuit}|${tag(body, 'PtoVta')}|${tag(body, 'CbteTipo')}|${tag(body, 'CbteNro')}`];
    if (!c) return responder(errNoExiste);
    return responder({ ResultGet: { Concepto: 1, DocTipo: c.docTipo, DocNro: c.docNro, CbteDesde: c.n, CbteHasta: c.n, CbteFch: c.fecha, ImpTotal: c.importe, MonId: 'PES', Resultado: 'A', CodAutorizacion: c.cae, EmisionTipo: 'CAE', FchVto: masDias(c.fecha, 10), PtoVta: c.pv, CbteTipo: c.tipo } });
  }
  if (metodo === 'FECAESolicitar') {
    if (!/<(?:\w+:)?FeCabReq>/.test(body) || !/<(?:\w+:)?FeDetReq>/.test(body) || !/<(?:\w+:)?CbteFch>/.test(body)) {
      res.writeHead(500, { 'Content-Type': 'text/xml' });
      return res.end(fault('Server was unable to process request. ---> System.NullReferenceException: Object reference not set to an instance of an object.'));
    }
    const pv = tag(body, 'PtoVta'); const tipo = tag(body, 'CbteTipo'); const n = Number(tag(body, 'CbteDesde'));
    const k = `${cuit}|${pv}|${tipo}`;
    if (n !== (ultimos[k] || 0) + 1) {
      return responder({ FeCabResp: { Cuit: cuit, PtoVta: pv, CbteTipo: tipo, Resultado: 'R' }, FeDetResp: { FECAEDetResponse: { CbteDesde: n, CbteHasta: n, Resultado: 'R', Observaciones: { Obs: { Code: 10016, Msg: `El numero o fecha del comprobante no se corresponde con el proximo a autorizar (${(ultimos[k] || 0) + 1})` } } } } });
    }
    ultimos[k] = n; cae += 1;
    const c = { pv, tipo, n, cae: String(cae), importe: Number(tag(body, 'ImpTotal')), docTipo: tag(body, 'DocTipo'), docNro: tag(body, 'DocNro'), fecha: tag(body, 'CbteFch') };
    cbtes[`${k}|${n}`] = c;
    const r = { FeCabResp: { Cuit: cuit, PtoVta: pv, CbteTipo: tipo, FchProceso: hoyYmd(), CantReg: 1, Resultado: 'A' }, FeDetResp: { FECAEDetResponse: { Concepto: 1, DocTipo: c.docTipo, DocNro: c.docNro, CbteDesde: n, CbteHasta: n, CbteFch: c.fecha, Resultado: 'A', CAE: c.cae, CAEFchVto: masDias(c.fecha, 10) } } };
    if (modo === 'lento') await new Promise((ok) => setTimeout(ok, DEMORA_LENTO_MS)); // otorgado, pero la respuesta no llega a tiempo
    return responder(r);
  }
  if (metodo === 'FECAEASolicitar' || metodo === 'FECAEAConsultar') {
    const periodo = tag(body, 'Periodo'); const orden = Number(tag(body, 'Orden'));
    const k = `${cuit}|${periodo}|${orden}`;
    if (!caeas[k]) {
      if (metodo === 'FECAEAConsultar') return responder(errNoExiste);
      const desde = `${periodo}${orden === 1 ? '01' : '16'}`;
      const hasta = orden === 1 ? `${periodo}15` : masDias(`${periodo}01`, 0).slice(0, 6) + String(new Date(Date.UTC(+periodo.slice(0, 4), +periodo.slice(4, 6), 0)).getUTCDate());
      caeas[k] = { CAEA: String(31000000000000 + Object.keys(caeas).length + 1), Periodo: periodo, Orden: orden, FchVigDesde: desde, FchVigHasta: hasta, FchTopeInf: masDias(hasta, 8), FchProceso: hoyYmd() };
    }
    return responder({ ResultGet: caeas[k] });
  }
  if (metodo === 'FECAEARegInformativo') {
    const det = { pv: tag(body, 'PtoVta'), tipo: tag(body, 'CbteTipo'), n: tag(body, 'CbteDesde'), caea: tag(body, 'CAEA'), fchHsGen: tag(body, 'CbteFchHsGen') };
    informados.push(det);
    return responder({ FeCabResp: { Cuit: cuit, PtoVta: det.pv, CbteTipo: det.tipo, Resultado: 'A' }, FeDetResp: { FECAEADetResponse: { CbteDesde: det.n, CbteHasta: det.n, Resultado: 'A', CAEA: det.caea } } });
  }
  if (metodo === 'FECAEASinMovimientoInformar') {
    sinMov.push({ pv: tag(body, 'PtoVta'), caea: tag(body, 'CAEA') });
    return responder({ CAEA: tag(body, 'CAEA'), PtoVta: tag(body, 'PtoVta'), FchProceso: hoyYmd(), Resultado: 'A' });
  }
  res.writeHead(500, { 'Content-Type': 'text/xml' });
  return res.end(fault(`Método no soportado por el stub: ${metodo}`));
}

const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/_modo') { modo = url.searchParams.get('m') || 'ok'; res.end(JSON.stringify({ modo })); return; }
      if (url.pathname === '/_estado') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ modo, ultimos, cbtes, caeas, informados, sinMov })); return; }
      if (url.pathname === '/_fuera') {
        const d = JSON.parse(body || '{}');
        const k = `${d.cuit}|${d.pv}|${d.tipo}`;
        const n = (ultimos[k] || 0) + 1; ultimos[k] = n; cae += 1;
        cbtes[`${k}|${n}`] = { pv: String(d.pv), tipo: String(d.tipo), n, cae: String(cae), importe: Number(d.importe || 100), docTipo: 99, docNro: '0', fecha: d.fecha || hoyYmd() };
        res.end(JSON.stringify({ numero: n, cae: String(cae) }));
        return;
      }
      if (url.pathname.includes('LoginCms')) return wsaa(res);
      return await wsfev1(body, res);
    } catch (e) {
      res.writeHead(500); res.end(String(e.message));
    }
  });
});

srv.listen(PUERTO, '0.0.0.0', () => console.log(`stub de ARCA en :${PUERTO}`));
