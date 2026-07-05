'use strict';

// Catalogo declarativo de los Web Services de ARCA.
// Cada descriptor define: como autenticar (wsaaService), donde pegar (endpoints),
// como verificar que esta activo (dummyOp / authOp) y COMO ACTIVARLO (activacion:
// el nombre exacto a asociar en el Administrador de Relaciones de Clave Fiscal y
// los pasos guiados). El motor generico (soap/engine.js) usa todo esto.
//
// `rich: true` => existe un modulo dedicado con validaciones y mapeo REST fino.
// `rich: false` => accesible via passthrough generico /api/ws/:id/:operacion.

const REL = 'https://serviciosweb.afip.gob.ar/clavefiscal/adminrel/main.aspx';
const CERT_PORTAL = 'https://www.afip.gob.ar/ws/documentacion/certificados.asp';

function pasosActivacion(nombreRelacion, extra = []) {
  return [
    'Ingresa con Clave Fiscal al "Administrador de Relaciones de Clave Fiscal".',
    'Elegi la empresa/persona (Representado) si corresponde.',
    'Clic en "Nueva Relacion" > "Buscar" (Servicio).',
    `Busca y selecciona: ${nombreRelacion}.`,
    'En "Representante" elegi el Computador Fiscal (el certificado que cargaste en Arcanum).',
    'Confirma. La relacion queda activa de inmediato (puede tardar unos minutos en propagar).',
    ...extra,
  ];
}

const SERVICES = [
  // ---------------- FACTURACION ----------------
  {
    id: 'wsfev1',
    nombre: 'Factura Electronica (WSFEv1)',
    descripcion: 'Comprobantes A/B/C/M sin detalle, con CAE. El mas usado.',
    categoria: 'facturacion',
    wsaaService: 'wsfe',
    soapNamespace: 'http://ar.gov.afip.dif.FEV1/',
    endpoints: {
      homo: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
      prod: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
    },
    dummyOp: 'FEDummy',
    rich: true,
    activacion: {
      relacionNombre: 'Facturacion Electronica - Web Service de Negocio (wsfe)',
      pasos: pasosActivacion('Facturacion Electronica (ws_sr_padron / wsfe)'),
      docs: 'https://www.afip.gob.ar/ws/documentacion/ws-factura-electronica.asp',
    },
  },
  {
    id: 'wsfexv1',
    nombre: 'Factura de Exportacion (WSFEXv1)',
    descripcion: 'Comprobantes E de exportacion, moneda extranjera, sin IVA.',
    categoria: 'facturacion',
    wsaaService: 'wsfex',
    soapNamespace: 'http://ar.gov.afip.dif.fexv1/',
    endpoints: {
      homo: 'https://wswhomo.afip.gov.ar/wsfexv1/service.asmx',
      prod: 'https://servicios1.afip.gov.ar/wsfexv1/service.asmx',
    },
    dummyOp: 'FEXDummy',
    rich: true,
    activacion: {
      relacionNombre: 'wsfex - Factura Electronica de Exportacion',
      pasos: pasosActivacion('wsfex'),
    },
  },
  {
    id: 'wsmtxca',
    nombre: 'Factura con detalle (WSMTXCA)',
    descripcion: 'Comprobantes A/B con detalle de items linea por linea.',
    categoria: 'facturacion',
    wsaaService: 'wsmtxca',
    soapNamespace: 'http://impl.service.wsmtxca.afip.gov.ar/service/',
    authStyle: 'java',
    endpoints: {
      homo: 'https://fwshomo.afip.gov.ar/wsmtxca/services/MTXCAService',
      prod: 'https://serviciosjava.afip.gov.ar/wsmtxca/services/MTXCAService',
    },
    dummyOp: 'dummy',
    rich: true,
    activacion: { relacionNombre: 'wsmtxca', pasos: pasosActivacion('wsmtxca') },
  },
  {
    id: 'wsbfev1',
    nombre: 'Bonos Fiscales (WSBFEv1)',
    descripcion: 'Comprobantes de bienes de capital con bono fiscal.',
    categoria: 'facturacion',
    wsaaService: 'wsbfe',
    soapNamespace: 'http://ar.gov.afip.dif.bfev1/',
    endpoints: {
      homo: 'https://wswhomo.afip.gov.ar/wsbfev1/service.asmx',
      prod: 'https://servicios1.afip.gov.ar/wsbfev1/service.asmx',
    },
    dummyOp: 'BFEDummy',
    rich: false,
    activacion: { relacionNombre: 'wsbfe', pasos: pasosActivacion('wsbfe') },
  },
  {
    id: 'wsct',
    nombre: 'Comprobantes de Turismo (WSCT)',
    descripcion: 'Reintegro a turistas extranjeros (RG 3971).',
    categoria: 'facturacion',
    wsaaService: 'wsct',
    soapNamespace: 'http://ar.gob.afip.wsct/CTService/',
    authStyle: 'java',
    endpoints: {
      homo: 'https://fwshomo.afip.gov.ar/wsct/CTService',
      prod: 'https://serviciosjava.afip.gov.ar/wsct/CTService',
    },
    rich: false,
    activacion: { relacionNombre: 'wsct', pasos: pasosActivacion('wsct') },
  },
  {
    id: 'wsfecred',
    nombre: 'Factura de Credito MiPyME (WSFECRED)',
    descripcion: 'Cuenta corriente de facturas de credito electronicas (FCE).',
    categoria: 'facturacion',
    wsaaService: 'wsfecred',
    soapNamespace: 'http://ar.gob.afip.wsfecred/FECredService/',
    authStyle: 'java',
    endpoints: {
      homo: 'https://fwshomo.afip.gov.ar/wsfecred/FECredService',
      prod: 'https://serviciosjava.afip.gov.ar/wsfecred/FECredService',
    },
    rich: false,
    activacion: { relacionNombre: 'wsfecred', pasos: pasosActivacion('wsfecred') },
  },

  // ---------------- CONSULTAS / PADRON ----------------
  {
    id: 'padron_a5',
    nombre: 'Constancia de Inscripcion (A5)',
    descripcion: 'Constancia de inscripcion / datos fiscales del contribuyente.',
    categoria: 'consultas',
    wsaaService: 'ws_sr_constancia_inscripcion',
    soapNamespace: 'http://a5.soap.ws.server.puc.sr/',
    endpoints: {
      homo: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5',
      prod: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5',
    },
    rich: true,
    activacion: { relacionNombre: 'ws_sr_constancia_inscripcion', pasos: pasosActivacion('ws_sr_constancia_inscripcion') },
  },
  {
    id: 'padron_a13',
    nombre: 'Padron Alcance 13 (Mi Categoria)',
    descripcion: 'Datos de padron y categoria de monotributo.',
    categoria: 'consultas',
    wsaaService: 'ws_sr_padron_a13',
    soapNamespace: 'http://a13.soap.ws.server.puc.sr/',
    endpoints: {
      homo: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA13',
      prod: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA13',
    },
    rich: true,
    activacion: { relacionNombre: 'ws_sr_padron_a13', pasos: pasosActivacion('ws_sr_padron_a13') },
  },
  {
    id: 'padron_a4',
    nombre: 'Padron Alcance 4',
    descripcion: 'Datos basicos de un contribuyente (getPersona).',
    categoria: 'consultas',
    wsaaService: 'ws_sr_padron_a4',
    soapNamespace: 'http://a4.soap.ws.server.puc.sr/',
    endpoints: {
      homo: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA4',
      prod: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA4',
    },
    rich: false,
    activacion: { relacionNombre: 'ws_sr_padron_a4', pasos: pasosActivacion('ws_sr_padron_a4') },
  },
  {
    id: 'padron_a10',
    nombre: 'Padron Alcance 10',
    descripcion: 'Datos de relaciones del contribuyente.',
    categoria: 'consultas',
    wsaaService: 'ws_sr_padron_a10',
    soapNamespace: 'http://a10.soap.ws.server.puc.sr/',
    endpoints: {
      homo: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA10',
      prod: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA10',
    },
    rich: false,
    activacion: { relacionNombre: 'ws_sr_padron_a10', pasos: pasosActivacion('ws_sr_padron_a10') },
  },
  {
    id: 'wscdc',
    nombre: 'Constatacion de Comprobantes (WSCDC)',
    descripcion: 'Verifica que un CAE/comprobante emitido sea valido.',
    categoria: 'consultas',
    wsaaService: 'wscdc',
    soapNamespace: 'http://servicios1.afip.gob.ar/wscdc/',
    endpoints: {
      homo: 'https://wswhomo.afip.gov.ar/WSCDC/service.asmx',
      prod: 'https://servicios1.afip.gov.ar/WSCDC/service.asmx',
    },
    dummyOp: 'ComprobanteDummy',
    rich: false,
    activacion: { relacionNombre: 'wscdc', pasos: pasosActivacion('wscdc') },
  },
  {
    id: 'wsapoc',
    nombre: 'Base de Apocrifos (WSAPOC)',
    descripcion: 'Consulta si un CUIT figura en la base de facturas/contribuyentes apocrifos de ARCA.',
    categoria: 'consultas',
    wsaaService: 'wsapoc',
    soapNamespace: 'http://tempuri.org/',
    authStyle: 'apoc',
    soapActionTemplate: 'http://tempuri.org/{op}',
    endpoints: {
      homo: 'https://eapoc-ws-qaext.afip.gob.ar/service.asmx',
      prod: 'https://eapoc-ws.afip.gob.ar/service.asmx',
    },
    rich: true,
    activacion: {
      relacionNombre: 'wsapoc (Consulta de Apocrifos)',
      pasos: pasosActivacion('wsapoc'),
    },
  },
  {
    id: 'eventanilla',
    nombre: 'e-Ventanilla (Comunicaciones)',
    descripcion: 'Lista, lee y descarga las comunicaciones (y sus PDF) de la Ventanilla Electronica.',
    categoria: 'consultas',
    wsaaService: 'veconsumerws',
    soapNamespace: 'http://ve.tecno.afip.gov.ar/domain/service/ws/types',
    endpoints: {
      homo: 'https://infraestructurahomo.afip.gob.ar/ve-ws/services/veconsumer',
      prod: 'https://infraestructura.afip.gob.ar/ve-ws/services/veconsumer',
    },
    dummyOp: 'dummy',
    rich: true,
    activacion: {
      relacionNombre: 'veconsumerws (Ventanilla Electronica - Consulta)',
      pasos: pasosActivacion('veconsumerws'),
      docs: 'https://www.afip.gob.ar/ws/WSCComu/vecuwsconcomunicaciones.pdf',
    },
  },

  // ---------------- AGRO Y REMITOS ----------------
  {
    id: 'wslpg',
    nombre: 'Liquidacion de Granos (WSLPG)',
    descripcion: 'Liquidacion primaria electronica de granos.',
    categoria: 'agro',
    wsaaService: 'wslpg',
    soapNamespace: 'http://serviciosjava.afip.gob.ar/wslpg/',
    authStyle: 'java',
    endpoints: {
      homo: 'https://fwshomo.afip.gov.ar/wslpg/LpgService',
      prod: 'https://serviciosjava.afip.gov.ar/wslpg/LpgService',
    },
    rich: false,
    activacion: { relacionNombre: 'wslpg', pasos: pasosActivacion('wslpg') },
  },
  {
    id: 'wslsp',
    nombre: 'Liquidacion Sector Pecuario (WSLSP)',
    descripcion: 'Liquidacion electronica de hacienda/ganado.',
    categoria: 'agro',
    wsaaService: 'wslsp',
    soapNamespace: 'http://serviciosjava.afip.gob.ar/wslsp/',
    authStyle: 'java',
    endpoints: {
      homo: 'https://fwshomo.afip.gov.ar/wslsp/LspService',
      prod: 'https://serviciosjava.afip.gov.ar/wslsp/LspService',
    },
    rich: false,
    activacion: { relacionNombre: 'wslsp', pasos: pasosActivacion('wslsp') },
  },
  {
    id: 'wsremcarne',
    nombre: 'Remito Electronico Carnico (WSREMCARNE)',
    descripcion: 'Remito electronico de carnes y derivados.',
    categoria: 'agro',
    wsaaService: 'wsremcarne',
    soapNamespace: 'http://ar.gob.afip.wsremcarne/RemCarneService/',
    authStyle: 'java',
    endpoints: {
      homo: 'https://fwshomo.afip.gov.ar/wsremcarne/RemCarneService',
      prod: 'https://serviciosjava.afip.gov.ar/wsremcarne/RemCarneService',
    },
    rich: false,
    activacion: { relacionNombre: 'wsremcarne', pasos: pasosActivacion('wsremcarne') },
  },
  {
    id: 'wsremharina',
    nombre: 'Remito Electronico Harina (WSREMHARINA)',
    descripcion: 'Remito electronico de harina de trigo y subproductos.',
    categoria: 'agro',
    wsaaService: 'wsremharina',
    soapNamespace: 'http://ar.gob.afip.wsremharina/RemHarinaService/',
    authStyle: 'java',
    endpoints: {
      homo: 'https://fwshomo.afip.gov.ar/wsremharina/RemHarinaService',
      prod: 'https://serviciosjava.afip.gov.ar/wsremharina/RemHarinaService',
    },
    rich: false,
    activacion: { relacionNombre: 'wsremharina', pasos: pasosActivacion('wsremharina') },
  },
  {
    id: 'wsremazucar',
    nombre: 'Remito Electronico Azucar (WSREMAZUCAR)',
    descripcion: 'Remito electronico de azucar y derivados.',
    categoria: 'agro',
    wsaaService: 'wsremazucar',
    soapNamespace: 'http://ar.gob.afip.wsremazucar/RemAzucarService/',
    authStyle: 'java',
    endpoints: {
      homo: 'https://fwshomo.afip.gov.ar/wsremazucar/RemAzucarService',
      prod: 'https://serviciosjava.afip.gov.ar/wsremazucar/RemAzucarService',
    },
    rich: false,
    activacion: { relacionNombre: 'wsremazucar', pasos: pasosActivacion('wsremazucar') },
  },
  {
    id: 'wscpe',
    nombre: 'Carta de Porte Electronica (WSCPE)',
    descripcion: 'Emision y gestion de la carta de porte para transporte de granos.',
    categoria: 'agro',
    wsaaService: 'wscpe',
    soapNamespace: 'http://serviciosjava.arca.gob.ar/wscpe/',
    authStyle: 'java',
    endpoints: {
      homo: 'https://cpea-ws-qaext.arca.gob.ar/wscpe/services/soap',
      prod: 'https://cpea-ws.arca.gob.ar/wscpe/services/soap',
    },
    rich: false,
    activacion: { relacionNombre: 'wscpe', pasos: pasosActivacion('wscpe'), docs: 'https://www.afip.gob.ar/ws/documentos/Manual-wscpe.pdf' },
  },
  {
    id: 'wsctg',
    nombre: 'Codigo Trazabilidad de Granos (WSCTG)',
    descripcion: 'Solicitud y consulta de CTG para el transporte de granos.',
    categoria: 'agro',
    wsaaService: 'wsctg',
    soapNamespace: 'http://impl.service.wsctg.afip.gov.ar/CTGService/',
    authStyle: 'java',
    endpoints: {
      homo: 'https://fwshomo.afip.gov.ar/wsctg/services/CTGService_v4.0',
      prod: 'https://servicios1.afip.gov.ar/wsctg/services/CTGService_v4.0',
    },
    rich: false,
    activacion: { relacionNombre: 'wsctg', pasos: pasosActivacion('wsctg') },
  },
  {
    id: 'wslum',
    nombre: 'Liquidacion Unica Mensual Lechera (WSLUM)',
    descripcion: 'Liquidacion electronica del sector lacteo.',
    categoria: 'agro',
    wsaaService: 'wslum',
    soapNamespace: 'http://serviciosjava.afip.gob.ar/wslum/',
    authStyle: 'java',
    endpoints: {
      homo: 'https://fwshomo.afip.gov.ar/wslum/LumService',
      prod: 'https://serviciosjava.afip.gov.ar/wslum/LumService',
    },
    rich: false,
    activacion: { relacionNombre: 'wslum', pasos: pasosActivacion('wslum') },
  },
  {
    id: 'wsltv',
    nombre: 'Liquidacion Tabaco Virginia (WSLTV)',
    descripcion: 'Liquidacion electronica del sector tabacalero.',
    categoria: 'agro',
    wsaaService: 'wsltv',
    soapNamespace: 'http://serviciosjava.afip.gob.ar/wsltv/',
    authStyle: 'java',
    endpoints: {
      homo: 'https://fwshomo.afip.gov.ar/wsltv/LtvService',
      prod: 'https://serviciosjava.afip.gov.ar/wsltv/LtvService',
    },
    rich: false,
    activacion: { relacionNombre: 'wsltv', pasos: pasosActivacion('wsltv') },
  },

  // ---------------- ADUANA ----------------
  {
    id: 'wdigdepfiel',
    nombre: 'Digitalizacion Depositario Fiel (wDigDepFiel)',
    descripcion: 'Digitalizacion de documentacion del depositario fiel (aduana).',
    categoria: 'aduana',
    wsaaService: 'wDigDepFiel',
    soapNamespace: 'ar.gov.afip.dia.serviciosWeb.wDigDepFiel',
    soapActionTemplate: 'ar.gov.afip.dia.serviciosWeb.wDigDepFiel/{op}',
    endpoints: {
      homo: 'https://testdia.afip.gov.ar/Dia/Ws/wDigDepFiel/wDigDepFiel.asmx',
      prod: 'https://servicios3.arca.gob.ar/Dia/Ws/wDigDepFiel/wDigDepFiel.asmx',
    },
    rich: false,
    activacion: { relacionNombre: 'wDigDepFiel', pasos: pasosActivacion('wDigDepFiel') },
  },
  {
    id: 'wgesinv',
    nombre: 'Aprobar/Denegar Despachos INV (WGESINV)',
    descripcion: 'Aprobacion/denegacion de despachos de la industria vitivinicola (INV).',
    categoria: 'aduana',
    wsaaService: 'wgesinv',
    soapNamespace: 'ar.gov.afip.dia.serviciosweb.WGesINV',
    soapActionTemplate: 'ar.gov.afip.dia.serviciosweb.WGesINV/{op}',
    endpoints: {
      homo: 'https://testdia.afip.gov.ar/Dia/Ws/wGesINV/wGesINV.asmx',
      prod: 'https://servicios3.arca.gob.ar/Dia/Ws/WGesINV/WGesINV.asmx',
    },
    rich: false,
    activacion: { relacionNombre: 'wgesinv', pasos: pasosActivacion('wgesinv') },
  },
  {
    id: 'wdepmovimientos',
    nombre: 'Movimientos Ingreso/Egreso Terminales (WDEPMOVIMIENTOS)',
    descripcion: 'Movimientos de ingreso/egreso en terminales y depositos (aduana).',
    categoria: 'aduana',
    wsaaService: 'wdepmovimientos',
    soapNamespace: 'ar.gov.afip.dia.serviciosWeb.wdepMovimientos.wdepMovimientos',
    soapActionTemplate: 'ar.gov.afip.dia.serviciosWeb.wdepMovimientos.wdepMovimientos/{op}',
    endpoints: {
      homo: 'https://testdia.afip.gov.ar/dia/ws/wdepMovimientos/wdepMovimientos.asmx',
      prod: 'https://servicios3.arca.gob.ar/dia/ws/wdepMovimientos/wdepMovimientos.asmx',
    },
    rich: false,
    activacion: { relacionNombre: 'wdepmovimientos', pasos: pasosActivacion('wdepmovimientos') },
  },
];

// Estos son los DEFAULTS (semilla). El catalogo efectivo vive en Postgres y se
// puede editar en vivo desde la UI (ver src/catalog.js). pasosActivacion y las
// constantes se exportan para reusar al construir servicios nuevos.
module.exports = { DEFAULTS: SERVICES, REL, CERT_PORTAL, pasosActivacion };
