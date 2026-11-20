'use strict';

// Restaurar un backup de Arcanum.
//
//   docker compose exec arcanum node src/tools/restaurar-backup.js /data/backups/arcanum-AAAAMMDD-HHMM.arcbak
//       -> simulacro: muestra de cuando es, version y cuantas filas tiene cada tabla. No toca nada.
//   docker compose exec arcanum node src/tools/restaurar-backup.js <archivo> --confirmar
//       -> REEMPLAZA los datos actuales por los del backup, en una sola transaccion.
//
// Necesita la misma master key (o ARCANUM_BACKUP_KEY) con la que se hizo el backup.

const fs = require('fs');
const backup = require('../services/backup');
const db = require('../db');

async function main() {
  const archivo = process.argv[2];
  const confirmar = process.argv.includes('--confirmar');
  if (!archivo || archivo.startsWith('--')) {
    console.error('Uso: node src/tools/restaurar-backup.js <archivo.arcbak> [--confirmar]');
    process.exit(2);
  }
  const buf = fs.readFileSync(archivo);
  const r = await backup.restaurar(buf, { confirmar });
  console.log(`Backup del ${r.creado} (Arcanum ${r.version || '?'})`);
  for (const [t, n] of Object.entries(r.tablas)) console.log(`  ${t.padEnd(24)} ${n}`);
  console.log(r.simulacro
    ? '\nSIMULACRO: no se cambio nada. Para reemplazar los datos actuales, agrega --confirmar.'
    : '\nRESTAURADO: los datos actuales se reemplazaron por los del backup. Reinicia Arcanum.');
}

main()
  .catch((e) => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; })
  .finally(() => db.pool.end().catch(() => {}));
