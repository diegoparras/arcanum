'use strict';

// Notas de la version de package.json, sacadas del CHANGELOG.md (las usa el CI para el Release).
// Sale con error si la version no tiene su seccion: ningun deploy sin decir que cambia.
//   node src/tools/notas-version.js            -> markdown de la version actual
//   node src/tools/notas-version.js --version  -> solo el numero

const { version } = require('../../package.json');
const nov = require('../services/novedades');

if (process.argv.includes('--version')) {
  process.stdout.write(version);
} else {
  const v = nov.todas().find((x) => x.version === version);
  if (!v || !v.secciones.length) {
    console.error(`CHANGELOG.md no tiene la seccion "## [${version}]" (o esta vacia): agregala antes de publicar.`);
    process.exit(1);
  }
  process.stdout.write(nov.notasMarkdown(v));
}
