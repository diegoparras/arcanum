'use strict';

// Receta por defecto para bajar Mis Comprobantes (la corre la sesion de agente de Fisherboy).
// El superadmin la puede editar en vivo desde la UI (settings 'mc_receta') cuando ARCA cambie
// la pagina, y volver a esta con "Restaurar".
//
// Variables que pone Arcanum: cuit_login (con el que se entra), cuit (el representado),
// tipo_boton (Emitidos | Recibidos), t (E | R), rango ("dd/mm/aaaa - dd/mm/aaaa") y rango_url
// (el mismo rango codificado para una URL).
// Secreto: clave_fiscal. Nunca se escribe un valor aca: solo el placeholder.
//
// Cada paso trae `objetivo`: si el selector deja de existir y Fisherboy tiene IA configurada,
// la IA intenta cumplir ese objetivo y la receta sigue. Los selectores salen del recorrido
// conocido de ARCA y se ajustan en la primera corrida real mirandola en vivo.
//
// `verifica_login: true` marca el paso que prueba que ARCA acepto la clave. Si ESE paso falla,
// Arcanum bloquea la credencial y no reintenta: repetir una clave mala puede bloquear la clave
// fiscal del contribuyente en ARCA.

const CAPTCHA = "[id*='captcha' i], iframe[src*='recaptcha'], iframe[src*='hcaptcha']";

const RECETA_DEFAULT = {
  url: 'https://auth.afip.gob.ar/contribuyente_/login.xhtml',
  pasos: [
    { do: 'type', sel: "[id='F1:username']", text: '{{var:cuit_login}}', objetivo: 'Escribir el CUIT {{var:cuit_login}} en el campo CUIT/CUIL del login de ARCA' },
    { do: 'click', sel: "[id='F1:btnSiguiente']", objetivo: 'Apretar Siguiente en el login de ARCA' },
    { do: 'human_if', sel: CAPTCHA, motivo: 'ARCA pide resolver un captcha antes de la clave' },
    { do: 'type', sel: "[id='F1:password']", text: '{{secret:clave_fiscal}}', objetivo: 'Escribir la clave fiscal {{secret:clave_fiscal}} en el campo Clave' },
    { do: 'click', sel: "[id='F1:btnIngresar']", objetivo: 'Apretar Ingresar en el login de ARCA' },
    { do: 'human_if', sel: CAPTCHA, motivo: 'ARCA pide resolver un captcha para ingresar' },
    { do: 'wait_url', contains: 'portal', timeout_s: 30, verifica_login: true },
    // Por el buscador del portal (#buscadorInput, un typeahead que responde a fill) y su
    // resultado li[role=option]: un link suelto que diga "Mis Comprobantes" puede ser un video del
    // carrusel de Novedades que abre YouTube por codigo, y la tarjeta de "Mas utilizados" depende
    // de cada usuario. Verificado sobre el portal real.
    { do: 'fill', sel: '#buscadorInput', text: 'Mis Comprobantes', timeout_s: 20, objetivo: "Buscar 'Mis Comprobantes' en el buscador del portal de ARCA" },
    { do: 'click', sel: 'li[role="option"]:has-text("Mis Comprobantes")', timeout_s: 15, objetivo: "Abrir el servicio 'Mis Comprobantes' desde los resultados del buscador" },
    { do: 'switch_tab', timeout_s: 30 },
    { do: 'click', sel: 'text={{var:cuit}}', timeout_s: 8, optional: true },
    { do: 'click', sel: '#btn{{var:tipo_boton}}', timeout_s: 20, objetivo: "Entrar a la seccion '{{var:tipo_boton}}' de Mis Comprobantes" },
    // Los datos se piden directo a ARCA, como hace la propia pagina al apretar Buscar, sin manejar
    // el calendario, la tabla ni el boton de exportar: generarConsulta da el id de la consulta y
    // listaResultados trae todos los comprobantes en JSON. Reglas de ARCA (verificadas en vivo):
    // la consulta tiene que ser de la seccion abierta (pedir recibidos desde Emitidos corta la
    // sesion) y el rango no puede pasar de 365 dias (Arcanum ya parte en tramos).
    { do: 'fetch', url: 'ajax.do?f=generarConsulta&t={{var:t}}&fechaEmision={{var:rango_url}}&tiposComprobantes=&cuitConsultada={{var:cuit}}', guardar: 'consulta', timeout_s: 60, objetivo: 'Pedir a ARCA la consulta de comprobantes del rango {{var:rango}}' },
    { do: 'fetch', url: 'ajax.do?f=listaResultados&id={{res:consulta.datos.idConsulta}}', name: 'mis-comprobantes.json', timeout_s: 120, objetivo: 'Traer los comprobantes de la consulta' },
  ],
};

const DOMINIOS = ['afip.gob.ar', 'arca.gob.ar'];

// Fisherboy frena antes de tocar un boton que "no se deshace" (todo submit, por ejemplo) y pide
// un OK. Estos textos son consultas que no cambian nada en ARCA: Arcanum da el OK solo, asi la
// sincronizacion diaria no queda esperando a nadie. Cualquier otro texto lo decide una persona.
const OK_AUTOMATICO = ['buscar', 'consultar', 'filtrar'];

module.exports = { RECETA_DEFAULT, DOMINIOS, OK_AUTOMATICO };
