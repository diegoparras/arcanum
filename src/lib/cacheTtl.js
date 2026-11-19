'use strict';

// Cache en memoria con vencimiento (TTL) y tope de entradas. Sin dependencias.
// Se usa para el padron: ARCA se pone lenta en horas pico y los datos de un CUIT
// cambian poco en una hora. Los errores nunca se guardan.

function crearCache({ ttlMs, max = 2000, ahora = Date.now } = {}) {
  const datos = new Map(); // clave -> { valor, guardado }

  function vigente(e) {
    return e && ttlMs > 0 && ahora() - e.guardado < ttlMs;
  }

  return {
    /** { valor, guardado } si la entrada sigue vigente, o null. */
    leer(clave) {
      const e = datos.get(clave);
      if (vigente(e)) return e;
      if (e) datos.delete(clave);
      return null;
    },
    guardar(clave, valor) {
      if (!(ttlMs > 0)) return;
      if (datos.has(clave)) datos.delete(clave);
      datos.set(clave, { valor, guardado: ahora() });
      // Map conserva el orden de insercion: la primera es la mas vieja.
      while (datos.size > max) datos.delete(datos.keys().next().value);
    },
    borrar(clave) {
      datos.delete(clave);
    },
    vaciar() {
      datos.clear();
    },
    get tamano() {
      return datos.size;
    },
  };
}

module.exports = { crearCache };
