# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.0.0/).
Versionado semantico.

## [2.1.7] - 2026-11-26

### Corregido
- **Facturas B y C recibidas que daban "NO CONSTA" sin serlo.** Al constatar, Arcanum mandaba
  siempre tu CUIT como receptor, pero muchos comercios hacen la factura a tu DNI o como consumidor
  final, y WSCDC exige el mismo documento con el que se emitio. Ahora, si ARCA rechaza con el CUIT,
  se reintenta con el DNI (solo CUIT de persona humana) y como consumidor final; si alguna da OK,
  queda OK y se indica con cual. Los "NO CONSTA" ya guardados vuelven a quedar pendientes una sola
  vez, para re-constatarlos con este criterio.

### Agregado
- **Detener la constatacion de recibidos** (boton **Detener** y
  `POST /api/mis-comprobantes/:cuit/constatar/detener`). Corta entre un comprobante y el siguiente:
  lo constatado queda guardado y **Constatar recibidos** sigue desde lo pendiente.
- En la tabla, el motivo de ARCA se ve debajo de cada "NO CONSTA" (y al pasar el mouse).

## [2.1.6] - 2026-11-26

### Seguridad
- **El rol "lector" de Lockatus entraba a Arcanum como operador** y podía emitir. Arcanum
  buscaba "lectura" o "read" dentro del claim; "lector" no coincidía y caía en el rol por
  defecto, que era operador. Ahora el rol se toma por palabra exacta:
  - superadmin y admin quedan como están;
  - operador o editor pasan a operador;
  - lectura o lector pasan a lectura.

  Un valor desconocido queda en **lectura** (lo mínimo), y ya no basta con que el claim
  "contenga" admin. `ARCANUM_OIDC_DEFAULT_ROLE` sigue sirviendo para elegir otro rol por defecto.
  Lockatus 0.1.7 declara para Arcanum los roles superadmin, admin, operador y lectura: desde
  ahí se da superadmin, el rol que crea usuarios y cambia topes, receta y conexión con Fisherboy.

### Agregado
- **Tabla de topes de Monotributo** ("Ver y cargar topes" en la tarjeta de Monotributo): las
  11 categorías con su vigencia y su fuente.
  - **Descargar plantilla** baja un CSV con los topes cargados, listo para editar en Excel.
  - **Importar CSV** la vuelve a cargar y acepta formato argentino, puntos de miles y "$".
  - Antes de guardar se revisa que estén las 11 categorías y que cada tope sea mayor que el
    anterior.
  - Cambiarlos sigue siendo de superadmin; el resto los ve y descarga la plantilla.
  - API: `GET /api/monotributo/categorias/plantilla.csv`. El `PUT` acepta `{ csv, vigencia, fuente }`.

## [2.1.5] - 2026-11-26

### Corregido
- **DESPLIEGUE.md, Factorum:** decía que un `403` al constatar era por usar una clave de rol
  `lectura`. Desde la 2.1.0 esa clave alcanza: un `403` es un CUIT que no está entre los
  permitidos de la clave.

## [2.1.4] - 2026-11-26

### Corregido
- **"Constatar recibidos" parecía no hacer nada.** Constataba todos los recibidos pendientes
  contra ARCA en un solo pedido, de a uno y con pausa, y guardaba recién al final. Con cientos de
  recibidos eran minutos con la pantalla en "Constatando…", y si el proxy cortaba el pedido no se
  veía ningún resultado. Ahora corre en segundo plano en el servidor:
  - guarda cada resultado apenas lo tiene, así que si se corta, lo hecho queda;
  - la pantalla muestra una barra de progreso ("Constatando con ARCA: 14 de 33"), el comprobante
    que está consultando y los OK, los que no constan, los errores y los emisores apócrifos a
    medida que salen, y refresca el listado mientras avanza;
  - el botón queda trabado mientras corre y, al volver a la pantalla, retoma el progreso.
- Constata **solo los recibidos que pasan los filtros** que estás mirando (período, proveedor,
  tipo, búsqueda), no todos los del CUIT. Los que dan error de ARCA no se guardan y se
  reintentan la próxima vez.
- API: `POST /api/mis-comprobantes/:cuit/constatar` ahora devuelve 202 y arranca el trabajo
  (`{ filtros }` opcional). `GET` en la misma ruta devuelve el progreso. Hay un solo trabajo
  por CUIT a la vez (409 si ya hay uno corriendo).

## [2.1.3] - 2026-11-25

### Cambiado
- **El header tiene más aire:** 18 px arriba y abajo y más margen a los costados (en celular,
  14 px). El panel lateral y la esquina curva siguen pegados justo debajo, también al hacer scroll.

## [2.1.2] - 2026-11-25

### Agregado
- **Análisis de Mis Comprobantes**, con su propio ícono en la barra lateral (aparece cuando hay
  comprobantes bajados). Para el período elegido muestra:
  - indicadores: facturado (con las notas de crédito restadas y la variación contra el período
    anterior), notas de crédito, comprado, IVA crédito y débito, y resultado bruto;
  - un gráfico por mes de lo facturado contra lo comprado;
  - los principales clientes y proveedores, con cuánto pesa el primero;
  - los totales por tipo de comprobante y del período;
  - los subtotales por mes y contraparte, que se abren y se cierran.

  Todo filtra con un clic: un mes, un cliente o proveedor, un tipo o un indicador. Cada filtro
  queda como un chip para sacarlo, y el listado de abajo y el CSV siguen los mismos filtros.
  También se filtra por período (12 meses, este mes, este año, año anterior o a medida), por
  clase (facturas, notas de crédito, notas de débito) y por texto (nombre o CUIT). La moneda
  extranjera se pasa a pesos al tipo de cambio del comprobante.
- API: `GET /api/mis-comprobantes/:cuit/analisis`. El listado y el CSV aceptan `clase`, `cbte`,
  `contraparte` y `q`, siempre como parámetros de SQL.

## [2.1.1] - 2026-11-25

> Requiere **Fisherboy 1.12.0** o superior (paso de receta `fetch`). Actualizá Fisherboy antes.

### Cambiado
- **Mis Comprobantes pide los datos directo a ARCA.** El robot ya no maneja el calendario, el
  boton Buscar, la tabla ni el boton de exportar CSV, que era donde se trababa. Despues del login
  entra a la seccion (Emitidos o Recibidos) y pide los comprobantes con la misma llamada que hace
  la pagina al apretar Buscar (`generarConsulta` y `listaResultados`), que devuelve todo en JSON
  en menos de un segundo. Es como trabajan los demas robots de Mis Comprobantes. Verificado
  sobre ARCA real: 140 emitidos y 199 recibidos de un año. La receta paso de 9 pasos frágiles a 2.
- Arcanum lee ese JSON por posicion, con las columnas que define la propia pagina de ARCA
  (49 en Emitidos, 52 en Recibidos). Si ARCA cambia el formato o devuelve un error, la corrida
  falla con el motivo, nunca con un cero silencioso. El CSV y el ZIP se siguen leyendo.

### Agregado
- **Pantalla del robot al fallar.** Cuando una corrida falla, Arcanum guarda la ultima foto del
  navegador de Fisherboy antes de cerrar la sesion, y en Sincronizaciones aparece **Ver
  pantalla**. La imagen queda aparte del detalle de la corrida, respeta los permisos por CUIT y
  se borra a los 30 dias.

### Licencia
- **Arcanum pasa a licencia MIT** (antes Apache-2.0): cualquiera puede usarlo, modificarlo y
  comercializarlo manteniendo el aviso de copyright. El aporte de un tercero en
  `src/services/apoc.js`, hecho bajo Apache-2.0, conserva su aviso al final de LICENSE.

### Corregido
- Mientras la corrida espera a una persona (captcha u OK), el control de "sin avance" ya no puede
  cortarla aunque el servidor tarde en responder.
## [2.1.0] - 2026-11-25

### Nuevo
- **Facturas recibidas con Factorum.** Arcanum se conecta con Factorum, el lector de facturas
  de la suite (QR, texto, OCR e IA opcional), igual que con Fisherboy: `FACTORUM_URL` y
  `FACTORUM_TOKEN`, o desde el menu **Factorum (facturas recibidas)** (superadmin), con el token
  cifrado y que nunca vuelve por la API.
- **Pestana Facturas recibidas** (aparece cuando Factorum responde): **verificar una factura**
  con su veredicto en color (valida, invalida, apocrifa, con errores o no verificable), los
  datos clave y los hallazgos, sin guardarla; **subir lotes** (varios archivos o un ZIP) con el
  cliente, IA y constatar; avance de cada lote; tabla de comprobantes con filtros y totales;
  panel de **revision** para corregir campos y aprobar, con el archivo original a un clic; y
  descarga en **Excel** y **CSV**.
- **API** `/api/factorum/...`: `salud`, `config`, `verificar`, `lotes`, `comprobantes` (ver,
  corregir y aprobar, archivo original), `resumen` y `export.xlsx` / `export.csv`. Leer lo
  puede cualquier rol; verificar, subir y corregir, operador o mas. Respeta el **scope por
  CUIT**: cada usuario o clave ve solo sus clientes, y verificar usa su unico CUIT como
  consultante si no se indica otro.
- **MCP**: `facturas_recibidas`, `factura_recibida`, `resumen_facturas_recibidas` y
  `verificar_factura` (18 en total, todas de solo lectura; verificar no guarda nada). Sin
  Factorum configurado devuelven un error claro.
- `docker-compose.factorum.yml` para levantar Factorum (con su Postgres y Ollama opcional, perfil
  `ia`) junto a Arcanum. En DESPLIEGUE.md, como darle a Factorum su clave de Arcanum: rol
  `lectura` acotado a los CUITs que constatan.
- `POST /api/constatacion` (constatar una lista, sin guardar nada) ahora se permite al rol
  `lectura`, como la vista previa: solo consulta WSCDC y apocrifos. Respeta los CUITs permitidos
  de la clave. Constatar los recibidos de Mis Comprobantes, que guarda el resultado, sigue
  exigiendo operador.

## [2.0.9] - 2026-11-25

### Corregido
- **Mis Comprobantes se abre por el buscador del portal de ARCA.** La receta tocaba el primer
  link que dijera "Mis Comprobantes", y el carrusel de Novedades del portal puede tener un
  video con ese nombre que abre YouTube (Fisherboy lo bloquea y la corrida fallaba en el paso
  8). Ahora escribe "Mis Comprobantes" en el buscador y toca ese resultado, que esta siempre,
  aunque el servicio no figure en "Mas utilizados". Verificado sobre el portal real.
- En la credencial de ARCA, el campo de la clave fiscal quedaba mas abajo que el del CUIT:
  la aclaracion "dejala vacia para no cambiarla" paso al texto de ayuda del campo.

## [2.0.8] - 2026-11-25

### Cambiado
- **Mis Comprobantes corre como RPA puro, sin IA generativa.** La receta tiene todos sus
  pasos verificados sobre la pagina real de ARCA, asi que la IA de respaldo de Fisherboy queda
  apagada: si un paso falla, la corrida termina enseguida con un error claro, no se manda la
  pagina de ARCA a ningun modelo y no hay costo por intento. Se puede volver a habilitar con
  `ARCANUM_MC_IA=1`.

## [2.0.7] - 2026-11-25

### Corregido
- **Mis Comprobantes no encontraba el boton para exportar.** La receta buscaba la clase
  `.buttons-csv`, que el boton de ARCA no tiene; ahora lo busca por su titulo
  ("Exportar como CSV"), verificado sobre la pagina real.
- **La descarga reintenta una vez.** ARCA arma el ZIP en su servidor y el primer pedido puede
  responder 503; la receta hace un intento, espera 5 segundos y vuelve a pedirlo. Si salen
  los dos archivos, el guardado no duplica comprobantes.
- Cuando la receta termina sin descargar nada, la corrida ahora guarda el registro de
  Fisherboy para poder ver que paso.

## [2.0.6] - 2026-11-25

### Corregido
- **Mis Comprobantes buscaba solo el dia de ayer.** El campo de fecha de ARCA es un calendario
  que lee lo escrito recien cuando detecta una tecla; la receta cambiaba el texto sin teclas y
  ARCA buscaba con su fecha por defecto (ayer). Ahora la receta toca una tecla despues de
  cargar el rango y la busqueda sale con el periodo pedido.

## [2.0.5] - 2026-11-25

### Cambiado
- **Mis Comprobantes sincroniza de forma incremental.** La primera vez baja los ultimos 12
  meses (o desde la fecha que elijas, para traer mas historia) y lo guarda en la base. Las
  siguientes, manuales o la diaria, arrancan en lo ultimo que se bajo de cada tipo, con 30
  dias de solape (`ARCANUM_MC_SOLAPE_DIAS`) para tomar lo que ARCA muestra tarde; lo repetido
  no se duplica. Si un dia la diaria falla, la siguiente retoma desde donde quedo.
- La tarjeta **Sincronizar** propone ese rango y dice hasta que fecha esta bajado cada tipo.

## [2.0.4] - 2026-11-25

### Corregido
- **Mis Comprobantes ya no se queda esperando un OK que nadie ve.** Fisherboy frena antes de
  tocar un boton que podria no deshacerse (todo boton de envio, como "Buscar") y pide un OK.
  Arcanum no conocia ese estado: la corrida parecia "Operando ARCA" sin avanzar hasta
  cortarse. Ahora los botones que solo consultan (Buscar, Consultar, Filtrar) se aprueban
  solos, y para cualquier otro la vista en vivo muestra "Pide tu OK" con el boton en
  cuestion y las opciones **Si, dale** / **No**, avisa por webhook y no corta la corrida
  mientras espera.
- **El paso que abre Mis Comprobantes no toma mas el link al video de YouTube** que el
  portal de ARCA tiene con el mismo nombre (Fisherboy lo bloqueaba y habia que recurrir a
  la IA).

## [2.0.3] - 2026-11-25

### Agregado
- **Se ve en que va la sincronizacion de Mis Comprobantes.** Mientras corre, la vista en vivo
  y la tabla de sincronizaciones dicen el paso de la receta (por ejemplo "Emitidos · Paso 13
  de 16: Cargar el rango de fechas"), si ese paso fallo y la IA lo esta reintentando, y hace
  cuanto fue el ultimo avance. Asi se distingue una corrida lenta de una trabada.
- **Una corrida trabada se corta sola.** Si el registro de Fisherboy no avanza en 5 minutos
  (`ARCANUM_MC_SIN_AVANCE_MIN`) y no hay una persona al mando, la sesion se cierra y el error
  dice en que paso quedo y por que fallo, en vez de esperar los 25 minutos del tope.

## [2.0.2] - 2026-11-25

### Cambiado
- **La casilla de sincronizacion diaria dice a que hora corre** (por ejemplo "todos los dias
  a las 6:00"), tomando la hora real del servidor (`ARCANUM_MC_HORA`, hora argentina). Si el
  servidor tiene la sincronizacion automatica apagada, la pantalla lo avisa.

### Corregido
- **Un valor invalido en `ARCANUM_MC_HORA` ya no apaga la corrida diaria.** Antes, algo como
  `ARCANUM_MC_HORA=abc` o `24` hacia que la sincronizacion de Mis Comprobantes no corriera
  nunca; ahora se usa la hora por defecto (6:00).

## [2.0.1] - 2026-11-25

### Corregido
- **El menu de la derecha (los tres puntitos) se salia de la pantalla** y aparecia una barra de
  scroll horizontal. Ahora se abre hacia la izquierda, alineado con el boton.
- **Mis Comprobantes solo aparece si Fisherboy esta configurado.** Sin la URL y el token de
  Fisherboy, la seccion no se muestra en el panel lateral (no podia bajar nada). Aparece sola
  cuando se cargan `FISHERBOY_URL` y `FISHERBOY_TOKEN`, o cuando un superadmin guarda la
  conexion desde el menu **Fisherboy y Mis Comprobantes**.

## [2.0.0] - 2026-11-25

### Cambiado
- **Nueva interfaz.** Arcanum 2.0 cierra el rediseño que empezo en la 0.10.10: menu de
  secciones al costado y una pantalla mas limpia, con el acabado final que sigue.
- **Header y panel lateral forman una sola superficie.** Se sacaron la linea de abajo del
  header y la linea derecha del panel de secciones: los dos comparten el mismo fondo y el
  contenido queda como un panel encastrado, con la esquina de arriba a la izquierda curva.
  La esquina se mantiene en su lugar al hacer scroll y acompana al panel cuando se achica a
  iconos. En el celular, donde el panel se abre encima, no hace falta y no aparece.
- **Botones de rayitas y de menu (los tres puntitos) planos.** Ya no van dentro de un
  recuadro: son iconos sueltos que se sombrean suavemente al pasar el mouse y muestran el
  anillo de foco al navegar con el teclado.

## [0.10.11] - 2026-11-25

### Corregido
- El contenido de cada seccion ya no queda pegado a la barra de arriba: tiene su margen
  superior (en el celular, un poco menor).

## [0.10.10] - 2026-11-25

### Cambiado
- **Menu de secciones al costado.** Las 11 secciones dejan la barra de arriba y pasan a un
  panel lateral agrupado (Facturar, ARCA, Administracion), cada una con su icono. El boton
  de rayitas, arriba a la izquierda, lo achica a una barra de solo iconos (el nombre aparece
  al pasar el mouse) y lo vuelve a extender; Arcanum recuerda como lo dejaste. En el celular
  el panel se abre encima del contenido y se cierra al elegir una seccion. La barra de
  arriba queda con el logo, la seccion actual y el menu de la derecha.

### Corregido
- Despues de actualizar Arcanum, el navegador podia seguir usando la hoja de estilos vieja
  hasta 24 horas. Ahora la direccion del CSS lleva la version, asi cada version nueva se
  baja sola.

## [0.10.9] - 2026-11-24

### Corregido
- **El grafico "Emisiones (14 dias)" del Panel muestra los 14 dias.** Antes solo llegaban
  los dias con emisiones, asi que con un unico dia la barra ocupaba todo el ancho y se veia
  como una franja de color. Ahora hay una barra por dia (los dias sin emisiones quedan en
  cero sobre la linea de base), con las fechas de inicio y fin y el maximo por dia.

## [0.10.8] - 2026-11-24

### Seguridad
- **Dependencias sin vulnerabilidades conocidas** (`npm audit` en cero):
  - `node-forge` 1.4.0 -> 1.4.3: firma del login con ARCA (WSAA) y certificados. Corrige,
    entre otros, falsificacion de firmas RSA y saltos en la validacion de certificados.
  - `nodemailer` 6 -> 10.1.7: avisos por email. Corrige inyeccion de cabeceras y comandos
    SMTP, envio a dominios no previstos y denegaciones de servicio. Sin cambios en la
    configuracion: sigue usando las mismas variables `ARCANUM_SMTP_*`.
  - `fast-xml-parser` 4 -> 5.12.0: lectura de las respuestas de ARCA. Mismo resultado que la
    version anterior sobre las respuestas de ARCA (verificado); corrige un consumo de CPU
    cuadratico con XML mal formado.
  - Herramientas de desarrollo (`brace-expansion`, `js-yaml`, via eslint): fuera de la imagen.
- Las dependencias quedan fijadas a una version exacta, con al menos dos semanas de
  publicada, para que un build no tome sola una version recien salida.

## [0.10.7] - 2026-11-24

### Corregido
- **Facturar en produccion ya conecta con ARCA.** El servidor de wsfev1
  (`servicios1.afip.gov.ar`) negocia una clave Diffie-Hellman de 1024 bits que Node 24
  rechaza por defecto (`ERR_SSL_DH_KEY_TOO_SMALL`), asi que la vista previa y la emision
  fallaban con "fetch failed". Ahora solo las conexiones a ARCA (`*.afip.gov.ar`,
  `*.afip.gob.ar`, `*.arca.gob.ar`) aceptan esa clave (`SECLEVEL=1`, con TLS 1.2 como
  minimo y certificado verificado). Webhooks, login con Lockatus y cualquier otro destino
  siguen con la seguridad por defecto. Si pusiste `NODE_OPTIONS=--tls-cipher-list=...`
  en el servicio como parche, sacala: ya no hace falta y relajaba todas las conexiones.
- Un fallo de conexion con ARCA dice la causa real (por ejemplo `ECONNREFUSED` o
  `ERR_SSL_DH_KEY_TOO_SMALL`) en lugar de solo "fetch failed".

## [0.10.6] - 2026-11-20

### Seguridad
- **Ninguna credencial generada va al log.** Sin `ARCANUM_ADMIN_PASS`, la contrasena del
  primer superadmin queda en `/data/admin-clave-inicial`; sin `ARCANUM_API_KEY`, la clave de
  API generada queda en `/data/api-key-generada`. Los dos archivos son legibles solo por la
  app y el log dice como leerlos desde la consola del servicio. Antes se imprimian en los
  registros, que ve cualquiera con acceso al panel.
- La clave de API generada ahora **sobrevive a los reinicios** (antes cambiaba en cada uno).
- Si la contrasena generada no se puede guardar, el superadmin no se crea (nadie podria
  entrar): el log pide definir `ARCANUM_ADMIN_PASS` y reiniciar.

## [0.10.5] - 2026-11-20

### Cambiado
- **La version se ve apenas levanta**: lo primero que escribe el contenedor en los registros de
  EasyPanel (Resumen) es un cartel con la version, la fecha y que cambia, cortado al ancho para
  leerlo sin scroll lateral. Antes salia al final del arranque, en renglones que se cortaban.

## [0.10.4] - 2026-11-20

### Cambiado
- **Node 24 LTS**: la imagen pasa de `node:22-slim` a `node:24-slim` (24.22.3, fijada por digest).
  Requisito minimo `node >= 22` (Node 20 ya no tiene soporte).
- CI: acciones de GitHub actualizadas a sus versiones que corren sobre Node 24 (checkout v7,
  setup-node v7, login v4, metadata v6, setup-buildx v4, build-push v7); se va el aviso de Node 20.

## [0.10.3] - 2026-11-20

### Nuevo
- **Cada deploy dice que version es y que cambia**: al arrancar, el log del contenedor (lo que se
  ve en EasyPanel) muestra la version y sus novedades; la UI avisa "Arcanum se actualizo a la
  vX.Y.Z" con lo que cambio desde la ultima version que viste, y el menu tiene **Novedades**
  (tambien en Acerca de). `GET /api/novedades?desde=X.Y.Z`.
- El CI etiqueta la imagen con la version (`ghcr.io/.../arcanum:X.Y.Z`, ademas de `:latest`),
  crea el Release vX.Y.Z en GitHub con las notas del CHANGELOG y las muestra en el resumen de la
  corrida. Sin la seccion de la version en el CHANGELOG el build no sale.
## [0.10.2] - 2026-11-20

### Corregido
- Por API vale lo mismo que en la UI: WSMTXCA tambien completa nombre y domicilio del receptor
  con CUIT desde el padron al emitir (WSFEv1 ya lo hacia), y el PDF (`GET /api/comprobantes/.../pdf`,
  una sola ruta para UI y API) completa emisor y receptor.
- OpenAPI documenta `receptorNombre`, `receptorDomicilio`, `condicionIvaReceptor`, `condicionVenta`,
  `items`, `pdf` y `contingencia` en la emision.

## [0.10.1] - 2026-11-20

### Corregido
- **PDF con datos del encabezado vacios**: razon social, domicilio y condicion frente al IVA del
  emisor se completan desde el padron de ARCA (boton **Traer de ARCA** en Datos fiscales, y al
  generar el PDF si faltan), sin pisar lo cargado a mano. Nombre y domicilio del receptor con CUIT
  se toman del padron al emitir y al generar el PDF de un comprobante ya emitido (con tope de
  espera: nunca frena la emision). Ingresos Brutos e inicio de actividades (que ARCA no expone por
  web service) se cargan en Datos fiscales; la vista previa avisa lo que falta.
- **Factura C con "Responsable Inscripto"**: sin condicion cargada, el emisor de una C sale como
  "Responsable Monotributo".
- Domicilio largo del receptor ya no se sale del recuadro en el modelo ARCA.
- Contingencia sin `idempotencyKey` del cliente: el primer intento y la cola usan la misma clave
  (podia salir un segundo CAE para la misma venta tras un corte; lo encontro el E2E).

### Nuevo
- Emitir (UI): campos de nombre y domicilio del receptor (la vista previa los llena del padron).
- MCP: `receptorDomicilio` en la emision. `GET /api/tenants/:cuit/emisor` devuelve `faltan`;
  `POST /api/tenants/:cuit/emisor/completar`.

## [0.10.0] - 2026-11-20

### Nuevo
- **Cola de emision (contingencia)**: con `contingencia: true` (o el tilde en Emitir), si ARCA
  no responde el comprobante queda en cola (202) y sale solo cuando vuelve. Antes de reintentar
  se consulta en ARCA el numero que se habia intentado: si el CAE ya se otorgo, se **adopta**
  (nunca dos CAE para la misma venta). La fecha nunca se cambia sola: si ARCA ya no la acepta
  (5 dias productos, 10 servicios) queda "necesita tu decision". Pestana **Contingencia**,
  `GET /api/cola`, reintentar, cancelar, MCP `cola_emision`.
- **CAEA opcional por CUIT** (apagado por defecto): pide el CAEA de cada quincena, lo usa solo si
  ARCA sigue sin responder pasados N minutos (y nunca tras un intento ambiguo con CAE), en el
  punto de venta CAEA (validado en ARCA), informa lo emitido y los "sin movimiento", y avisa a 2
  dias de la fecha tope. QR del PDF con `tipoCodAut` A.
- **Traer lo emitido por fuera de Arcanum** (`POST /api/wsfev1/sincronizar` y diario): recorre
  desde el ultimo numero de ARCA hacia atras, trae lo que falta (huecos incluidos) y avisa si un
  comprobante no coincide.
- **Backups cifrados diarios** (AES-256-GCM, clave derivada de la master key o
  `ARCANUM_BACKUP_KEY`), retencion de 14, descarga para superadmin, restauracion con simulacro
  (`src/tools/restaurar-backup.js`) y aviso hasta confirmar que la master key esta guardada
  fuera del servidor.
- Eventos `comprobante_encolado`, `cola_requiere_humano`, `caea_obtenido`,
  `caea_informe_pendiente`, `caea_informe_error`, `emitidos_por_fuera`, `backup_creado`,
  `backup_fallo`.
- Stub local de ARCA (`scripts/arca-stub.js`) para pruebas de punta a punta, con modos caido y
  lento (`ARCANUM_ENDPOINT_WSAA` / `ARCANUM_ENDPOINT_WSFEV1`, solo homologacion).

## [0.9.5] - 2026-11-20

### Corregido
- PDF modelo ARCA: el CAE ya no toca el borde de la hoja y el texto bajo el isologo se lee.

## [0.9.4] - 2026-11-20

### Nuevo
- **PDF igual al de ARCA** ("Comprobantes en linea"), ahora el modelo por defecto: ORIGINAL,
  DUPLICADO y TRIPLICADO, mismos recuadros, rotulos, tabla (con alicuota y subtotal con IVA en
  la A), totales e importes sin separador de miles. El diseno anterior sigue como modelo
  "arcanum".
- **Nombre del archivo**: por defecto el de ARCA (`CUIT_TIPO_PV_NUMERO.pdf`), o una plantilla
  con `{receptor}`, `{numero}`, `{pv}`, `{letra}`, `{tipo}`, `{fecha}`, `{cuit}` y `{total}`.
- Se eligen al facturar (`pdf: { modelo, nombreArchivo }` en el cuerpo, o en Emitir) y quedan
  guardados con el comprobante. La descarga acepta `?modelo=`, `?nombre=` y `?copias=1..3`.

## [0.9.3] - 2026-11-20

### Corregido
- PDF: la linea del encabezado ya no tacha el "COD. xx" debajo de la letra, y los totales
  siguen a la tabla de items en vez de quedar fijos abajo (sin hueco con pocas lineas).

## [0.9.2] - 2026-11-20

### Corregido
- **WSMTXCA (Factura con detalle)**: la condicion de IVA del receptor iba como
  `condicionIVAReceptorId` y al final del comprobante; en el WSDL es `condicionIVAReceptor` y va
  despues del documento del receptor. Faltaba `cancelaEnMismaMonedaExtranjera` en moneda
  extranjera (RG 5616).
- **WSFEX (Exportacion)**: faltaba `CanMisMonExt` (RG 5616), obligatorio porque la moneda de una
  factura E siempre es extranjera. Por defecto `S`; `pagaEnMonedaExtranjera: false` lo pasa a `N`.
- Los dos pedidos se validan ahora contra sus WSDL reales (`test/fixtures/`), como WSFEv1.

## [0.9.1] - 2026-11-20

### Corregido
- **Emitir con WSFEv1 fallaba en ARCA** con `NullReferenceException` en `FECAESolicitar`: el
  pedido usaba tres nombres de elemento que no existen en el WSDL (`FeCAECabRequest` en vez de
  `FeCabReq`, `FECAEDetRequest/FECAEDetalle` en vez de `FeDetReq/FECAEDetRequest` y `CbteFecha`
  en vez de `CbteFch`). ARCA ignora lo que no conoce y le llegaba la cabecera vacia. Afectaba a
  Emitir, a la API y a los lotes. Ahora un test valida el pedido, nombre por nombre y en orden,
  contra el WSDL real de ARCA guardado en `test/fixtures/wsfev1.wsdl`.

## [0.9.0] - 2026-11-19

### Nuevo
- **Mis Comprobantes** (emitidos y recibidos) bajados de la pagina de ARCA con la sesion de
  agente de **Fisherboy 1.9.0**: receta editable, IA de respaldo opcional que nunca ve la clave,
  pausa ante captcha y **navegador en vivo** en la UI con tomar el control y devolverlo.
  Guardado sin duplicados, export CSV y sincronizacion diaria (`ARCANUM_MC_HORA`).
- **Clave fiscal** por CUIT cifrada con la master key, que no vuelve por la API ni queda en logs.
  Si ARCA la rechaza, la credencial se **bloquea** y no se reintenta hasta recargarla (evita que
  una clave mala bloquee la clave fiscal en ARCA).
- **Topes de Monotributo** con todo lo facturado (Mis Comprobantes + Arcanum, sin duplicar, NC
  restan), semaforo 80/100, categoria sugerida, topes editables con vigencia, aviso
  `tope_monotributo` y recordatorio de recategorizacion.
- **Constatacion masiva** de recibidos (WSCDC + apocrifos), por lista, CSV o boton.
- **MCP**: `mis_comprobantes`, `topes_monotributo` y `constatacion_recibidos` (13 en total, todas
  de solo lectura).
- Eventos `mis_comprobantes_sincronizado`, `mis_comprobantes_fallo` y `tope_monotributo`.
- `docker-compose.fisherboy.yml` para levantar Fisherboy junto a Arcanum.

## [0.8.0] - 2026-11-18

### Nuevo
- **5 herramientas MCP mas, todas de solo lectura**: `riesgo_fiscal` (semaforo padron A5 +
  apocrifos con comprobante sugerido), `comprobantes_recientes`, `comunicaciones_ventanilla`
  (solo el listado: no las marca como leidas), `vencimiento_certificado` y
  `vista_previa_comprobante`. Total 10.
- **Vista previa de emision** (`POST /api/wsfev1/comprobantes/vista-previa` y boton en Emitir):
  valida importes, IVA, tipo, receptor con su padron, condicion de IVA, fecha y RG 5866,
  sugiere la letra y muestra el numero que le tocaria, sin emitir ni reservar numero.
- **Claves de API**: vencimiento opcional, rotacion con dias de gracia, limite de pedidos por
  minuto (429 con Retry-After) y panel de uso por clave (pedidos, errores, rechazos, CUITs,
  operaciones, ultimos pedidos).
- **Alertas de uso anomalo** por clave (barrido de CUITs o muchos rechazos) con el evento
  `clave_anomala`.
- **Avisos proactivos**: eventos `comunicacion_nueva` (e-Ventanilla, revision cada hora con
  linea de base), `clave_por_vencer` y `clave_anomala`; boton "Probar" en Webhooks.
- **Cache del padron** de una hora (`ARCANUM_PADRON_CACHE_S`), con `?fresco=1` para forzar.
- **Prueba de emision en homologacion**: `src/tools/prueba-homologacion.js` saca un CAE de
  prueba y verifica numeracion, CAE en ARCA e idempotencia. Pasos en DESPLIEGUE.md.

### Corregido
- La pantalla Emitir no mandaba `condicionIvaReceptor` (obligatoria por RG 5616) ni clave de
  idempotencia: ahora manda las dos, y un doble clic ya no puede sacar dos CAE.
- `riesgo_fiscal` y `/api/contribuyente` sugieren la letra con la condicion del emisor de ESE
  CUIT (antes, solo la global por variable de entorno).

### Tests
- `test/mejoras.test.js` (20 tests): cache, limite, anomalias, vista previa, estado de claves,
  excepcion de solo lectura. Total 67.

## [0.7.0] - 2026-11-18

### Nuevo
- **Servidor MCP de solo consulta** en `POST /mcp` (JSON-RPC 2.0, Streamable HTTP, sin estado)
  para asistentes como SecretarIA. Herramientas: `padron`, `comprobante`, `ultimo_comprobante`,
  `puntos_de_venta` y `estado_arca`, todas marcadas `readOnlyHint`. No expone la emision ni el
  motor generico. Corte por llamada a los 80 s (`ARCANUM_MCP_TIMEOUT_MS`) con error claro,
  respuestas recortadas por debajo de 20.000 caracteres y siempre como datos JSON.
- **Claves de API con rol** (`lectura`, `operador`, `admin`), CUITs permitidos opcionales y baja
  individual. Se guardan como hash SHA-256 y se muestran una sola vez. Panel en
  Usuarios > Claves de API y endpoints `/api/claves`.
- La clave (maestra o de la tabla) se acepta tambien como `Authorization: Bearer <clave>`.
- Encabezado `Idempotency-Key` en las emisiones de WSFEv1, WSFEX y WSMTXCA.

### Seguridad
- **Regla de solo lectura que falla cerrada**: el rol `lectura` (usuario o clave) solo puede
  hacer GET/HEAD en toda la API, incluidas las rutas futuras.
- `/api/ws/{servicio}/{op}` exigia solo autenticacion: un usuario `lectura` podia invocar
  `FECAESolicitar`. Ahora requiere rol operador o superior.
- Faltaba el chequeo de CUIT permitido en `GET /api/wsfev1/parametros`, `/ultimo-autorizado`,
  `/consultar` y en `/api/wsaa`; `DELETE /api/wsaa` ahora pide rol operador.
- `/mcp` solo acepta clave (nunca la cookie del panel) y rechaza Origin ajeno: sin CSRF.
- El registro de peticiones nunca guarda encabezados, claves ni cuerpos.

### Confiabilidad
- La verificacion de idempotencia se repite dentro del lock de emision: dos reintentos
  simultaneos con la misma clave ya no pueden sacar dos CAE.

### Tests
- `test/mcp.test.js` (20 tests): protocolo MCP, catalogo de herramientas, parsers, claves y
  regla de solo lectura. Total 47.

## [0.6.3] - 2026-07-14

### Confiabilidad (cierre de los 2 hallazgos bajos de la auditoria)
- **Numeracion sin carrera**: la emision (WSFEv1, WSFEX, WSMTXCA) se serializa por punto de
  venta con un `pg_advisory_xact_lock` (nuevo helper `db.withLock`), igual que el token WSAA.
  Evita que dos requests concurrentes lean el mismo "ultimo autorizado" y colisionen el numero.
- **TOCTOU en el facturador**: `emitirItem` ahora reclama el item de forma atomica
  (`UPDATE ... WHERE estado IN ('pendiente','solicitado') RETURNING`, estado transitorio
  'emitiendo'); si la emision falla, el item vuelve a 'pendiente' para reintentar. Verificado.

## [0.6.2] - 2026-07-14

### Tests
- Cobertura para los modulos nuevos (test/nuevos.test.js, 17 tests): reglas-comprobante
  (sugerencia de letra A/B/C), importar.parseQr (decodifica QR de ARCA / rechaza basura),
  engine.toXml (serializacion + rechazo de claves invalidas / inyeccion XML), y helpers de
  lotes (n/pInt anti-NaN, alicuotaId por tasa, aging verde/amarillo/rojo, parseCsv, normItem).
  Total 27 tests (antes 10).

## [0.6.1] - 2026-07-14

### Seguridad (auditoria + remediacion)
- **IDOR multi-tenant en /api/lotes (CRITICO/ALTO)**: el bloque del facturador no aplicaba
  `assertCuitAllowed`, permitiendo a un usuario scoped por `cuit_allow` leer/emitir/exportar
  lotes de OTRO CUIT (incl. sacar CAE real bajo certificado ajeno). Ahora toda ruta `/api/lotes`
  resuelve el CUIT dueno y valida contra el principal; el listado exige `?cuit` para usuarios
  scoped. Verificado (403 cross-tenant, 200 propio).
- **Cert ajeno (MEDIO)**: `/api/apoc`, `/api/padron`, `/api/contribuyente` firmaban el TRA con
  el certificado de la representada sin `assertCuitAllowed`. Agregado.
- **Import bajo CUIT arbitrario (MEDIO)**: la importacion por QR persistia bajo el CUIT emisor
  del QR; ahora persiste bajo el CUIT consultante (autorizado), con el emisor en `raw.cuitEmisor`.
- **Inyeccion XML por claves (BAJO)**: `engine.toXml` valida cada clave como NCName.
- **Robustez**: `pInt`/`n` rechazan NaN (evita 500 al cargar lote y facturas $0 silenciosas);
  la alicuota IVA del facturador se infiere de la tasa (no hardcodeada a 21%); wsmtxca deriva
  `importeIva`/`alicuotasIva` de los subtotales para el PDF.
- Informe completo (13 hallazgos) en AUDIT-arcanum-2026-07-14.md (no versionado).

## [0.6.0] - 2026-07-14

### Agregado
- **Facturador masivo** (nueva seccion "Facturador"): lotes de facturacion con
  seguimiento y **semaforo de antiguedad** (verde <5d, amarillo 5-15d, rojo >15d).
  - Cargar lote por CSV o `items[]` (una fila por profesional/cliente).
  - Maquina de estados por item: pendiente -> solicitado -> emitido | recibido | rechazado.
  - **Emitir el CAE** de un item o de todo el lote (usa WSFEv1, numero auto, idempotente).
  - **Marcar recibido** (el profesional emitio y te mando su comprobante).
  - **Solicitar por email** al profesional (SMTP).
  - Export CSV con dias pendientes y semaforo. Perfiles pyme / asociacion.
  - `GET/POST /api/lotes`, `GET /api/lotes/:id`, `/emitir`, `/items/:id/(emitir|recibido|solicitar)`, `/export.csv`.
  - Verificado end-to-end (crear, aging, recibido, export, emision hasta el nivel de cert).

### Comparado con ArcanumPro
- Su facturador trackea; el nuestro ademas **emite el CAE real** integrado (WSFEv1),
  resuelve el numero solo, es idempotente y computa el aging en el server.

## [0.5.0] - 2026-07-08

### Agregado (inspirado en ArcanumPro, mejorado)
- **Multi-emisor por CUIT**: los datos fiscales del emisor (razon social, domicilio,
  condicion IVA, IIBB, inicio act., flag MiPyME) se guardan **en la DB por cada CUIT**
  y se editan desde la UI (Clientes -> Datos fiscales), en vez de un JSON estatico que
  obligue a redeployar. El PDF usa el encabezado del CUIT correcto. Fallback al emisor
  global por env. `GET/PUT /api/tenants/:cuit/emisor`.
- **Importar comprobante por QR** (`POST /api/comprobantes/importar`): decodifica el QR
  de ARCA, valida whitelist de emisores (`ARCANUM_EMISORES_PERMITIDOS`), dedup por CAE
  y **CONSTATA contra ARCA con WSCDC** (mejora sobre el dedup local: confirma que el
  comprobante es autentico). Se persiste con `origen='importado'`. UI en Comprobantes.

### Comparado con ArcanumPro
- Ellos: multi-emisor via emisores.json estatico (redeploy) + import por QR con dedup local.
- Nosotros: multi-emisor editable en DB + import con constatacion real en ARCA.

## [0.4.2] - 2026-07-08

### Corregido
- El **motor SOAP generico** ahora soporta SOAP 1.2: el passthrough
  `/api/ws/wsapoc/GetPublicacionAPOC` usa `<Credencial>` (namespace tempuri) en SOAP 1.2,
  igual que el modulo rico. Antes quedaba con el formato viejo (codigo 201). Verificado
  contra prod (codigo 0). SOAP 1.1 del resto de los servicios sin cambios (regresion OK).

## [0.4.1] - 2026-07-08

### Corregido
- **WSAPOC**: el request estaba mal formado (`<credencial>` en minuscula/sin namespace,
  SOAP 1.1), por lo que ARCA devolvia siempre codigo 201 "Object reference". Ahora usa
  `<tem:Credencial>` (namespace tempuri) en SOAP 1.2 y devuelve codigo 0 con los datos
  reales; parseo tolerante a namespaces. Verificado contra prod (201 -> 0).
  Gracias a francomeretta1-spec (PR #1). Se quitaron los console.log de diagnostico.

## [0.4.0] - 2026-07-04

### Agregado
- **WSFEXv1 (Factura E de exportacion)** promovido a modulo rico: `GET /api/wsfex/status`,
  `/ultimo-autorizado`, `/ultimo-id`, `/consultar`, y `POST /api/wsfex/comprobantes`
  (cliente del exterior, pais destino, moneda/cotizacion, incoterms, permisos, items[]).
  Persiste el comprobante (tipo 19) y lo integra al PDF/consulta. FEXDummy verificado
  contra prod OK.
- **WSMTXCA (factura con detalle)** promovido a modulo rico: `GET /api/wsmtxca/status`,
  `/ultimo-autorizado`, `/alicuotas`, `/consultar`, y `POST /api/wsmtxca/comprobantes`
  con **IVA por item** (arrayItems + arraySubtotalesIVA) y CondicionIVAReceptorId.
  dummy verificado contra prod OK; el envelope JAX-WS llega y ARCA responde el negocio.
- Presets de ambos en el Generador y rutas en OpenAPI.

### Nota
- La emision de WSFEX/WSMTXCA requiere asociar el certificado a esos servicios en el
  Administrador de Relaciones (boton "Como activar"). El plumbing (WSAA + envelope +
  parseo) esta verificado; la emision fiscal no se probo para no generar comprobantes reales.

## [0.3.17] - 2026-07-04

### Cambiado
- Gris de reposo de los campos a #eef0f3 (sutil pero visible sobre las tarjetas
  blancas). Verificado: input/select computan #eef0f3 (antes el bug los dejaba blancos).

## [0.3.16] - 2026-07-04

### Corregido
- El fondo gris de reposo no se aplicaba a los input/select: una regla base posterior
  (`input,select,textarea{background:var(--panel)}`) lo pisaba con blanco (y ademas
  mataba la flecha del select por usar el shorthand `background`). Se cambio a
  `background-color:var(--field-rest)`.
- El gris de reposo ahora es el tono del fondo (`var(--bg)`), mas suave; al enfocar
  sigue pasando al celeste. Se restauro la flecha de los `<select>`.

## [0.3.15] - 2026-07-04

### Cambiado
- El gris de reposo de los campos se hizo mas visible (#e4e6ea en claro,
  rgba blanco .08 en oscuro); antes era casi imperceptible sobre la tarjeta.

## [0.3.14] - 2026-07-04

### Cambiado
- Campos de formulario: por defecto en gris muy claro (`--field-rest`, con variante
  para modo oscuro) para diferenciarlos del fondo; al enfocarlos pasan al celeste
  (`--field-bg`) con el borde azul suave.

## [0.3.13] - 2026-07-04

### Cambiado
- Webhooks: los eventos ahora vienen **destildados** por defecto (el usuario elige
  cuales suscribir). Se valida que haya al menos uno seleccionado al crear.

## [0.3.12] - 2026-07-04

### Cambiado
- Webhooks: el multi-select nativo de Eventos (que se veia "todo pintado" porque las
  opciones venian todas seleccionadas) se reemplazo por una lista de checkboxes,
  consistente entre navegadores y sobre el fondo celeste.

## [0.3.11] - 2026-07-04

### Corregido
- Multi-select de Eventos (Webhooks): las opciones se veian blancas sobre el campo
  celeste. Ahora son transparentes (muestran el celeste) con las seleccionadas en azul.

## [0.3.10] - 2026-07-04

### Cambiado
- Todos los campos para completar (input, textarea, select) ahora tienen fondo
  celeste claro (`--field-bg`) con borde azul suave, para diferenciarlos del resto.
  Adaptado a modo claro y oscuro.

## [0.3.9] - 2026-07-04

### Corregido
- El `index.html` (que lleva todo el JS/CSS inline) ahora se sirve con
  `Cache-Control: no-cache, must-revalidate`, para que el navegador nunca quede con
  un bundle viejo cacheado tras un update (causaba UI rara/lenta hasta un hard-refresh).

### Performance (0.3.8)
- Feedback instantaneo al cambiar de vista: `go()` limpia y muestra "Cargando..." al
  instante en vez de dejar el contenido anterior hasta que responde el fetch.

## [0.3.7] - 2026-07-04

### Corregido
- **Contraste en hover:** el design system pintaba de azul el fondo de cualquier
  boton en hover pero no cambiaba el texto, dejando gris/oscuro sobre azul (visible
  en la barra de navegacion). Ahora el nav en hover va azul + texto blanco, y los
  botones secundarios usan un hover claro y legible.
- **Performance:** se quito el `backdrop-filter: blur(8px)` del header sticky, que
  forzaba repintado en cada scroll y hacia sentir la interfaz lenta/pesada.

## [0.3.6] - 2026-07-04

### Corregido
- Login: el toggle de mostrar/ocultar contrasena usaba clases sin estilo
  (`.pass-wrap`/`.pass-toggle`), por lo que el icono se veia como un circulo negro
  y se desacomodaba al clickear. Ahora usa `.pwwrap`/`.eye` (icono line, posicion
  fija dentro del campo), como el resto de los campos de clave de la app.

## [0.3.5] - 2026-07-04

### Corregido / Agregado
- **Moneda extranjera** en WSFEv1, ahora correcta de punta a punta:
  - `CanMisMonExt` (RG 5616) se envia cuando la moneda no es PES ('S'=paga en la
    misma moneda, 'N'=paga en pesos; via `canMisMonExt` o `pagaEnMonedaExtranjera`).
  - Validacion: `cotizacion` obligatoria y > 0 si la moneda no es PES.
  - QR: la moneda y la cotizacion se toman del comprobante real (antes `ctz` estaba
    fijo en 1 y la moneda no se leia; ambos bugs corregidos).
  - PDF: importes en la moneda emitida (DOL, etc.), con linea de cotizacion,
    equivalente en pesos y leyenda "Pagadero en la moneda de emision" (si CanMisMonExt=S).
  - Se persisten `cotizacion` y `canMisMonExt`.

## [0.3.4] - 2026-07-04

### Cambiado
- Isologo ARCA oficial (paths vectoriales reales) embebido en el PDF, en negro,
  reemplazando el wordmark tipografico. `public/arca-logo.svg` actualizado al vector real.

## [0.3.3] - 2026-07-04

### Agregado
- Isologo institucional de ARCA como asset vectorial (`public/arca-logo.svg`).
- PDF: el pie usa el wordmark ARCA en el gris institucional (#4d4d4d) con el tagline
  "Agencia de Recaudacion y Control Aduanero" en dos lineas, como el logo oficial.

## [0.3.2] - 2026-07-04

### Agregado
- PDF: **detalle de items linea por linea** (Codigo / Producto-Servicio / Cantidad /
  U. Medida / P. Unitario / % Bonif / Subtotal). Se pasan en `items` al emitir y se
  persisten; si no hay, se muestra una linea resumen.
- PDF: **caja "Regimen de Transparencia Fiscal al Consumidor (Ley 27.743)"** con IVA
  Contenido + Otros Impuestos Nacionales Indirectos, solo en Factura B a consumidor final.
- PDF: leyenda **"*147 Telefono gratuito - Defensa del Consumidor"**, **"Pag. 1/1"** y
  **wordmark ARCA** ("Agencia de Recaudacion y Control Aduanero" + "Comprobante Autorizado")
  en reemplazo del recuadro negro.

## [0.3.1] - 2026-07-04

### Cambiado
- PDF: los importes se muestran con `$` (no "PES"), con el simbolo separado del
  numero y alineado como en el layout oficial de ARCA. "ORIGINAL" centrado arriba
  y caja de letra reposicionada para calcar la representacion impresa vigente.

## [0.3.0] - 2026-07-04

### Agregado
- **Representacion impresa legal del comprobante (PDF renovado)**: datos del emisor
  (razon social, condicion IVA, domicilio, CUIT, IIBB, inicio de actividades),
  receptor con su **condicion frente al IVA**, discriminacion de IVA por alicuota
  (A/M) o total (B/C), periodo facturado (servicios), condicion de venta, leyendas
  ("A CONSUMIDOR FINAL" RG 5866, Ley 27.743), CAE + vencimiento, QR de ARCA y
  **codigo de barras Interleaved 2 of 5** (RG 1415). Datos del emisor por env
  (`ARCANUM_EMISOR_*`).
- **CondicionIVAReceptorId en WSFEv1** (RG 5616, obligatoria desde 2025): se envia
  en la emision y se persiste para el PDF. Parametro `condicionIvaReceptor`.
- **Regla RG 5866/2026**: en ventas a consumidor final por total >= $10.000.000 se
  exige identificar al comprador (DNI/CUIL/CDI); si falta, se rechaza con 422.
  Umbral configurable (`ARCANUM_UMBRAL_CF_ID`).
- **Sugerencia de comprobante** (`reglas-comprobante.js`): dada la condicion del
  emisor + la del receptor sugiere letra A/B/C y si discrimina IVA. Integrada en
  `/api/contribuyente` (campo `comprobanteSugerido`).

### Nota
- Inspirado en el fork open-source ArcanumPro (derivado de Arcanum, Apache-2.0):
  se reimplementaron el layout legal y el helper de reglas, adaptados a nuestra
  arquitectura (config por env, persistencia del desglose, integracion al semaforo).

## [0.2.5] - 2026-06-24

### Agregado
- **Vista consolidada del contribuyente** con semaforo de riesgo fiscal:
  `GET /api/contribuyente/:cuit?cuit=<representada>` combina Padron A5 + WSAPOC en
  una sola respuesta. Devuelve `semaforo` (VERDE/AMARILLO/ROJO), `fiscal`
  (tipoContribuyente, condicionIVA, tipoComprobante, estadoClave, domicilio) y `apoc`.
  Las dos consultas en paralelo; APOC es best-effort (si falla, no aborta el analisis).
  Preset en el Generador y ruta en OpenAPI. Verificado contra ARCA produccion.

## [0.2.4] - 2026-06-24

### Agregado
- **WSAPOC (base de apocrifos)**: nuevo servicio del catalogo + modulo rico.
  `GET /api/apoc/:cuit?cuit=<representada>` devuelve `{ esApocrifo, fechaCondicion, fechaPublicacion, codigo }`.
  Endpoint .NET (`eapoc-ws.afip.gob.ar`), namespace `tempuri.org`, credencial envuelta (`<credencial>`).
  Verificado contra ARCA produccion. Reusa el cache de TA (no pide token nuevo por consulta → anti-baneo).
- Nuevo `authStyle: 'apoc'` en el motor generico (sobre `<credencial>` con `CUITDelegado`).
- Preset de APOC en el Generador de codigo.

## [0.2.0] - 2026-06-24

### Agregado
- **e-Ventanilla** (modulo rico SOAP 1.2 + MTOM): listar/leer comunicaciones y descargar PDF adjuntos.
- **Switch de entorno homo/prod desde la UI** (admin), en caliente y persistido.
- **Importar par clave+certificado** existente desde la UI/API.
- **Verificar asociacion** del certificado por servicio (boton en la UI + `/api/services/:id/verificar`).
- **Emision por lote** (JSON o CSV): `POST /api/wsfev1/lote`.
- **Notificaciones por email** (SMTP) ademas de webhooks.
- **OIDC**: verificacion de la firma del id_token contra el JWKS.
- Menu hamburguesa (Acerca de + tema + entorno), ojitos en contrasenas, generador con presets de e-Ventanilla/padron A5.
- OpenAPI completo, ESLint, SECURITY.md, CONTRIBUTING.md, imagen base pinneada por digest, mas tests.

### Cambiado
- Token WSAA: sin renovacion proactiva (evita el rechazo "ya posee un TA valido" y el baneo); renovacion lazy + fallback al TA cacheado.
- Quitados padron A4/A10 (endpoints no verificados) con poda automatica.
- Timeout SOAP a 15s para errores rapidos.

## [0.1.0] - 2026-06-24

### Agregado

- Autenticacion WSAA con firma CMS/PKCS#7 **100% local** (node-forge). La clave
  privada nunca sale del contenedor ni pasa por terceros.
- Cache de Ticket de Acceso (Token + Sign) por CUIT + servicio, con lock para
  evitar logins concurrentes y respeto del `expirationTime` real.
- Multi-tenant por archivos: `data/certs/<CUIT>.crt` + `<CUIT>.key`.
- WSFEv1 (Factura Electronica nacional):
  - `POST /api/wsfev1/comprobantes` — emitir y obtener CAE (auto-numeracion).
  - `GET /api/wsfev1/ultimo-autorizado` — ultimo numero autorizado.
  - `GET /api/wsfev1/parametros/{nombre}` — catalogos (tipos, alicuotas, etc).
  - `GET /api/wsfev1/status` — FEDummy.
- Padron / Constancia: `GET /api/padron/{a13|a5}/{cuit}`.
- Diagnostico WSAA: `GET`/`DELETE /api/wsaa/{cuit}/{service}`.
- Auth por `X-API-Key` (se autogenera si no se define).
- OpenAPI 3.0 + pagina `/docs` (Redoc) para integrar con n8n.
- Docker + docker-compose, imagen sin root con healthcheck.

- Postgres con esquema completo, claves privadas cifradas (AES-256-GCM).
- Catalogo de 16 servicios editable en vivo por superadmin (motor generico +
  modulos ricos). Namespaces/endpoints verificados contra los WSDL reales.
- Ciclo de vida del certificado (genera CSR, carga el .crt con validacion).
- Auto-recuperacion de token + daemon (monitor, renovacion, alertas de vencimiento).
- Log de peticiones, idempotencia (anti doble-CAE), validacion previa de importes.
- NC/ND con comprobantes asociados, consulta/reimpresion, PDF con QR de ARCA,
  export CSV, webhooks firmados HMAC, metricas + endpoint Prometheus.
- Panel web completo (login con roles + API key + OIDC/Lockatus opcional).

### Verificado

- Motor generico contra ARCA homologacion real: wsfev1, wsfexv1, wsbfev1, wscdc
  y wsmtxca devuelven OK por sus dummy. Resto de servicios Java con namespace y
  auth correctos (su dummy requiere auth, asi que no se monitorean).

### Pendiente (roadmap)

- Verificacion del camino con firma usando un certificado de homologacion real.
- Promover WSFEX/MTXCA/agro de generico a modulos "ricos" con validaciones finas.
- Lotes (varios comprobantes por request) y CAEA.
