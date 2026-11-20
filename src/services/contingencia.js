'use strict';

// Contingencia: distinguir "ARCA no responde" (se puede encolar y reintentar sin riesgo) de un
// rechazo o un error del pedido (final: reintentar daria el mismo resultado).

const FAULT_TRANSITORIO = /no disponible|unavailable|temporalmente|timeout|time out/i;

function esIndisponibilidad(e) {
  if (!e || !e.extra) return false;
  const { tipo, status } = e.extra;
  if (tipo === 'timeout' || tipo === 'conexion') return true;
  if (tipo === 'http') return Number(status) >= 500;
  if (tipo === 'fault') return FAULT_TRANSITORIO.test(String(e.message || ''));
  return false;
}

module.exports = { esIndisponibilidad };
