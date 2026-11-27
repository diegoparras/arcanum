'use strict';

// Limite de pedidos por clave de API (ventana fija de un minuto, en memoria) y
// deteccion de uso anomalo por clave (ventana de una hora). Puros: el reloj se
// inyecta, asi se testean sin esperar.

const LIMITE_DEFAULT = parseInt(process.env.ARCANUM_CLAVE_LIMITE_MIN || '120', 10);

/**
 * Limitador por clave. permitir(id, limite) -> { ok, restantes, reintentarEnS }.
 * limite <= 0 o null usa el default; el default 0 desactiva el limite.
 */
function crearLimitador({ ahora = Date.now, porDefecto = LIMITE_DEFAULT } = {}) {
  const ventanas = new Map(); // id -> { inicio, n }
  return {
    permitir(id, limite) {
      const tope = limite > 0 ? limite : porDefecto;
      if (!(tope > 0)) return { ok: true, restantes: null, reintentarEnS: 0 };
      const t = ahora();
      const minuto = t - (t % 60_000);
      let v = ventanas.get(id);
      if (!v || v.inicio !== minuto) {
        v = { inicio: minuto, n: 0 };
        ventanas.set(id, v);
      }
      if (v.n >= tope) return { ok: false, restantes: 0, reintentarEnS: Math.ceil((minuto + 60_000 - t) / 1000) };
      v.n += 1;
      // Limpieza ocasional de ventanas viejas.
      if (ventanas.size > 1000) for (const [k, w] of ventanas) if (w.inicio < minuto) ventanas.delete(k);
      return { ok: true, restantes: tope - v.n, reintentarEnS: 0 };
    },
  };
}

const UMBRALES_DEFAULT = {
  cuitsPorHora: parseInt(process.env.ARCANUM_ANOMALIA_CUITS_HORA || '50', 10),
  rechazosPorHora: parseInt(process.env.ARCANUM_ANOMALIA_RECHAZOS_HORA || '20', 10),
};

/**
 * Detector de uso anomalo por clave, por hora:
 *  - muchos CUITs distintos consultados (barrido del padron),
 *  - muchos rechazos (403 sin permiso / 429 por limite).
 * registrar(...) devuelve la lista de alertas NUEVAS (cada motivo avisa una vez por hora).
 */
function crearDetector({ ahora = Date.now, umbrales = UMBRALES_DEFAULT } = {}) {
  const horas = new Map(); // id -> { hora, cuits:Set, rechazos, avisados:Set }
  return {
    registrar({ id, nombre, status, cuitConsultado }) {
      if (!id) return [];
      const t = ahora();
      const hora = t - (t % 3_600_000);
      let h = horas.get(id);
      if (!h || h.hora !== hora) {
        h = { hora, cuits: new Set(), rechazos: 0, avisados: new Set() };
        horas.set(id, h);
      }
      if (cuitConsultado) h.cuits.add(String(cuitConsultado));
      if (status === 403 || status === 429) h.rechazos += 1;

      const alertas = [];
      if (umbrales.cuitsPorHora > 0 && h.cuits.size >= umbrales.cuitsPorHora && !h.avisados.has('cuits')) {
        h.avisados.add('cuits');
        alertas.push({ claveId: id, clave: nombre, motivo: 'muchos_cuits', detalle: `Consultó ${h.cuits.size} CUITs distintos en la última hora (umbral ${umbrales.cuitsPorHora}).`, cantidad: h.cuits.size });
      }
      if (umbrales.rechazosPorHora > 0 && h.rechazos >= umbrales.rechazosPorHora && !h.avisados.has('rechazos')) {
        h.avisados.add('rechazos');
        alertas.push({ claveId: id, clave: nombre, motivo: 'muchos_rechazos', detalle: `Tuvo ${h.rechazos} pedidos rechazados (sin permiso o por límite) en la última hora (umbral ${umbrales.rechazosPorHora}).`, cantidad: h.rechazos });
      }
      if (horas.size > 1000) for (const [k, w] of horas) if (w.hora < hora) horas.delete(k);
      return alertas;
    },
  };
}

module.exports = { crearLimitador, crearDetector, LIMITE_DEFAULT, UMBRALES_DEFAULT };
