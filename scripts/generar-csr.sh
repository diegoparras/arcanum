#!/usr/bin/env bash
# Genera la clave privada y el CSR para tramitar el certificado en ARCA.
# El CSR es lo que se sube al portal de ARCA; la .key se queda en tu servidor.
#
# Uso:   ./generar-csr.sh <CUIT> "<Nombre o Razón Social>"
# Ej:    ./generar-csr.sh 20111111112 "Juan Perez"
#
# Salida (en data/certs/):
#   <CUIT>.key   clave privada  -> dejala donde está, Arcanum la usa
#   <CUIT>.csr   pedido a subir  -> subilo a ARCA y descargá el .crt resultante
set -euo pipefail

CUIT="${1:?Falta el CUIT}"
NOMBRE="${2:?Falta el nombre o razón social}"
OUT="$(dirname "$0")/../data/certs"
mkdir -p "$OUT"

openssl genrsa -out "$OUT/$CUIT.key" 2048
openssl req -new -key "$OUT/$CUIT.key" -out "$OUT/$CUIT.csr" \
  -subj "/C=AR/O=$NOMBRE/CN=arcanum-$CUIT/serialNumber=CUIT $CUIT"

chmod 600 "$OUT/$CUIT.key"

echo
echo "Listo."
echo "  Clave privada : $OUT/$CUIT.key   (NO la compartas, NO la subas a ARCA)"
echo "  CSR a subir   : $OUT/$CUIT.csr"
echo
echo "Siguiente paso:"
echo "  Homologación -> https://www.afip.gob.ar/ws/WSASS/html/crearcertificado.html"
echo "  Producción   -> portal ARCA > Administración de Certificados Digitales"
echo "Subí el .csr, descargá el certificado y guardalo como $OUT/$CUIT.crt"
echo "Luego asociá el WS (ej. wsfe) en el Administrador de Relaciones de Clave Fiscal."
