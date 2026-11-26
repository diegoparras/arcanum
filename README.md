<div align="center">

# Arcanum

**El gateway que convierte el kilombo de ARCA en una API REST que un contador instala en un minuto.**

Self-hosted · Firma WSAA 100% local · Sin terceros · Sin suscripciones · Para automatizar con n8n

Parte de la suite **Escriba** · Licencia MIT

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
- **Catálogo editable en vivo por el superadmin**: ARCA cambia endpoints seguido — los corregís desde la UI **sin redeployar** (se guardan en la base, auditado). Los endpoints solo pueden ser `https` de dominios de ARCA (`afip.gov.ar`, `afip.gob.ar`, `arca.gob.ar`): ahí viaja el Ticket de Acceso de cada CUIT. Se edita solo con sesión de superadmin, no con claves de API, y cada cambio avisa por el webhook `catalogo_cambiado`. Esto lo hace un tanque.

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
- **Facturas recibidas** (si [Factorum](#factorum-facturas-recibidas) está conectado): verificar si una factura es legal, subir lotes, revisar y aprobar lo leído, y bajar el Excel o el CSV.
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

Toda la API se autentica con `X-API-Key`, con `Authorization: Bearer <clave>` o con la sesión del panel. Las emisiones aceptan el encabezado `Idempotency-Key` (o `idempotencyKey` en el cuerpo): un reintento devuelve el comprobante ya emitido, sin pedir otro CAE. La clave vale por CUIT y entorno: la misma clave en otro CUIT no devuelve nada de ese CUIT.

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
| `facturas_recibidas` | Facturas recibidas leídas por Factorum (si está conectado): tipo, número, emisor, importes por alícuota, CAE, estado, hallazgos y constatación; hasta 50 |
| `factura_recibida` | Una factura recibida por su id, con de dónde salió cada campo y las correcciones hechas a mano |
| `resumen_facturas_recibidas` | Totales de las recibidas: neto, IVA por alícuota, otros tributos y total (las NC restan), por estado y por tipo |
| `verificar_factura` | Veredicto de una factura en base64 (válida, inválida, apócrifa, con errores o no verificable) sin guardarla |

Todas son de solo lectura: la emisión y el motor genérico `/api/ws/...` no se exponen por MCP. Para que un asistente facture, el flujo es: `vista_previa_comprobante`, la persona aprueba, y la emisión va por `POST /api/wsfev1/comprobantes` con una clave aparte de rol `operador` y el `idempotencyKey` que propone la vista previa. Cada llamada corta a los 80 s (`ARCANUM_MCP_TIMEOUT_MS`) con un error claro y las respuestas se recortan por debajo de 20.000 caracteres. Las respuestas son datos JSON, nunca texto dirigido al asistente.

```bash
curl -s -X POST https://tu-arcanum/mcp \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -H "authorization: Bearer ark_..." \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"prueba","version":"1"}}}'
```

## Mis Comprobantes (con el navegador de Fisherboy)

ARCA no publica Mis Comprobantes por Web Service, así que Arcanum lo baja **operando la página**, con la *sesión de agente* de [Fisherboy](https://github.com/diegoparras/fisherboy/blob/main/docs/AGENT.md) (Arcanum no trae navegador propio):

1. Fisherboy corre una **receta** fija: login, portal, Mis Comprobantes (que se abre en otra pestaña), representado y la sección (Emitidos o Recibidos). Ahí pide los comprobantes **directo a ARCA**, con la misma llamada que hace la página al apretar Buscar, y los recibe en JSON: no maneja el calendario, la tabla ni el botón de exportar. ARCA exige que la consulta sea de la sección abierta y de 365 días como máximo; Arcanum parte los rangos largos en tramos. Requiere Fisherboy 1.12.0 o superior.
2. **Por defecto es RPA puro:** si un paso falla, la corrida termina con el error del paso, sin IA. Con `ARCANUM_MC_IA=1`, si un paso falla y Fisherboy tiene IA configurada (cualquier proveedor compatible con OpenAI, incluido Ollama local), la IA intenta cumplir el **objetivo** de ese paso y la receta sigue. La IA ve la página como texto, con los CUIT y otros datos personales reemplazados por marcadores, y **nunca ve la clave**: la escribe por su marcador `{{secret:clave_fiscal}}`.
3. Si ARCA pide un **captcha** o un segundo factor, la sesión se pausa y lo resolvés en la pestaña **Mis Comprobantes**, que muestra el navegador **en vivo**. Con **Tomar el control** manejás vos y con **Devolver a la receta** sigue sola. Un admin puede tomar el control en cualquier momento. Un operador solo cuando ARCA pide una persona, y solo en el login de ARCA o en Mis Comprobantes: el navegador ya entró con la clave fiscal y desde el portal se llega a cualquier servicio del contribuyente. Cada clic o tecla queda en la auditoría con el CUIT y la página, nunca con lo tipeado.
4. El CSV se parsea y se guarda sin duplicar (re-sincronizar actualiza importes).
5. Si una corrida falla, Arcanum guarda la **última pantalla** del navegador de Fisherboy antes de cerrar la sesión, y en Sincronizaciones aparece **Ver pantalla**: muestra qué vio el robot cuando falló (un cartel de ARCA, una tabla que no llegó). Se borra a los 30 días.

**Análisis** (ícono propio en la barra lateral, aparece cuando hay comprobantes bajados): indicadores del período (facturado con las notas de crédito restadas y su variación contra el período anterior, notas de crédito, comprado, IVA crédito y débito, resultado bruto), gráfico por mes, principales clientes y proveedores, totales por tipo y subtotales por mes y contraparte. Todo filtra con un clic (un mes, una contraparte, un tipo, un indicador), cada filtro queda como un chip y el listado y el CSV siguen los mismos filtros. Por API: `GET /api/mis-comprobantes/:cuit/analisis`, con los mismos parámetros que el listado (`tipo`, `desde`, `hasta`, `clase`, `cbte`, `contraparte`, `q`).

La **clave fiscal** se carga por CUIT (admin), se guarda cifrada con la master key y no vuelve nunca por la API ni queda en logs. Si **ARCA rechaza la clave**, la credencial queda bloqueada y no se reintenta (ni a mano ni en la sincronización diaria) hasta que la vuelvas a cargar: repetir una clave mala puede bloquear la clave fiscal. La sincronización es **incremental**: la primera trae los últimos 12 meses (o desde la fecha que elijas) y las siguientes arrancan en lo último bajado de cada tipo menos `ARCANUM_MC_SOLAPE_DIAS` (30 por defecto), porque ARCA muestra algunos comprobantes días después de su fecha; repetir días no duplica. Con **Sincronizar todos los días**, el daemon hace eso a las `ARCANUM_MC_HORA` (6 por defecto, hora argentina). Mientras corre, la vista en vivo muestra en qué paso va la receta, si la IA está reintentando uno que falló y hace cuánto fue el último avance; si el registro de Fisherboy no avanza en `ARCANUM_MC_SIN_AVANCE_MIN` minutos (5 por defecto) sin una persona al mando, la corrida se corta y el error dice en qué paso quedó. Si Fisherboy frena antes de tocar un botón que podría no deshacerse, Arcanum da el OK solo cuando es una consulta (Buscar, Consultar, Filtrar); para cualquier otro, la vista en vivo pide **Sí, dale** / **No** a una persona. Fisherboy solo navega a `afip.gob.ar` y `arca.gob.ar`.

La receta se edita en vivo (superadmin, menú **Fisherboy y Mis Comprobantes**) para cuando ARCA cambie la página. Conexión: `FISHERBOY_URL` + `FISHERBOY_TOKEN` (ver [DESPLIEGUE.md](DESPLIEGUE.md)). El token de Fisherboy (y el de Factorum) solo viaja al servidor para el que se cargó: si cambiás la URL a otro host, Arcanum pide el token de nuevo. Si la URL viene por entorno, no se cambia desde el panel. Cada cambio avisa por el webhook `conexion_cambiada`.

**Lo que se hace con esos datos:**

- **Topes de Monotributo** (`GET /api/monotributo/:cuit`): suma 12 meses de emitidos (Mis Comprobantes + lo emitido por Arcanum que no esté ahí, sin contar dos veces), con las notas de crédito restando, contra el tope de la categoría del padrón. Semáforo 80% / 100%, categoría sugerida, aviso `tope_monotributo` y recordatorio de recategorización en enero y julio. Los topes se cargan en Arcanum con su vigencia: **verificá los vigentes** en arca.gob.ar.
- **Constatación masiva** (`POST /api/constatacion` o el botón **Constatar recibidos**): cada recibido contra WSCDC y su emisor contra la base de apócrifos, hasta 500 por pedido. Si ARCA lo rechaza con tu CUIT como receptor, se reintenta con tu CUIL, tu DNI y como consumidor final (muchas facturas B y C se hacen así); el resultado dice con cuál dio OK. Corre en segundo plano y se puede **Detener**: lo constatado queda guardado y la próxima vez sigue desde lo pendiente.

## Factorum (facturas recibidas)

**Factorum** es el lector de facturas de la suite: lee PDF e imágenes (QR de ARCA, texto, OCR y, si hay un modelo configurado, IA), corre los controles (que neto más IVA más otros dé el total, que el QR coincida con el texto, CUIT válidos, duplicados) y constata cada comprobante con ARCA. Es un servicio aparte, en Go; Arcanum le hace de puerta con sus propios usuarios, roles y scope por CUIT:

```
  Arcanum (UI, API, MCP) ──token de servicio──► Factorum ──clave de API──► Arcanum
  usuarios, roles, scope                        lee y controla              POST /api/constatacion
                                                                            GET  /api/padron/a5/:cuit
```

1. **Verificar una factura** (`POST /api/factorum/verificar`, rol operador o más): ¿es legal? Devuelve el veredicto (`valida`, `invalida`, `apocrifa`, `con_errores` o `no_verificable`), los datos clave y los hallazgos. No deja nada guardado. Si no se indica `cuit_consultante` y el usuario tiene un único CUIT permitido, se constata con ese.
2. **Lotes** (`POST /api/factorum/lotes`, rol operador o más): varias facturas o un ZIP, con el cliente del estudio, IA sí o no y constatar al terminar. Se procesan en segundo plano; la pestaña **Facturas recibidas** muestra el avance.
3. **Revisión**: cada comprobante queda `ok`, `revisar`, `error` o `aprobado`. Desde la UI se corrigen campos y se aprueba (`PATCH /api/factorum/comprobantes/:id`; cada cambio queda registrado con el usuario de Arcanum), con el archivo original a un clic.
4. **Excel y CSV** (`GET /api/factorum/export.xlsx` y `.csv`) con los mismos filtros, más `GET /api/factorum/resumen` con los totales por alícuota.

Leer (lotes, comprobantes, resumen, exportar) lo puede cualquier rol; con **scope por CUIT**, cada usuario o clave ve solo los clientes que tiene permitidos (y si tiene uno solo, se filtra por ese). Los archivos de hasta 20 MB (60 MB por lote) pasan por Arcanum sin quedar en ningún registro.

Conexión: `FACTORUM_URL` + `FACTORUM_TOKEN`, o desde el menú **Factorum (facturas recibidas)** (superadmin), donde el token se guarda cifrado y no vuelve nunca por la API. La pestaña aparece solo cuando Factorum responde. Para la vuelta, Factorum necesita una clave de Arcanum de rol `operador` acotada a los CUITs con los que constata: ver [DESPLIEGUE.md](DESPLIEGUE.md).

## PDF del comprobante

Por defecto el PDF es **igual al de ARCA** ("Comprobantes en línea": original, duplicado y triplicado) y el archivo se llama como lo nombra ARCA, `CUIT_TIPO_PV_NUMERO.pdf`. Al facturar se puede elegir otro modelo (`arcanum`) y otro nombre con una plantilla (`{receptor}`, `{numero}`, `{pv}`, `{letra}`, `{tipo}`, `{fecha}`, `{cuit}`, `{total}`):

```json
{ "pdf": { "modelo": "arca", "nombreArchivo": "FACTURA {receptor} {letra}-{pv}-{numero}" } }
```

`GET /api/comprobantes/:cuit/:pv/:tipo/:nro/pdf` respeta lo elegido; `?modelo=`, `?nombre=` y `?copias=1..3` lo pisan para esa descarga.

**Datos del encabezado.** Lo que ARCA expone por web service se completa solo desde el padrón (constancia de inscripción): razón social, domicilio y condición frente al IVA del emisor (botón **Traer de ARCA** en Clientes > Datos fiscales, o al generar el PDF si faltan), y nombre y domicilio del receptor con CUIT (al emitir, o al generar el PDF de uno ya emitido). Nunca se pisa lo cargado a mano. **Ingresos Brutos** y **fecha de inicio de actividades** no los da ARCA por web service: se cargan una vez en Datos fiscales; la vista previa avisa si faltan. Sin condición cargada, una factura C sale como "Responsable Monotributo", nunca como inscripto.

## Contingencia: que la facturación no se corte

- **Cola**: emitiendo con `"contingencia": true` (o con el tilde de Emitir), si ARCA no responde el comprobante queda en la cola (`202`) y sale solo cuando vuelve (el daemon reintenta con espera creciente y en el acto con `arca_restablecido`). Si el pedido llegó a ARCA pero la respuesta no volvió, antes de reintentar se consulta ese número: si ARCA lo otorgó, se **adopta ese CAE**. La fecha nunca cambia sola: si ARCA ya no la acepta, el comprobante espera tu decisión ("emitir con fecha de hoy" o cancelar). Todo en la pestaña **Contingencia**.
- **CAEA (opcional por CUIT)**: se prende en Contingencia con un punto de venta de tipo CAEA. Arcanum pide el código de cada quincena, emite con CAEA solo si ARCA sigue caído pasados los minutos elegidos, e informa todo (y los "sin movimiento") cuando vuelve. Avisa (`caea_informe_pendiente`) a 2 días de la fecha tope. Pedir un CAEA obliga a informar: por eso está apagado por defecto.
- **Lo emitido por fuera**: en Comprobantes, **Traer lo emitido por fuera** (o `POST /api/wsfev1/sincronizar`, y una vez por día) suma lo facturado en la web de ARCA u otro sistema, y avisa si algo no coincide.

## Backups

Diarios a las 3 (`ARCANUM_BACKUP_HORA`), cifrados con una clave derivada de la master key (o `ARCANUM_BACKUP_KEY`), en `/data/backups` (se guardan los últimos `ARCANUM_BACKUP_RETENER`, 14). El superadmin los ve y descarga en **Backups y master key**. Restaurar:

```bash
docker compose exec arcanum node src/tools/restaurar-backup.js /data/backups/arcanum-AAAAMMDD-HHMM.arcbak            # simulacro
docker compose exec arcanum node src/tools/restaurar-backup.js /data/backups/arcanum-AAAAMMDD-HHMM.arcbak --confirmar
```

Sin la master key no se abren ni los certificados ni los backups: Arcanum muestra un aviso hasta que confirmes que la guardaste fuera del servidor.

## Vista previa de emisión

`POST /api/wsfev1/comprobantes/vista-previa` recibe el mismo cuerpo que la emisión y **no emite nada**: valida importes, IVA, tipo, receptor (con su padrón si es CUIT), condición de IVA, fecha y RG 5866, sugiere la letra según emisor y receptor, y devuelve el número que le tocaría. Junto con `POST /api/constatacion` (constatar una lista sin guardar nada), es una de las dos excepciones de `POST` permitidas a las claves de rol `lectura`. En la UI es el botón **Vista previa** de Emitir.

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
- **Roles**: superadmin / admin / operador / lectura. Las operaciones sensibles (clientes, webhooks, usuarios, catálogo) exigen rol. El rol `lectura` (usuario o clave) solo puede hacer `GET`, más dos `POST` que solo consultan (vista previa y constatación de una lista): la regla falla cerrada, para cualquier ruta nueva también.
- **Scope por CUIT** opcional: un usuario puede quedar limitado a ciertos CUITs (cierra el acceso cruzado).
- **Anti fuerza bruta** en el login, **anti-SSRF** en los webhooks, comparaciones en tiempo constante, imagen sin root, auditoría de peticiones (usuario + IP).
- En producción: `ARCANUM_ENV=prod`, secretos propios y detrás de HTTPS.

---

## Versionado y CI

Cada `git push` dispara **GitHub Actions**, que **buildea y publica la imagen multi-arch** (amd64 + arm64) en GHCR — sin tokens manuales. En cada deploy se sube el *patch* de la versión, que se ve en el menú **Acerca de**, para confirmar de un vistazo que el deploy tomó.

Cada versión dice qué cambia, desde una sola fuente: la sección `## [X.Y.Z]` del `CHANGELOG.md` (sin ella el build no sale). Esas notas aparecen en:

- **Los registros del contenedor** (EasyPanel, pestaña Resumen): lo primero que escribe al levantar es un cartel `ARCANUM vX.Y.Z (fecha)` con lo que cambia, cortado a 80 columnas. El historial de *Implementaciones* de EasyPanel no admite texto propio (siempre dice "Deploy service").
- **La interfaz**: al entrar después de una actualización avisa "Arcanum se actualizó a la vX.Y.Z" con todo lo que cambió desde la última versión que viste en ese navegador. El historial queda en el menú, **Novedades**.
- **GitHub**: la imagen se etiqueta también `:X.Y.Z` (además de `:latest`), se crea el Release `vX.Y.Z` con las notas y el resumen de la corrida de Actions las muestra. Si se publica dos veces la misma versión, el CI avisa que no se subió el patch.

## Estado y roadmap

Operativo y verificado **end-to-end contra ARCA producción** (firma WSAA, consulta de padrón con datos reales, monitoreo de servicios). Roadmap: promover WSFEX/MTXCA/agro a módulos ricos, lotes y CAEA, federación con Lockatus (SSO de la suite). Ver [CHANGELOG.md](CHANGELOG.md).

## Tests
```bash
npm install && npm test
```

## Licencia
[MIT](LICENSE): podés usarlo, modificarlo, redistribuirlo y venderlo, también como parte de un producto o servicio propio, siempre que mantengas el aviso de copyright y la licencia. Arcanum no está afiliado ni respaldado por ARCA/AFIP.

Hasta la versión 2.1.0 Arcanum se publicó con licencia Apache-2.0. `src/services/apoc.js` incluye un aporte de un tercero hecho bajo esa licencia; el detalle está al final de [LICENSE](LICENSE).
