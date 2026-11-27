# Fuentes de la documentación

Todo lo visual del repositorio (capturas, portada, guías en PDF y video) se genera con los scripts de esta carpeta. Nada se edita a mano: si cambia el panel, se vuelve a correr la cadena y el material queda al día.

## Requisitos

- Docker (para la instancia de demostración). En Windows, Docker dentro de WSL.
- Python 3.11 o superior con:

```bash
pip install playwright pillow numpy scipy pypdf imageio-ffmpeg
python -m playwright install chromium
```

`imageio-ffmpeg` trae su propio ffmpeg: no hace falta instalarlo aparte.

## La cadena, en orden

| Paso | Comando | Produce |
|---|---|---|
| 1. Demo con datos ficticios | `bash docs/fuentes/demo/arc-demo.sh up` | Arcanum en `http://localhost:18971` |
| 2. Capturas | `python docs/fuentes/capturas/capturas.py` | `docs/media/capturas/*.png` |
| 3. Portada | `python docs/fuentes/portada/portada.py` | `docs/media/portada.png` y `docs/media/social.jpg` |
| 4. Guías | `python docs/fuentes/guias/guias.py` | `docs/guias/arcanum-guia-instalacion.pdf` y `docs/guias/arcanum-guia-uso.pdf` |
| 5. Video | `python docs/fuentes/video/video.py` | `docs/media/arcanum.mp4` (con música) |
| 6. Adelanto y versión web | ver abajo | `docs/media/adelanto.gif` y el video del README |
| 7. Apagar la demo | `bash docs/fuentes/demo/arc-demo.sh down` | |

Los pasos 3 a 6 usan las capturas del paso 2; el 4 toma la versión de `package.json` (o la que se le pase como argumento).

### La demo es inofensiva por diseño

`demo/arc-demo.sh` construye la imagen con el código del repositorio y la corre en una red propia, **sin salida a internet** (`--dns 127.0.0.1`) y con `ARCANUM_DAEMONS=0`: no habla con ARCA ni con nadie. `demo/demo.js` carga datos inventados: CUITs de dígitos repetidos, nombres de fantasía y certificados autofirmados que ARCA nunca aceptaría. Usuario `admin`, contraseña `Demo-Arcanum-2026`, solo para esa instancia descartable.

Nunca corras `capturas.py` contra una instalación real: las capturas se publican.

### Video y música

- `video/video.html` dibuja cada escena en función del tiempo (`window.render(t)`), así cada cuadro es determinista y se puede previsualizar abriendo el HTML en el navegador.
- `video/musica.py` sintetiza la banda sonora desde cero, sin samples ni licencias de terceros: electrónica a 124 BPM con una güira en los drops. `python musica.py salida.wav` la genera sola.
- `video.py` junta las dos cosas: captura los cuadros con Chromium y los codifica con ffmpeg (H.264 + AAC).
- Para revisar escenas sin renderizar todo: `python video.py --cuadros 5.5,17.5` guarda esos segundos como PNG.

### Video en el README

GitHub solo reproduce dentro del README los videos subidos como adjunto, de hasta 10 MB. `python docs/fuentes/video/web.py` arma esa versión (720p, unos 9 MB, con el logo como portada). Se arrastra el archivo a un comentario de GitHub sin publicarlo, y el enlace `https://github.com/user-attachments/assets/...` que devuelve va solo en una línea del README.

### Adelanto animado

```bash
python docs/fuentes/video/adelanto.py
```

Toma un tramo del video y lo convierte en GIF con paleta optimizada.

### Guías en PDF

`guias/instalacion.html` y `guias/uso.html` son el contenido; `guias/guia.css` el diseño (A4, tapa, capítulos, avisos). `guias.py` imprime la tapa y el cuerpo por separado con Chromium (el cuerpo lleva encabezado y número de página) y los une con pypdf.
