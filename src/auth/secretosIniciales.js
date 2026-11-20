'use strict';

// Credenciales que Arcanum genera solo cuando no vienen por entorno: la clave de API
// (sin ARCANUM_API_KEY) y la contrasena del primer superadmin (sin ARCANUM_ADMIN_PASS).
//
// NUNCA van al log: los registros del contenedor los ve cualquiera con acceso al panel y
// quedan guardados. Se escriben en el volumen de datos con permisos 0600 (mismo criterio que
// la master key en crypto/vault.js) y el log solo dice donde leerlas.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ARCHIVO_API_KEY = 'api-key-generada';
const ARCHIVO_CLAVE_ADMIN = 'admin-clave-inicial';

/** Escribe `valor` en dir/nombre con permisos 0600. Devuelve la ruta. Tira si no puede. */
function guardarSecreto(dir, nombre, valor) {
  fs.mkdirSync(dir, { recursive: true });
  const ruta = path.join(dir, nombre);
  fs.writeFileSync(ruta, `${valor}\n`, { mode: 0o600 });
  fs.chmodSync(ruta, 0o600); // writeFileSync no cambia los permisos de un archivo existente
  return ruta;
}

/** Lee dir/nombre; null si no existe o esta vacio. */
function leerSecreto(dir, nombre) {
  try {
    return fs.readFileSync(path.join(dir, nombre), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Clave de API maestra: la del entorno; si no hay, la generada y guardada antes (sobrevive a
 * los reinicios); si tampoco, una nueva que se guarda. El log nunca lleva la clave.
 * @returns {{ clave: string, ruta: string|null }}
 */
function resolverApiKey({ apiKey, dataDir, log = console.log }) {
  if (apiKey) return { clave: apiKey, ruta: null };
  const ruta = path.join(dataDir, ARCHIVO_API_KEY);
  const previa = leerSecreto(dataDir, ARCHIVO_API_KEY);
  if (previa) {
    log(`[arcanum] Sin ARCANUM_API_KEY: se usa la clave de API generada que esta en ${ruta}`);
    return { clave: previa, ruta };
  }
  const clave = crypto.randomBytes(24).toString('hex');
  try {
    guardarSecreto(dataDir, ARCHIVO_API_KEY, clave);
    log('[arcanum] No se definio ARCANUM_API_KEY: se genero una clave de API (no se muestra en el log).');
    log(`[arcanum]   Leela desde la consola del servicio: cat ${ruta}`);
    log('[arcanum]   Va en el header X-API-Key. Para fijarla, defini ARCANUM_API_KEY.');
    return { clave, ruta };
  } catch (e) {
    log(`[arcanum] No se definio ARCANUM_API_KEY y no se pudo guardar una generada (${e.message}).`);
    log('[arcanum]   La clave maestra queda inutilizable: defini ARCANUM_API_KEY o crea claves desde la interfaz.');
    return { clave, ruta: null };
  }
}

module.exports = { guardarSecreto, leerSecreto, resolverApiKey, ARCHIVO_API_KEY, ARCHIVO_CLAVE_ADMIN };
