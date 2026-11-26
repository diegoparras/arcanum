# Política de seguridad

## Reportar una vulnerabilidad

Si encontrás una vulnerabilidad en Arcanum, **no abras un issue público**. Reportala de forma
privada por una de estas vías:

- GitHub → pestaña **Security** → *Report a vulnerability* (Private Vulnerability Reporting).
- O por correo al mantenedor.

Incluí, si podés: descripción, pasos para reproducir, impacto y versión afectada. Te respondemos
a la brevedad y coordinamos la divulgación una vez que haya un fix.

## Buenas prácticas al desplegar

Arcanum maneja certificados y claves privadas fiscales. En producción:

- Definí **siempre** `ARCANUM_MASTER_KEY` (cifra las claves privadas en reposo) y guardala fuera del
  servidor. Sin ella no se pueden descifrar los certificados.
- Definí `ARCANUM_API_KEY` y `ARCANUM_SESSION_SECRET` propios y fuertes (si falta el secreto de
  sesión, Arcanum genera uno en el volumen; nunca usa la clave de API ni la master key para eso).
- Poné `ARCANUM_ENV=prod` solo cuando uses certificados de producción.
- Serví la app **detrás de HTTPS** (reverse proxy). La app no termina TLS.
- No expongas el puerto de Postgres; usá credenciales propias. El `docker-compose.yml` exige
  `POSTGRES_PASSWORD` y publica Arcanum solo en `127.0.0.1` (delante va el proxy con HTTPS).
- Usá roles: `lectura`/`operador` para el día a día; `superadmin` solo para administración. Asigná
  `cuit_allow` a los usuarios que deban ver solo ciertos CUITs.

## Alcance

Arcanum no está afiliado ni respaldado por ARCA/AFIP. Es software self-hosted: la seguridad de la
instancia (red, secretos, backups) es responsabilidad de quien la opera.
