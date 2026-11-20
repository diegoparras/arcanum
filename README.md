<div align="center">

# Arcanum

**El gateway que convierte el kilombo de ARCA en una API REST que un contador instala en un minuto.**

Self-hosted · Firma WSAA 100% local · Sin terceros · Sin suscripciones · Para automatizar con n8n

Parte de la suite **Escriba** · Licencia Apache-2.0

</div>

---

## El problema

Integrarse con los Web Services de ARCA (ex-AFIP) es, sin vueltas, un dolor de cabeza:

- Todo es **SOAP/XML** con WSDLs frágiles y namespaces caprichosos.
- Antes de pedir *cualquier* cosa tenés que pasar por **WSAA**: armar un *Ticket de Requerimiento de Acceso* (TRA), **firmarlo en formato CMS/PKCS#7** con tu certificado, mandarlo, y recién ahí recibís un *Token* y un *Sign*.
- Ese token **dura 12 horas y NO podés pedir otro antes** — ARCA te rechaza. Así que tenés que **cachearlo** y renovarlo en el momento justo.
- Hay **un certificado y endpoints distintos** para homologación y para producción, que no se pueden mezclar.
- Y todo esto **multiplicado por cada CUIT** que manejás y por cada uno de los ~20 servicios de ARCA.

Las alternativas existentes o cubren solo facturación, o son librerías que igual hay que programar, o —ojo— **mandan tu autenticación al servidor de un tercero**.

## La solución

Arcanum hace **todo ese trabajo sucio una sola vez, localmente**, y te expone una **API REST limpia** + una **interfaz web**. Tu clave privada **nunca sale del contenedor** ni pasa por nadie.

```
  n8n / tu sistema  ──HTTP REST──►  Arcanum  ──SOAP──►  ARCA
   (una llamada)                   (en tu server)      (homo o prod)
                                   ├─ firma WSAA local (CMS/PKCS#7)
                                   ├─ cachea Token+Sign 12h y los renueva solo
                                   ├─ traduce SOAP ⇄ JSON
                                   └─ Postgres (clientes, certs cifrados, auditoría)
```

Lo que para vos era *"armar el TRA, firmarlo, loguear a WSAA, cachear, armar el sobre SOAP, parsear el XML"* se transforma en:

```bash
curl -X POST https://tu-arcanum/api/ws/padron_a5/getPersona_v2 \
  -H "X-API-Key: TU_CLAVE" -H "Content-Type: application/json" \
  -d '{ "cuit": "20111111112", "params": { "idPersona": "20999999993" } }'
```
…y te vuelve el JSON con los datos del contribuyente. Arcanum resolvió el WSAA, la firma, el caché y el SOAP por vos.

---

## Cómo funciona (la magia, explicada)

### 1. Firma WSAA 100% local
El corazón del problema —firmar el TRA en CMS/PKCS#7— lo resuelve Arcanum **en memoria, dentro de tu contenedor**, con `node-forge`. **No se usa ningún SDK que llame a servidores de terceros.** Tu clave privada se guarda **cifrada en reposo (AES-256-GCM)** en la base; la master key vive en una variable de entorno, nunca en la DB.

### 2. Token cacheado y auto-recuperación
El *Ticket de Acceso* (Token+Sign) se cachea por **CUIT + servicio + entorno** en Postgres, con *advisory locks* para que dos pedidos simultáneos no disparen dos logins. Un *daemon* lo **renueva antes de que venza**, y si ARCA alguna vez rechaza por token vencido, Arcanum **reintenta solo** de forma transparente.

### 3. Catálogo de servicios editable + motor genérico
Todos los servicios de ARCA viven en un **catálogo declarativo** (endpoint, namespace, cómo autenticar, **guía de activación**). Esto da dos cosas:
- **Motor genérico** `POST /api/ws/{servicio}/{operación}`: llamás **cualquier** operación de **cualquier** servicio mandando un JSON. Arcanum arma el sobre y resuelve la auth.
- **Catálogo editable en vivo por el superadmin**: ARCA cambia endpoints seguido — los corregís desde la UI **sin redeployar** (se guardan en la base, auditado). Esto lo hace un tanque.

Sobre los más usados hay **módulos "ricos"** con validación y respuestas REST ergonómicas (ver más abajo).

### 4. Multi-cliente y multi-entorno
Manejás **varios CUITs** desde la misma instancia. Y cambiás entre **homologación y producción** desde la propia interfaz (menú → Entorno ARCA), en caliente y persistido — sin tocar variables ni redeployar.

---

## Instalación (un comando)

Requisitos: Docker. Generá los secretos:
```bash
openssl rand -hex 24   # ARCANUM_API_KEY     (protege la API)
openssl rand -hex 32   # ARCANUM_MASTER_KEY  (cifra las claves privadas — guardala bien)
```
Y levantá:
```bash
git clone <repo> arcanum && cd arcanum
cp .env.example .env        # completá ARCANUM_API_KEY, ARCANUM_MASTER_KEY y ARCANUM_ADMIN_PASS
docker compose up -d
```
Levanta Postgres + la app en el puerto **8094**. Entrá a **http://localhost:8094**.

Para **EasyPanel / Dokploy / Portainer** y el despliegue con imagen publicada, ver [DESPLIEGUE.md](DESPLIEGUE.md).

---

## La interfaz web

Panel limpio (tema claro/oscuro, sin frameworks), con todo lo que un contador necesita:

- **Panel**: métricas en vivo — emisiones del día, monto, tokens vigentes, certificados por vencer, peticiones, y **estado de cada servicio de ARCA** (uptime + latencia, con monitoreo automático).
- **Clientes**: alta de un CUIT generando el **CSR** del lado del server, pegando después el `.crt` de ARCA; o **importar un par clave+certificado** que ya tengas. Ves vigencia y estado.
- **Servicios**: el catálogo completo, con **guía de activación paso a paso** por servicio (qué asociar en el Administrador de Relaciones de Clave Fiscal). El superadmin puede editar/agregar servicios acá.
- **Emitir**: formulario para sacar un comprobante y obtener el CAE.
- **Comprobantes**: listado, descarga del **PDF con QR de ARCA**, export CSV para Libro IVA.
- **Generador**: armás la consulta y te genera el **nodo de n8n listo para pegar** + snippets en **cURL / JavaScript / Python**. Incluye un explorador que **lee el WSDL en vivo** y te lista operaciones y campos.
- **Webhooks** y **Usuarios** (con roles).

---

## Servicios de ARCA cubiertos

Todos accesibles vía el motor genérico (`/api/ws/...`). Los marcados **rico** tienen además endpoints REST dedicados con validación.

| Servicio | Para qué | Soporte |
|---|---|---|
| **WSFEv1** | Factura electrónica nacional (A/B/C/M, CAE) | **rico** |
| WSFEXv1 | Factura de exportación | genérico |
| WSMTXCA | Factura con detalle de ítems | genérico |
| WSBFEv1 | Bonos fiscales | genérico |
| WSCT | Comprobantes de turismo | genérico |
| WSFECRED | Factura de Crédito MiPyME (FCE) | genérico |
| **Padrón A5** | Constancia de inscripción / datos del contribuyente | **rico** |
| **Padrón A13** | Mi Categoría / datos de monotributo | **rico** |
| WSCDC | Constatación de comprobantes (validar CAE) | genérico |
| WSCTG | Código de Trazabilidad de Granos | genérico |
| WSLPG / WSLSP | Liquidación de granos / sector pecuario | genérico |
| WSLUM / WSLTV | Liquidación lechera / tabaco | genérico |
| WSREMCARNE / HARINA / AZUCAR | Remitos electrónicos | genérico |

> Un servicio genérico se "asciende" a rico cuando hace falta. Y el superadmin puede sumar cualquier WS nuevo desde la UI sin tocar código.

---

## Conectar a n8n

Un solo nodo **HTTP Request**:
- **Method** `POST`, **URL** `https://tu-arcanum/api/ws/padron_a5/getPersona_v2` (o el endpoint que necesites)
- Credencial **Header Auth** → Name `X-API-Key`, Value tu clave
- **Body (JSON)**: `{ "cuit": "20111111112", "params": { "idPersona": "{{ $json.cuit }}" } }`

Listo: sin nodos de WSAA, sin firmar a mano. Y desde la pestaña **Generador** de la UI te sale el nodo ya armado para copiar y pegar.

Arcanum también te puede avisar a vos: configurás **webhooks** (firmados con HMAC) que disparan ante eventos — `comprobante_emitido`, `cert_por_vencer`, `arca_caido`, etc.

---

## Endpoints principales

| | |
|---|---|
| `POST /api/wsfev1/comprobantes` | Emitir y obtener CAE (auto-numeración, idempotencia, validación de importes) |
| `GET  /api/wsfev1/consultar` | Reimprimir / verificar un comprobante |
| `GET  /api/padron/a5/{cuit}` · `a13` | Consulta de padrón (módulo rico) |
| `POST /api/ws/{servicio}/{operación}` | Genérico: cualquier servicio del catálogo |
| `GET  /api/services` · `/api/services/{id}/operaciones` | Catálogo + introspección de WSDL |
| `GET  /api/comprobantes` · `/export.csv` · `/{…}/pdf` | Comprobantes, export y PDF con QR |
| `GET  /api/metrics` · `/metrics` | Métricas (JSON y Prometheus) |
| `GET /docs` | OpenAPI interactivo |

Toda la API se autentica con `X-API-Key`, con `Authorization: Bearer <clave>` o con la sesión del panel. Las emisiones aceptan el encabezado `Idempotency-Key` (o `idempotencyKey` en el cuerpo): un reintento devuelve el comprobante ya emitido, sin pedir otro CAE.

---

## Claves de API

Además de la clave maestra (`API_KEY` del entorno), en **Usuarios → Claves de API** se crean claves propias para cada integración:

- **Rol por clave**: `lectura` (solo consulta: ni por la API REST ni por MCP puede emitir ni modificar nada), `operador` (puede emitir) o `admin`.
- **CUITs permitidos** opcionales: la clave queda limitada a esos contribuyentes.
- **Baja individual**: dar de baja una clave la corta al instante sin tocar las demás.
- **Vencimiento** opcional (en días) y **rotación**: rotar crea una clave nueva con los mismos permisos y deja la anterior andando los días de gracia que elijas (7 por defecto), así cambiás la integración sin cortes.
- **Límite por minuto** por clave (120 por defecto, `ARCANUM_CLAVE_LIMITE_MIN`; 0 lo apaga). Al pasarse responde `429` con `Retry-After`.
- **Uso por clave**: pedidos, errores, rechazos, CUITs consultados, operaciones y últimos pedidos (botón "Uso").
- **Alertas de uso anómalo**: si una clave consulta muchos CUITs distintos en una hora (`ARCANUM_ANOMALIA_CUITS_HORA`, 50) o acumula rechazos por permiso o por límite (`ARCANUM_ANOMALIA_RECHAZOS_HORA`, 20), se dispara el evento `clave_anomala`.
- La clave se muestra **una sola vez** al crearla; Arcanum guarda solo su hash SHA-256 y nunca la escribe en los logs.

## Servidor MCP (solo consulta)

`POST /mcp` publica un servidor [Model Context Protocol](https://modelcontextprotocol.io) sobre Streamable HTTP, sin estado, para asistentes como SecretarIA. Exige una clave (`Authorization: Bearer <clave>` o `X-API-Key`); sin clave o con una clave inválida responde `401`.

| Herramienta | Devuelve |
|---|---|
| `padron` | Razón social, condición frente al IVA, domicilio fiscal, actividades y estado de la clave (padrón A5) |
| `comprobante` | Fecha, importes, CAE, vencimiento del CAE y receptor de un comprobante (ej. `0003-00000124`) |
| `ultimo_comprobante` | Último número autorizado y próximo número para un punto de venta y tipo |
| `puntos_de_venta` | Puntos de venta habilitados en ARCA para facturación electrónica |
| `estado_arca` | Si ARCA responde ahora y el último estado conocido de cada servicio |
| `riesgo_fiscal` | Semáforo (verde, amarillo, rojo) que cruza padrón A5 y base de apócrifos, con el comprobante sugerido |
| `comprobantes_recientes` | Últimos comprobantes emitidos o importados por Arcanum, con filtros por fecha y receptor |
| `comunicaciones_ventanilla` | Comunicaciones de e-Ventanilla de los últimos días (solo el listado: no las marca como leídas) |
| `vencimiento_certificado` | Hasta cuándo sirve cada certificado cargado |
| `vista_previa_comprobante` | Revisa un comprobante sin emitirlo: problemas, advertencias, número que le tocaría y el cuerpo listo para emitir |
| `mis_comprobantes` | Emitidos y recibidos de Mis Comprobantes ya bajados: cantidades, neto (las NC restan), por tipo y los últimos 50 |
| `topes_monotributo` | Facturado en 12 meses contra el tope de la categoría: porcentaje, alerta, margen y categoría sugerida |
| `constatacion_recibidos` | Resultado guardado de constatar los recibidos (WSCDC + apócrifos) y los observados |

Todas son de solo lectura: la emisión y el motor genérico `/api/ws/...` no se exponen por MCP. Para que un asistente facture, el flujo es: `vista_previa_comprobante`, la persona aprueba, y la emisión va por `POST /api/wsfev1/comprobantes` con una clave aparte de rol `operador` y el `idempotencyKey` que propone la vista previa. Cada llamada corta a los 80 s (`ARCANUM_MCP_TIMEOUT_MS`) con un error claro y las respuestas se recortan por debajo de 20.000 caracteres. Las respuestas son datos JSON, nunca texto dirigido al asistente.

```bash
curl -s -X POST https://tu-arcanum/mcp \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -H "authorization: Bearer ark_..." \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"prueba","version":"1"}}}'
```

## Mis Comprobantes (con el navegador de Fisherboy)

ARCA no publica Mis Comprobantes por Web Service, así que Arcanum lo baja **operando la página**, con la *sesión de agente* de [Fisherboy](https://github.com/diegoparras/fisherboy/blob/main/docs/AGENT.md) (Arcanum no trae navegador propio):

1. Fisherboy corre una **receta** fija: login, portal, Mis Comprobantes (que se abre en otra pestaña), representado, Emitidos o Recibidos, rango de fechas, exportar CSV.
2. Si un paso falla y Fisherboy tiene IA configurada (cualquier proveedor compatible con OpenAI, incluido Ollama local), la IA intenta cumplir el **objetivo** de ese paso y la receta sigue. La IA ve la página como texto, con los CUIT y otros datos personales reemplazados por marcadores, y **nunca ve la clave**: la escribe por su marcador `{{secret:clave_fiscal}}`.
3. Si ARCA pide un **captcha** o un segundo factor, la sesión se pausa y lo resolvés en la pestaña **Mis Comprobantes**, que muestra el navegador **en vivo**. Con **Tomar el control** manejás vos y con **Devolver a la receta** sigue sola.
4. El CSV se parsea y se guarda sin duplicar (re-sincronizar actualiza importes).

La **clave fiscal** se carga por CUIT (admin), se guarda cifrada con la master key y no vuelve nunca por la API ni queda en logs. Si **ARCA rechaza la clave**, la credencial queda bloqueada y no se reintenta (ni a mano ni en la sincronización diaria) hasta que la vuelvas a cargar: repetir una clave mala puede bloquear la clave fiscal. Con **Sincronizar todos los días**, el daemon baja mes anterior y mes en curso a las `ARCANUM_MC_HORA` (6 por defecto, hora argentina). Fisherboy solo navega a `afip.gob.ar` y `arca.gob.ar`.

La receta se edita en vivo (superadmin, menú **Fisherboy y Mis Comprobantes**) para cuando ARCA cambie la página. Conexión: `FISHERBOY_URL` + `FISHERBOY_TOKEN` (ver [DESPLIEGUE.md](DESPLIEGUE.md)).

**Lo que se hace con esos datos:**

- **Topes de Monotributo** (`GET /api/monotributo/:cuit`): suma 12 meses de emitidos (Mis Comprobantes + lo emitido por Arcanum que no esté ahí, sin contar dos veces), con las notas de crédito restando, contra el tope de la categoría del padrón. Semáforo 80% / 100%, categoría sugerida, aviso `tope_monotributo` y recordatorio de recategorización en enero y julio. Los topes se cargan en Arcanum con su vigencia: **verificá los vigentes** en arca.gob.ar.
- **Constatación masiva** (`POST /api/constatacion` o el botón **Constatar recibidos**): cada recibido contra WSCDC y su emisor contra la base de apócrifos, hasta 500 por pedido.

## Vista previa de emisión

`POST /api/wsfev1/comprobantes/vista-previa` recibe el mismo cuerpo que la emisión y **no emite nada**: valida importes, IVA, tipo, receptor (con su padrón si es CUIT), condición de IVA, fecha y RG 5866, sugiere la letra según emisor y receptor, y devuelve el número que le tocaría. Es la única excepción de `POST` permitida a las claves de rol `lectura`. En la UI es el botón **Vista previa** de Emitir.

## Avisos proactivos

Arcanum avisa por webhook (firmado con HMAC) y por email si hay SMTP configurado:

| Evento | Cuándo |
|---|---|
| `arca_caido` / `arca_restablecido` | WSFEv1 deja de responder o vuelve (monitor cada 5 min) |
| `cert_por_vencer` | Un certificado vence en menos de 30 días |
| `comunicacion_nueva` | ARCA publica una comunicación en la e-Ventanilla de un CUIT (revisión cada hora, `ARCANUM_VENTANILLA_MIN`; la primera vez toma línea de base sin avisar lo viejo) |
| `clave_por_vencer` | Una clave de API vence en menos de 7 días |
| `clave_anomala` | Uso anómalo de una clave |
| `comprobante_emitido` / `comprobante_rechazado` | Cada emisión |
| `mis_comprobantes_sincronizado` / `mis_comprobantes_fallo` | Terminó una bajada de Mis Comprobantes, falló, o ARCA pide a una persona (captcha) |
| `tope_monotributo` | Un monotributista pasó el 80% o el 100% de su categoría, o toca recategorizar (enero y julio) |

En **Webhooks**, el botón **Probar** manda un evento `prueba` y muestra qué contestó el destino.

## Caché del padrón

Las consultas de padrón se guardan en memoria una hora (`ARCANUM_PADRON_CACHE_S`, 0 lo apaga): ARCA se pone lenta en horas pico y los datos de un CUIT cambian poco. `?fresco=1` en `/api/padron` y `/api/contribuyente` (o `actualizar: true` en la herramienta MCP `padron`) fuerza la consulta a ARCA. Los errores nunca se guardan.

---

## Seguridad

- **Firma local**: la clave privada se usa solo para firmar el TRA, en memoria, dentro del contenedor. No se transmite a ningún lado.
- **Cifrado en reposo**: claves privadas cifradas con AES-256-GCM; la master key vive fuera de la base.
- **Roles**: superadmin / admin / operador / lectura. Las operaciones sensibles (clientes, webhooks, usuarios, catálogo) exigen rol. El rol `lectura` (usuario o clave) solo puede hacer `GET`: la regla falla cerrada, para cualquier ruta nueva también.
- **Scope por CUIT** opcional: un usuario puede quedar limitado a ciertos CUITs (cierra el acceso cruzado).
- **Anti fuerza bruta** en el login, **anti-SSRF** en los webhooks, comparaciones en tiempo constante, imagen sin root, auditoría de peticiones (usuario + IP).
- En producción: `ARCANUM_ENV=prod`, secretos propios y detrás de HTTPS.

---

## Versionado y CI

Cada `git push` dispara **GitHub Actions**, que **buildea y publica la imagen multi-arch** (amd64 + arm64) en GHCR — sin tokens manuales. En cada deploy se sube el *patch* de la versión, que se ve en el menú **Acerca de**, para confirmar de un vistazo que el deploy tomó.

## Estado y roadmap

Operativo y verificado **end-to-end contra ARCA producción** (firma WSAA, consulta de padrón con datos reales, monitoreo de servicios). Roadmap: promover WSFEX/MTXCA/agro a módulos ricos, lotes y CAEA, federación con Lockatus (SSO de la suite). Ver [CHANGELOG.md](CHANGELOG.md).

## Tests
```bash
npm install && npm test
```

## Licencia
Apache-2.0. Arcanum no está afiliado ni respaldado por ARCA/AFIP.
