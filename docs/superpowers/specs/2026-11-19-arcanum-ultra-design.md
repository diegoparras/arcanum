# Arcanum ULTRA — Mis Comprobantes con el navegador de Fisherboy y el resto de las mejoras

Fecha: 2026-11-19. Estado: aprobado por el usuario en la conversación.

## Intención

El usuario (contador, dueño de la suite Escriba) quiere que Arcanum cubra lo que ARCA no
expone por Web Service: **Mis Comprobantes** (emitidos y recibidos). Ya existen desarrollos
que lo automatizan operando la página; quiere lo mismo, pero dentro de la suite y con una IA
que opere la página. Además pidió implementar todas las mejoras propuestas antes
("Arcanum ULTRA").

Decisiones del usuario:

- Arcanum **no** trae navegador propio: usa el de **Fisherboy**, conectando los dos sistemas.
- La IA es **configurable** (proveedor compatible con OpenAI: Ollama local, OpenRouter, etc.),
  apagada por defecto. La descarga diaria anda sin IA.
- La clave fiscal la carga el usuario en Arcanum (cifrada), y la cambia cuando quiera.

## Objetivos

1. Bajar Mis Comprobantes emitidos y recibidos por CUIT, solo, todos los días, sin duplicar.
2. Que se pueda **mirar en vivo** al navegador operando, y **tomar el control** (captcha, 2FA,
   pantallas raras) y devolverlo.
3. Que cuando ARCA cambie la página, se arregle sin redeploy: receta editable + IA de respaldo.
4. Aprovechar los datos: topes de Monotributo con todo lo facturado, constatación masiva de
   recibidos (WSCDC + APOC), herramientas MCP para SecretarIA.
5. El resto de las mejoras (fase 2 y 3, abajo).

## No objetivos

- No saltear captchas ni bot-detection. Si aparece, se pausa y resuelve el humano.
- No usar servicios de terceros para el login ni para resolver captchas.
- No emitir comprobantes desde el navegador: emitir sigue siendo por WSFEv1.

## Anti-objetivos (sería un fracaso aunque funcione)

- Que la clave fiscal aparezca en un log, en el sobre de un job, en una respuesta de API o en
  lo que ve el modelo de IA.
- Que el modelo de IA pueda llevar el navegador fuera de los dominios de ARCA, o que texto de
  la página le dé órdenes (prompt injection).
- Que una corrida fallida deje datos a medias sin decirlo.

## Restricciones

- Arcanum: Node 22 nativo, Postgres, sin frameworks. Fisherboy: Python/FastAPI, Playwright,
  Redis. Repos separados; cada uno con su versión (Fisherboy 1.8.0, Arcanum 0.9.0).
- Reglas de la suite: sin emojis, ojito en contraseñas, menú hamburguesa, bump de patch por deploy.
- No hay clave fiscal disponible para desarrollo: se prueba contra una **maqueta local** de las
  páginas de ARCA. La primera corrida real la dispara el usuario mirándola en vivo.

## Enfoques considerados

| Enfoque | Qué cambia | Por qué no / sí |
|---|---|---|
| Navegador propio en Arcanum (Playwright en Node) | +300 MB en la imagen de Arcanum, duplica lo de Fisherboy | Descartado por el usuario: ya existe en Fisherboy |
| Arcanum manda jobs declarativos a Fisherboy (`POST /api/jobs` con `actions`) | Sin vista en vivo ni toma de control; no sigue pestañas nuevas; no baja archivos | Insuficiente: Mis Comprobantes se abre en otra pestaña y exporta CSV |
| **Sesión de agente en Fisherboy** (nuevo), Arcanum la orquesta y hace de proxy de la vista | Fisherboy gana un "navegador con agente" reutilizable por toda la suite | **Elegido**. Reusa la vista en vivo de `browser_login`, el LLM y la pseudonimización que ya tiene |

## Diseño — Fase 1

### Fisherboy 1.8.0: sesión de agente (`app/net/browser_agent.py`)

Una sesión viva de Chromium (como `browser_login`) que corre una **receta** y, si hace falta,
un **agente de IA**, con vista en vivo y toma de control humana.

- **Receta**: lista de pasos con los verbos de `actions.py` más verbos nuevos:
  `wait_url` (la URL contiene), `switch_tab` (pasar a la pestaña nueva / popup), `download`
  (click que dispara una descarga y la guarda), `capture` (empezar a guardar respuestas JSON
  cuyo URL matchee un patrón), `human_if` (si aparece un selector -captcha- pausar y pedir
  humano), `goal` (sub-objetivo en lenguaje natural para la IA).
  Variables `{{var:nombre}}` y secretos `{{secret:nombre}}` se sustituyen **dentro** de
  Fisherboy al ejecutar; el log guarda el placeholder, nunca el valor.
- **Agente IA** (si `LLM_*` está configurado y la sesión lo permite): observa la página como
  **lista de elementos interactivos** numerados (rol, texto, id, placeholder; los password se
  muestran vacíos), con CUIT/emails/etc. reemplazados por marcadores `«CUIT_1»` (detectores de
  `privacy/detectors.py`; el mapeo vive solo en la sesión y se restaura al ejecutar). Responde
  JSON con UNA acción de una lista cerrada (`click`, `type`, `select`, `press`, `goto`, `wait`,
  `done`, `human`). Tope de pasos. El prompt de sistema declara que el texto de la página es
  dato y no instrucción. `goto` y cualquier navegación quedan limitados a una **allowlist de
  dominios** de la sesión (para ARCA: `afip.gob.ar`, `arca.gob.ar`) además del SSRF guard.
- **Cuándo entra la IA**: en un paso `goal`, o cuando un paso de la receta falla y la sesión
  tiene `ia: true` (la IA intenta cumplir el objetivo del paso; si lo logra, se sigue con la
  receta).
- **Humano**: estados `corriendo | esperando_humano | humano | terminado | error | cerrado`.
  El humano puede pedir el control en cualquier momento (`/takeover`) y devolverlo
  (`/resume`). Frames JPEG con el mismo protocolo `desde/seq` que `browser_login`.
- **Resultado**: log de pasos (sin secretos), archivos descargados (en memoria con tope de
  tamaño, se bajan por `GET .../files/{n}`), respuestas JSON capturadas, URL final.
- **API** (requiere rol con `capture`; el API token de servicio sirve):
  `POST /api/agent/start`, `GET /api/agent/{t}`, `GET /api/agent/{t}/frame`,
  `POST /api/agent/{t}/event`, `POST /api/agent/{t}/takeover`, `POST /api/agent/{t}/resume`,
  `GET /api/agent/{t}/files/{n}`, `DELETE /api/agent/{t}`.
  Topes: 2 sesiones concurrentes, TTL 20 min, 60 pasos de receta, 30 pasos de IA.

### Arcanum 0.9.0: Mis Comprobantes

- **Conexión con Fisherboy** (`services/fisherboy.js`): `FISHERBOY_URL` + `FISHERBOY_TOKEN`
  (env, o settings editables por superadmin; el token nunca vuelve en la API). Cliente HTTP con
  timeouts, y proxy de frame/event/takeover/resume para que la UI de Arcanum muestre el
  navegador sin entrar a Fisherboy.
- **Credenciales** (`mc_credenciales`): por CUIT representado: `cuit_login` (puede ser el del
  contador), clave fiscal **cifrada con el vault**, sincronización diaria sí/no. La API solo
  dice si hay clave cargada y cuándo se cambió.
- **Receta** (`services/misComprobantes.receta.js` como semilla; editable en `settings`
  `mc_receta` por superadmin, con "restaurar"): login en `auth.afip.gob.ar`, portal, abrir
  Mis Comprobantes (pestaña nueva), elegir representado, Emitidos/Recibidos, rango de fechas,
  buscar, exportar CSV. Cada paso con `goal` de respaldo para la IA y `human_if` del captcha.
- **Corridas** (`mc_corridas`): cuit, tipo, rango, estado, token de Fisherboy, log, cantidad,
  error. Una corrida por CUIT a la vez. Rango máximo por corrida según ARCA (se parte en
  tramos si hace falta).
- **Comprobantes** (`mc_comprobantes`): clave única (cuit, tipo, cbte_tipo, pv, número,
  doc contraparte). Parser del CSV de Mis Comprobantes (separador `;` o `,`, decimales con
  coma, encabezados en castellano, tolerante a ZIP con CSV adentro). Upsert idempotente.
- **Daemon**: sincronización diaria (hora `ARCANUM_MC_HORA`, default 6) de los CUIT con
  sincronización activa: mes anterior y mes en curso, emitidos y recibidos. Webhooks
  `mis_comprobantes_sincronizado` y `mis_comprobantes_fallo` (incluye "necesita humano").
- **UI**: pestaña Mis Comprobantes: CUIT, clave fiscal (ojito), sincronización diaria,
  "Sincronizar ahora", vista en vivo con "Tomar el control" / "Devolver", tabla con filtros y
  export CSV, historial de corridas, editor de receta (superadmin).

### Lo que destraba (también fase 1)

- **Topes de Monotributo** (`services/monotributo.js`): tabla de categorías editable con
  vigencia (semilla con los últimos valores conocidos y aviso de verificar los vigentes);
  ingresos de los últimos 12 meses = Mis Comprobantes emitidos (facturas suman, NC restan) +
  comprobantes propios de Arcanum que no estén ya (dedupe por CAE). Categoría actual desde la
  constancia. Webhook `tope_monotributo` al 80% y al 100%, y aviso en enero/julio.
- **Constatación masiva** (`services/constatacion.js`): lista o CSV, o "los recibidos sin
  constatar" de un CUIT; WSCDC (reusa `importar.constatar`) + APOC del emisor; secuencial con
  pausa; resultado guardado en `mc_comprobantes.constatacion`.
- **MCP**: `mis_comprobantes` (consulta local), `topes_monotributo`, `constatacion_recibidos`
  (lee resultados guardados). Solo lectura, como el resto.

## Fase 2 — que nunca se corte la facturación

- Cola de emisión con contingencia (outbox con idempotencyKey, reintento al
  `arca_restablecido`), luego CAEA.
- Sincronización de emitidos con ARCA (FECompConsultar por rango) y detección de huecos.
- Backups cifrados programados (`pg_dump` cifrado con la master key) y aviso si nunca se
  respaldó la master key.

## Fase 3 — el resto

- Seguridad: verificación de firma del id_token de Lockatus (JWKS), segundo factor TOTP para
  usuarios de la UI (obligatorio para admin/superadmin), log de auditoría encadenado por hash.
- FCE MiPyME (wsfecred) como módulo rico, facturación recurrente con aprobación, envío
  automático del PDF al cliente, emisión con aprobación humana desde el MCP.

## Decisiones de criterio (tomadas al escribir, revisables)

- **Alcance del plan**: la fase 1 se planifica en detalle ahora; las fases 2 y 3 tienen su
  propio plan cuando termine la 1.
- **Cómo viaja la clave fiscal**: Arcanum la descifra solo para armar el
  `POST /api/agent/start`, por la red interna, en el campo `secrets`. Fisherboy la guarda solo
  en la memoria de esa sesión (nunca en Redis ni en el log), la borra al cerrar, y `secrets`
  no se devuelve nunca. En Arcanum no se registra el body de esa llamada.
- **Permisos en Arcanum**: superadmin y admin ven y operan cualquier CUIT; operador solo los
  CUIT de su `cuit_allow`; lectura (y las claves de API de lectura) solo consulta comprobantes
  ya bajados. Cargar o cambiar la clave fiscal: admin o superadmin. Ver la vista en vivo o
  tomar el control: quien pueda sincronizar ese CUIT. Todo queda en la auditoría `requests`.
- **Maqueta de ARCA** (`fisherboy/tests/fixtures/arca/` servida en localhost): login en dos
  pasos (CUIT, clave), captcha opcional activable, portal con link que abre pestaña nueva,
  selección de representado, Emitidos/Recibidos, rango de fechas, buscar, exportar CSV, y
  variante ZIP.
- **Versiones**: Fisherboy pasa de 1.7.1 a 1.8.0; Arcanum de 0.8.0 a 0.9.0 (minor por
  funcionalidad nueva; los deploys siguientes suben el patch).
- **Cruce con lo emitido por Arcanum**: por CAE (el CSV trae "Cód. Autorización"); si falta,
  por (tipo, punto de venta, número).
- **Migraciones**: en `src/db.js`, idempotentes, como las existentes.

## Lo que queda al criterio de quien construye

Selectores concretos de la receta (se ajustan en la primera corrida real), nombres internos,
pausas entre pasos, formato exacto de la lista de elementos para la IA.
