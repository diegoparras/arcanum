'use strict';

// Catálogo declarativo de los Web Services de ARCA.
// Cada descriptor define: cómo autenticar (wsaaService), dónde pegar (endpoints),
// cómo verificar que está activo (dummyOp / authOp) y CÓMO ACTIVARLO (activacion:
// el nombre exacto a asociar en el Administrador de Relaciones de Clave Fiscal y
// los pasos guiados). El motor genérico (soap/engine.js) usa todo esto.
//
// `rich: true` => existe un módulo dedicado con validaciones y mapeo REST fino.
// `rich: false` => accesible vía passthrough genérico /api/ws/:id/:operacion.

const REL = 'https://serviciosweb.afip.gob.ar/clavefiscal/adminrel/main.aspx';
const CERT_PORTAL = 'https://www.afip.gob.ar/ws/documentacion/certificados.asp';

function pasosActivacion(nombreRelacion, extra = []) {
  return [
    'Ingresá con Clave Fiscal al "Administrador de Relaciones de Clave Fiscal".',
    'Elegí la empresa/persona (Representado) si corresponde.',
    'Clic en "Nueva Relación" > "Buscar" (Servicio).',
    `Buscá y seleccioná: ${nombreRelacion}.`,
    'En "Representante" elegí el Computador Fiscal (el certificado que cargaste en Arcanum).',
    'Confirmá. La relación queda activa de inmediato (puede tardar unos minutos en propagar).',
    ...extra,
  ];
}

const SERVICES = [
  // ---------------- FACTURACIÓN ----------------
  {
    id: 'wsfev1',
    nombre: 'Factura Electrónica (WSFEv1)',
    descripcion: 'Comprobantes A/B/C/M sin detalle, con CAE. El más usado.',
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
      relacionNombre: 'Facturación Electrónica - Web Service de Negocio (wsfe)',
      pasos: pasosActivacion('Facturación Electrónica (ws_sr_padron / wsfe)'),
      docs: 'https://www.afip.gob.ar/ws/documentacion/ws-factura-electronica.asp',
    },
  },
  {
    id: 'wsfexv1',
    nombre: 'Factura de Exportación (WSFEXv1)',
    descripcion: 'Comprobantes E de exportación, moneda extranjera, sin IVA.',
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
      relacionNombre: 'wsfex - Factura Electrónica de Exportación',
      pasos: pasosActivacion('wsfex'),
    },
  },
  {
    id: 'wsmtxca',
    nombre: 'Factura con detalle (WSMTXCA)',
    descripcion: 'Comprobantes A/B con detalle de ítems línea por línea.',
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
    nombre: 'Factura de Crédito MiPyME (WSFECRED)',
    descripcion: 'Cuenta corriente de facturas de crédito electrónicas (FCE).',
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

  // ---------------- CONSULTAS / PADRÓN ----------------
  {
    id: 'padron_a5',
    nombre: 'Constancia de Inscripción (A5)',
    descripcion: 'Constancia de inscripción / datos fiscales del contribuyente.',
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
    nombre: 'Padrón Alcance 13 (Mi Categoría)',
    descripcion: 'Datos de padrón y categoría de monotributo.',
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
    nombre: 'Padrón Alcance 4',
    descripcion: 'Datos básicos de un contribuyente (getPersona).',
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
    nombre: 'Padrón Alcance 10',
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
    nombre: 'Constatación de Comprobantes (WSCDC)',
    descripcion: 'Verifica que un CAE/comprobante emitido sea válido.',
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
    nombre: 'Base de Apócrifos (WSAPOC)',
    descripcion: 'Consulta si un CUIT figura en la base de facturas/contribuyentes apócrifos de ARCA.',
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
      relacionNombre: 'wsapoc (Consulta de Apócrifos)',
      pasos: pasosActivacion('wsapoc'),
    },
  },
  {
    id: 'eventanilla',
    nombre: 'e-Ventanilla (Comunicaciones)',
    descripcion: 'Lista, lee y descarga las comunicaciones (y sus PDF) de la Ventanilla Electrónica.',
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
      relacionNombre: 'veconsumerws (Ventanilla Electrónica - Consulta)',
      pasos: pasosActivacion('veconsumerws'),
      docs: 'https://www.afip.gob.ar/ws/WSCComu/vecuwsconcomunicaciones.pdf',
    },
  },

  // ---------------- AGRO Y REMITOS ----------------
  {
    id: 'wslpg',
    nombre: 'Liquidación de Granos (WSLPG)',
    descripcion: 'Liquidación primaria electrónica de granos.',
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
    nombre: 'Liquidación Sector Pecuario (WSLSP)',
    descripcion: 'Liquidación electrónica de hacienda/ganado.',
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
    nombre: 'Remito Electrónico Cárnico (WSREMCARNE)',
    descripcion: 'Remito electrónico de carnes y derivados.',
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
    nombre: 'Remito Electrónico Harina (WSREMHARINA)',
    descripcion: 'Remito electrónico de harina de trigo y subproductos.',
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
    nombre: 'Remito Electrónico Azúcar (WSREMAZUCAR)',
    descripcion: 'Remito electrónico de azúcar y derivados.',
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
    nombre: 'Carta de Porte Electrónica (WSCPE)',
    descripcion: 'Emisión y gestión de la carta de porte para transporte de granos.',
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
    nombre: 'Código Trazabilidad de Granos (WSCTG)',
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
    nombre: 'Liquidación Única Mensual Lechera (WSLUM)',
    descripcion: 'Liquidación electrónica del sector lácteo.',
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
    nombre: 'Liquidación Tabaco Virginia (WSLTV)',
    descripcion: 'Liquidación electrónica del sector tabacalero.',
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
    nombre: 'Digitalización Depositario Fiel (wDigDepFiel)',
    descripcion: 'Digitalización de documentación del depositario fiel (aduana).',
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
    descripcion: 'Aprobación/denegación de despachos de la industria vitivinícola (INV).',
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
    descripcion: 'Movimientos de ingreso/egreso en terminales y depósitos (aduana).',
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

// Estos son los DEFAULTS (semilla). El catálogo efectivo vive en Postgres y se
// puede editar en vivo desde la UI (ver src/catalog.js). pasosActivacion y las
// constantes se exportan para reusar al construir servicios nuevos.
module.exports = { DEFAULTS: SERVICES, REL, CERT_PORTAL, pasosActivacion };
