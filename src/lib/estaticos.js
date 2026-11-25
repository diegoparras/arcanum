'use strict';

// Version en la URL de los estaticos locales. serveStatic los cachea un dia (max-age=86400):
// sin esto, despues de un deploy el navegador seguia usando el CSS viejo hasta 24 h. Con
// ?v=<version>, cada version nueva es una URL nueva y se baja sola; dentro de la misma
// version se sigue aprovechando la cache.

/** Agrega ?v=<version> a cada href="./<archivo>.css" sin query del HTML. */
function conVersionEnEstaticos(html, version) {
  if (!version) return html;
  const v = encodeURIComponent(String(version));
  return String(html).replace(/href="(\.\/[^"?#]+\.css)"/g, `href="$1?v=${v}"`);
}

module.exports = { conVersionEnEstaticos };
