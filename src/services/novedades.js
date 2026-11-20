'use strict';

// Novedades por version, leidas del CHANGELOG.md (una sola fuente de verdad).
// Se muestran en tres lugares: el log de arranque (lo primero que se ve en el deploy de
// EasyPanel), la UI (aviso "Novedades" al entrar despues de una actualizacion) y el Release de
// GitHub que crea el CI. Formato esperado (Keep a Changelog):
//   ## [X.Y.Z] - AAAA-MM-DD
//   ### Seccion
//   - item (las lineas siguientes con sangria continuan el item)

const fs = require('node:fs');
const path = require('node:path');

const RE_VERSION = /^## \[(\d+\.\d+\.\d+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/;

/** @returns {{version:string, fecha:string|null, secciones:{titulo:string, items:string[]}[]}[]} */
function parsear(texto) {
  const versiones = [];
  let v = null;
  let sec = null;
  for (const linea of String(texto || '').split(/\r?\n/)) {
    const m = linea.match(RE_VERSION);
    if (m) { v = { version: m[1], fecha: m[2] || null, secciones: [] }; versiones.push(v); sec = null; continue; }
    if (!v) continue;
    if (/^## /.test(linea)) { v = null; continue; }
    const t = linea.match(/^### (.+)/);
    if (t) { sec = { titulo: t[1].trim(), items: [] }; v.secciones.push(sec); continue; }
    if (!sec) continue;
    const item = linea.match(/^- (.*)/);
    if (item) { sec.items.push(item[1].trim()); continue; }
    if (/^\s+\S/.test(linea) && sec.items.length) sec.items[sec.items.length - 1] += ' ' + linea.trim();
  }
  for (const x of versiones) x.secciones = x.secciones.filter((s) => s.items.length);
  return versiones;
}

function comparar(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** Versiones posteriores a `vista` y hasta `actual` inclusive (sin `vista`: solo la actual). */
function desde(versiones, vista, actual) {
  if (!vista) return versiones.filter((x) => x.version === actual);
  return versiones.filter((x) => comparar(x.version, vista) > 0 && comparar(x.version, actual) <= 0);
}

const plano = (s) => String(s).replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');

/** Una linea por item, sin markdown, para el log del contenedor. */
function lineasLog(v) {
  return v.secciones.flatMap((s) => s.items.map((i) => `${s.titulo}: ${plano(i)}`));
}

/** Notas en markdown para el Release de GitHub. */
function notasMarkdown(v) {
  return v.secciones.map((s) => `### ${s.titulo}\n${s.items.map((i) => `- ${i}`).join('\n')}`).join('\n\n') + '\n';
}

let cache = null;
/** CHANGELOG.md de la instalacion (viene en la imagen). Sin archivo: lista vacia, nunca tira. */
function todas() {
  if (cache) return cache;
  try {
    cache = parsear(fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8'));
  } catch {
    cache = [];
  }
  return cache;
}

module.exports = { parsear, desde, comparar, lineasLog, notasMarkdown, todas };
