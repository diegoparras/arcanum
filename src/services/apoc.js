'use strict';

// WSAPOC - Consulta de la base de "Facturas Apocrifas" / contribuyentes con
// comprobantes apocrifos (ex-APOC). Servicio WSAA: `wsapoc`.
//   Operacion: GetPublicacionAPOC(credencial{Token,Sign,CUITDelegado}, cuit)
//   Endpoint .NET (.asmx), namespace tempuri.org, SOAPAction tempuri/{op}.
//
// A diferencia del resto, la credencial va envuelta en <credencial> y el CUIT a
// consultar va suelto en <cuit>. Reusamos el cache de TA (getAccessTicket) para
// NO pedir un token nuevo en cada consulta (evita el baneo de WSAA).

const { config } = require('../config');
const { getAccessTicket } = require('../auth/wsaa');
const { SoapError } = require('../soap/client');
const { normalizeCuit } = require('../auth/tenants');

const SERVICE = 'wsapoc';
const NS = 'http://tempuri.org/';
const OP = 'GetPublicacionAPOC';

function endpoint(entorno) {
  const env = entorno || config.env;
  // Solo prod esta verificado contra ARCA real; homologacion es best-effort.
  return env === 'prod'
    ? 'https://eapoc-ws.afip.gob.ar/service.asmx'
    : 'https://eapoc-ws-qaext.afip.gob.ar/service.asmx';
}

function get(src, tag) {
  // ARCA/.NET puede devolver tags con namespaces, por ejemplo:
  // <a:FechaCondicion>...</a:FechaCondicion> o <FechaCondicion>...</FechaCondicion>.
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    '<(?:[\\w.-]+:)?' + escapedTag + '[^>]*>([^<]*)</(?:[\\w.-]+:)?' + escapedTag + '>',
    'i'
  );
  const m = src.match(re);
  return m ? m[1].trim() : null;
}

function getBlock(src, tag) {
  // Igual que get(), pero captura contenido XML interno y tolera namespaces.
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    '<(?:[\\w.-]+:)?' + escapedTag + '[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?' + escapedTag + '>',
    'i'
  );
  const m = src.match(re);
  return m ? m[1].trim() : null;
}

function xmlPreview(xml) {
  return String(xml || '')
    .replace(/<Token>[\s\S]*?<\/Token>/i, '<Token>***</Token>')
    .replace(/<Sign>[\s\S]*?<\/Sign>/i, '<Sign>***</Sign>')
    .slice(0, 3000);
}

/**
 * Consulta si `cuitConsulta` esta en la base de apocrifos, usando el certificado
 * de `cuitRepresentada` (el contador/representante).
 * @returns {Promise<object>} { cuit, esApocrifo, codigo, descripcion, fechaCondicion, fechaPublicacion }
 */
async function consultar(cuitRepresentada, cuitConsulta, entorno) {
  const repre = normalizeCuit(cuitRepresentada);
  const target = normalizeCuit(cuitConsulta);
  if (!target) throw new SoapError('CUIT a consultar invalido', 400);

  const ta = await getAccessTicket(repre, SERVICE, entorno);

  // Formato SOAP segun manual ARCA WSAPOC 1.0.9 (SOAP 1.2):
  // Los parametros deben ir con namespace `tem:` y la credencial debe llamarse
  // `Credencial` con C mayuscula. Si va como <credencial> sin namespace, ARCA
  // responde codigo 201 / Object reference porque no puede leer Token/Sign.
  const envelope =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"' +
    ` xmlns:tem="${NS}">` +
    '<soap:Header/>' +
    '<soap:Body>' +
    `<tem:${OP}>` +
    '<tem:Credencial>' +
    `<tem:Token>${ta.token}</tem:Token>` +
    `<tem:Sign>${ta.sign}</tem:Sign>` +
    `<tem:CUITDelegado>${repre}</tem:CUITDelegado>` +
    '</tem:Credencial>' +
    `<tem:cuit>${target}</tem:cuit>` +
    `</tem:${OP}>` +
    '</soap:Body>' +
    '</soap:Envelope>';

  const url = endpoint(entorno);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.soapTimeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `application/soap+xml; charset=UTF-8; action="${NS}${OP}"`,
      },
      body: envelope,
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new SoapError(`Timeout (${config.soapTimeoutMs}ms) llamando a WSAPOC`, 504);
    throw new SoapError(`No se pudo conectar con WSAPOC: ${e.message}`, 502);
  } finally {
    clearTimeout(timer);
  }

  const xml = await res.text();

  // Log temporal de diagnostico. En Railway: Deployments -> View logs.
  // No imprime Token ni Sign.
  console.log('[WSAPOC] consulta', { cuitDelegado: repre, cuitConsulta: target, httpStatus: res.status });
  console.log('[WSAPOC] response preview:', xmlPreview(xml));

  const fault = xml.match(/<(?:[\w.-]+:)?Fault[^>]*>[\s\S]*?<(?:faultstring|(?:[\w.-]+:)?Text)[^>]*>([^<]+)/i);
  if (fault) throw new SoapError(`WSAPOC rechazo la solicitud: ${fault[1]}`, 502, { raw: xmlPreview(xml) });

  const codigo = get(xml, 'Codigo') || get(xml, 'codigo');
  const descripcion = get(xml, 'Descripcion') || get(xml, 'descripcion');

  // Si hay <resultados> con una PublicacionAPOC vigente => el CUIT figura como apocrifo.
  // El XML de WSAPOC suele venir con namespaces, por eso NO alcanza con buscar
  // literalmente <resultados>. Ej.: <a:resultados>...</a:resultados>.
  const resultados = getBlock(xml, 'resultados') || getBlock(xml, 'Resultados');
  const publicacion = resultados ? getBlock(resultados, 'PublicacionAPOC') || resultados : null;

  const fechaCondicion = publicacion
    ? get(publicacion, 'FechaCondicion') || get(publicacion, 'fechaCondicion')
    : null;
  const fechaPublicacion = publicacion
    ? get(publicacion, 'FechaPublicacion') || get(publicacion, 'fechaPublicacion')
    : null;
  const detalle = publicacion
    ? get(publicacion, 'Descripcion') || get(publicacion, 'descripcion')
    : null;

  const esApocrifo = !!(
    publicacion &&
    (
      /<(?:[\w.-]+:)?PublicacionAPOC\b/i.test(resultados || '') ||
      fechaCondicion ||
      fechaPublicacion ||
      get(publicacion, 'Cuit') ||
      get(publicacion, 'CUIT') ||
      get(publicacion, 'cuit')
    )
  );

  console.log('[WSAPOC] parseado', {
    codigo,
    descripcion,
    tieneResultados: !!resultados,
    tienePublicacion: !!publicacion,
    fechaCondicion,
    fechaPublicacion,
    esApocrifo,
  });

  // IMPORTANTE:
  // No convertir codigo 201 en "sin publicaciones". Segun el manual WSAPOC,
  // 201 es error al validar credenciales de autenticacion.
  // Si lo maquillamos como "sin antecedentes", la app muestra un falso negativo.
  if (!esApocrifo && codigo === '201') {
    return {
      cuit: target,
      esApocrifo: false,
      codigo,
      descripcion: descripcion || 'Error al validar credenciales de autenticacion WSAPOC.',
      fechaCondicion,
      fechaPublicacion,
      detalle,
      error: 'WSAPOC_CREDENCIALES_201',
      rawPreview: xmlPreview(xml),
    };
  }

  return {
    cuit: target,
    esApocrifo,
    codigo,
    descripcion,
    fechaCondicion,
    fechaPublicacion,
    detalle,
  };
}

module.exports = { consultar, SERVICE };
