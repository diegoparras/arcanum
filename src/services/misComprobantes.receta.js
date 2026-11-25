'use strict';

// Receta por defecto para bajar Mis Comprobantes (la corre la sesion de agente de Fisherboy).
// El superadmin la puede editar en vivo desde la UI (settings 'mc_receta') cuando ARCA cambie
// la pagina, y volver a esta con "Restaurar".
//
// Variables que pone Arcanum: cuit_login (con el que se entra), cuit (el representado),
// tipo_boton (Emitidos | Recibidos), rango ("dd/mm/aaaa - dd/mm/aaaa").
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
    { do: 'capture', pattern: 'listaResultados|generarConsulta' },
    { do: 'fill', sel: '#fechaEmision', text: '{{var:rango}}', objetivo: 'Cargar el rango de fechas {{var:rango}} en Fecha de Emision' },
    // El calendario de ARCA (daterangepicker) toma lo escrito recien en keyup: fill solo cambia el
    // texto y la busqueda salia con la fecha por defecto (ayer). End genera la tecla sin enviar el
    // formulario ni mover el foco.
    { do: 'press', sel: '#fechaEmision', key: 'End' },
    { do: 'click', sel: '#buscarComprobantes', objetivo: 'Apretar Buscar para consultar los comprobantes' },
    { do: 'wait_for', sel: '#tablaDataTables', timeout_s: 60, objetivo: 'Esperar a que aparezca la tabla de resultados' },
    // El boton de ARCA es <button title="Exportar como CSV"> (sin la clase .buttons-csv de
    // DataTables). Hace location.href a descargarComprobantes.do, que devuelve un ZIP con el CSV
    // en la misma pestana. El primer pedido puede responder 503 mientras ARCA lo arma: un intento
    // opcional, una espera y el intento que vale. Si salen los dos, el guardado no duplica.
    { do: 'download', sel: 'button[title="Exportar como CSV"]', timeout_s: 30, optional: true },
    { do: 'wait', s: 5 },
    { do: 'download', sel: 'button[title="Exportar como CSV"]', timeout_s: 60, objetivo: 'Exportar los resultados como CSV' },
  ],
};

const DOMINIOS = ['afip.gob.ar', 'arca.gob.ar'];

// Fisherboy frena antes de tocar un boton que "no se deshace" (todo submit, por ejemplo) y pide
// un OK. Estos textos son consultas que no cambian nada en ARCA: Arcanum da el OK solo, asi la
// sincronizacion diaria no queda esperando a nadie. Cualquier otro texto lo decide una persona.
const OK_AUTOMATICO = ['buscar', 'consultar', 'filtrar'];

module.exports = { RECETA_DEFAULT, DOMINIOS, OK_AUTOMATICO };
