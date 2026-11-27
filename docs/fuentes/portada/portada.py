"""Genera la portada del README y la imagen para compartir el repositorio.

  docs/media/portada.png   1280x640 a doble densidad (2560x1280), para el README.
  docs/media/social.jpg    1280x640, liviana: la social preview de GitHub (Settings > Social preview).

Uso:  python portada.py      (requiere playwright con Chromium y Pillow; usa docs/media/capturas/panel.png)
"""
import pathlib

from PIL import Image
from playwright.sync_api import sync_playwright

AQUI = pathlib.Path(__file__).resolve().parent
SALIDA = AQUI.parents[1] / 'media' / 'portada.png'
SOCIAL = AQUI.parents[1] / 'media' / 'social.jpg'

with sync_playwright() as p:
    nav = p.chromium.launch()
    pag = nav.new_page(viewport={'width': 1280, 'height': 640}, device_scale_factor=2)
    pag.goto((AQUI / 'portada.html').as_uri())
    pag.wait_for_load_state('networkidle')
    pag.evaluate('document.fonts.ready')
    pag.screenshot(path=str(SALIDA))
    nav.close()
Image.open(SALIDA).convert('RGB').resize((1280, 640), Image.LANCZOS).save(SOCIAL, quality=90, optimize=True)
print(SALIDA)
print(SOCIAL)
