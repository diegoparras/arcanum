# Pase entre apps de la suite Escriba (v1)

Contrato entre Arcanum (Node) y Factorum (Go) para entrar de una a la otra sin volver a loguearse,
siempre que estén conectadas. Si las dos están federadas con Lockatus, el paso ya es directo por el SSO;
el pase es para cuando no lo están (y no se rompe si lo están).

## Términos

- **Origen (O)**: la app donde está la persona y toca «Abrir <otra app>».
- **Receptora (R)**: la app a la que quiere entrar.
- **Credencial de conexión**: la clave de API que O ya tiene guardada para hablarle a R.
  - Arcanum → Factorum: `FACTORUM_URL` + `FACTORUM_TOKEN` (o lo cargado en el menú Factorum de Arcanum). Es una clave de Factorum.
  - Factorum → Arcanum: la URL de Arcanum + una clave de Arcanum (`ark_...`) que Factorum ya usa para constatar.
- Cada app tiene una **URL pública** configurada (la que ve el navegador; no la interna tipo `http://factorum:8095`).

## 1. R: `POST /api/suite/pase`

- Autenticación: la clave de API de R, en `X-API-Key` o `Authorization: Bearer <clave>`.
- La clave tiene que estar **habilitada para la suite** por un admin de R (un flag en la clave: «puede abrir sesiones de la suite», con un **rol tope**). Sin el flag: `403 {"ok":false,"error":"Esta clave no está habilitada para abrir sesiones de la suite"}`.
- Cuerpo JSON:
  ```json
  { "app": "arcanum", "email": "diego@ejemplo.com", "nombre": "Diego", "rol": "operador", "cuits": ["20222222223"] }
  ```
  - `app`: `arcanum` | `factorum` (quién pide).
  - `rol`: el rol de la persona en O, con los nombres de O.
  - `cuits`: CUITs permitidos en O; `null` o ausente = todos.
- R decide el rol y los CUITs **en R**:
  1. Traduce el rol (tabla abajo).
  2. Si la persona **ya existe** en R (por email, sin distinguir mayúsculas): usa el rol y los CUITs **de R** (no se escala por venir de la otra app). Si está desactivada: `403`.
  3. Si **no existe**: la crea (origen = `app`) con el rol traducido y los CUITs recibidos, salvo que R tenga apagada la creación automática (`403`).
  4. En los dos casos el rol queda **topeado** por el rol tope de la clave, y los CUITs se **intersecan** con los de la clave si la clave tiene CUITs.
  5. Si con eso no queda ningún rol válido: `403`.
- Si R no tiene URL pública configurada: `409 {"ok":false,"error":"Falta la URL pública de <R>"}`.
- Respuesta `200`:
  ```json
  { "ok": true, "url": "https://<publica de R>/suite/entrar?pase=<token>", "vence": "2026-11-27T12:00:60Z" }
  ```
  - `token`: 32 bytes aleatorios en base64url. En la base se guarda solo el SHA-256. Un solo uso. Vence a los **60 s**.
- Queda en la auditoría de R: quién (email), desde qué app, con qué clave (prefijo), rol resultante.

## 2. R: `GET /suite/entrar?pase=<token>`

- Valida el pase (existe, no vencido, no usado), lo marca usado en la misma transacción, abre la sesión (cookie HttpOnly, Secure si es https, SameSite=Lax) y redirige a `/`.
- Pase inválido o vencido: redirige al login con el mensaje «El pase para entrar venció o ya se usó. Volvé a tocar el botón en la otra app.»
- Nunca se loguea el token.

## 3. O: botón «Abrir <R>»

- `GET /api/suite/apps` (sesión, cualquier rol): `{ ok, apps: [ { app: "factorum", nombre: "Factorum", disponible: true } ] }`. Solo lista las conectadas; `disponible` = la otra respondió a su healthz en los últimos 60 s (cachear).
- `POST /api/suite/abrir/<app>` (sesión, cualquier rol): O llama a `POST <url interna de R>/api/suite/pase` con su credencial de conexión y la identidad de la persona (email, nombre, rol, cuits). Devuelve `{ ok, url }` y el navegador hace `location.href = url`. Errores de R se devuelven con su mensaje.
- En la UI: un selector de la suite en la barra de arriba (ícono de grilla) con las apps conectadas. Si no hay ninguna conectada, no se muestra.
- Queda en la auditoría de O.

## Tabla de roles

| Arcanum   | Factorum   |
|-----------|------------|
| superadmin| superadmin |
| admin     | admin      |
| operador  | usuario    |
| lectura   | lectura    |

Rol tope por defecto de una clave habilitada para la suite: en Factorum `usuario`; en Arcanum `operador`. Llegar como superadmin exige que un superadmin de R lo haya puesto como tope a propósito.

## Seguridad

- El token del pase nunca va a un log ni a la auditoría (solo su existencia).
- La credencial de conexión nunca sale al navegador.
- `POST /api/suite/pase` solo acepta claves de API (no sesiones de navegador).
- El destino del redirect es siempre `/` de R (no se acepta una URL de vuelta arbitraria).
