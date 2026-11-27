#!/usr/bin/env bash
# Arcanum de demostración para las capturas, el video y las guías.
#
# Construye la imagen con el código del repo, levanta Postgres y Arcanum en una red propia y
# carga datos ficticios (demo.js). El contenedor no tiene salida a internet (--dns 127.0.0.1) y
# corre con ARCANUM_DAEMONS=0: nunca habla con ARCA.
#
# Uso:  docs/fuentes/demo/arc-demo.sh up     (queda en http://localhost:18971, admin / Demo-Arcanum-2026)
#       docs/fuentes/demo/arc-demo.sh down
set -u
NET=arc-demo-net; DB=arc-demo-db; CT=arc-demo; IMG=arc-demo:local; PUERTO=18971
AQUI=$(cd "$(dirname "$0")" && pwd)
RAIZ=$(cd "$AQUI/../../.." && pwd)

bajar() { docker rm -f $CT $DB >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; }
if [ "${1:-up}" = down ]; then bajar; echo "demo abajo"; exit 0; fi
bajar

# Contexto de build: solo lo versionado o no ignorado, sin .env ni data/.
CTX=$(mktemp -d)
(cd "$RAIZ" && git ls-files -co --exclude-standard | grep -v '^\.env$' | grep -v '^data/' | tar -cf - -T -) | tar -xf - -C "$CTX"
docker build -q -t $IMG "$CTX" >/dev/null || { echo "falló el build"; exit 1; }
rm -rf "$CTX"

docker network create $NET >/dev/null
docker run -d --name $DB --network $NET -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=app postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do docker exec $DB pg_isready -U app >/dev/null 2>&1 && break; sleep 1; done; sleep 2

docker run -d --name $CT --network $NET --dns 127.0.0.1 -p $PUERTO:8080 \
  -e PORT=8080 -e ARCANUM_ENV=homo -e ARCANUM_DAEMONS=0 \
  -e DATABASE_URL=postgresql://app:app@$DB:5432/app \
  -e ARCANUM_ADMIN_USER=admin -e ARCANUM_ADMIN_PASS=Demo-Arcanum-2026 \
  -e ARCANUM_MASTER_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
  -e FISHERBOY_URL=http://fisherboy:8099 -e FISHERBOY_TOKEN=demo $IMG >/dev/null
for _ in $(seq 1 60); do
  docker exec $CT node -e "fetch('http://localhost:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && break
  sleep 1
done

docker cp "$AQUI/demo.js" $CT:/tmp/demo.js
docker exec $CT node /tmp/demo.js
echo "http://localhost:$PUERTO  (HTTP $(curl -s -o /dev/null -w '%{http_code}' localhost:$PUERTO/))"
