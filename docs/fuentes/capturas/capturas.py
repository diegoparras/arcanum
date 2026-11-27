"""Capturas del panel para el README, las guías y el video.

Corre contra un Arcanum de demostración con datos ficticios (ver demo/arc-demo.sh): nunca
contra una instalación real. Requisitos: playwright (con Chromium) y Pillow.

Uso:  python capturas.py [URL] [usuario] [contraseña]
"""
from __future__ import annotations

import io
import pathlib
import sys
import time

from PIL import Image
from playwright.sync_api import sync_playwright

AQUI = pathlib.Path(__file__).resolve().parent
SALIDA = AQUI.parents[1] / 'media' / 'capturas'
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:18971'
USUARIO = sys.argv[2] if len(sys.argv) > 2 else 'admin'
CLAVE = sys.argv[3] if len(sys.argv) > 3 else 'Demo-Arcanum-2026'
CUIT = '30777777773'
ANCHO_FINAL = 1600

# Textos de una demo sin internet (padrón y Fisherboy inalcanzables) que no aportan a la foto.
LIMPIAR = """
for (const el of document.querySelectorAll('#view *')) {
  if (el.children.length === 0 && /No se pudo (consultar|contactar|conectar)|getaddrinfo|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(el.textContent)) el.textContent = '';
}
"""

# nombre -> JS que deja la pantalla lista (se espera a que termine).
PANTALLAS = {
    'panel': "go('panel')",
    'clientes': "go('clientes')",
    'servicios': "go('servicios')",
    'emitir': "go('emitir')",
    'comprobantes': "go('comprobantes')",
    'facturador': "go('facturador'); await new Promise(r => setTimeout(r, 900)); verLote(1)",
    'contingencia': "go('contingencia')",
    'mis-comprobantes': f"MC.cuit='{CUIT}'; go('mis')",
    'constatacion': f"""MC.cuit='{CUIT}'; go('mis'); await new Promise(r => setTimeout(r, 1500));
        const s = document.querySelector('#mc_ftipo'); if (s) {{ s.value = 'recibido'; s.dispatchEvent(new Event('change')); }}
        await new Promise(r => setTimeout(r, 400));
        [...document.querySelectorAll('#view button')].find(b => b.textContent.trim() === 'Filtrar')?.click();
        await new Promise(r => setTimeout(r, 1200));
        document.querySelector('#mc_tabla')?.scrollIntoView({{ block: 'start' }}); window.scrollBy(0, -190)""",
    'analisis': f"MC.cuit='{CUIT}'; go('analisis')",
    'generador': "go('generador')",
    'webhooks': "go('webhooks')",
    'usuarios': "go('usuarios')",
}


def guardar(png: bytes, nombre: str) -> None:
    img = Image.open(io.BytesIO(png)).convert('RGB')
    if img.width > ANCHO_FINAL:
        img = img.resize((ANCHO_FINAL, round(img.height * ANCHO_FINAL / img.width)), Image.LANCZOS)
    img.save(SALIDA / f'{nombre}.png', optimize=True)
    print(f'  {nombre}.png  {img.width}x{img.height}')


def main() -> None:
    SALIDA.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        nav = p.chromium.launch()
        ctx = nav.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=2, locale='es-AR')
        ctx.add_init_script("try{localStorage.setItem('arcanum.versionVista','99.0.0');"
                            "if(!localStorage.arcanumTheme)localStorage.arcanumTheme='light'}catch(e){}")
        pag = ctx.new_page()
        pag.goto(URL)
        pag.wait_for_selector('#lp')
        time.sleep(0.6)
        guardar(pag.screenshot(), 'login')

        pag.fill('#lu', USUARIO)
        pag.fill('#lp', CLAVE)
        pag.evaluate('doLogin()')
        pag.wait_for_function("location.hash === '#panel'")
        time.sleep(1.5)
        for nombre, js in PANTALLAS.items():
            pag.evaluate(f'async () => {{ window.scrollTo(0, 0); {js}; }}')
            time.sleep(2.2)
            pag.evaluate(LIMPIAR)
            guardar(pag.screenshot(), nombre)

        # El panel en tema oscuro.
        pag.evaluate("localStorage.arcanumTheme='dark'; document.documentElement.setAttribute('data-theme','dark'); go('panel')")
        time.sleep(2)
        guardar(pag.screenshot(), 'panel-oscuro')
        nav.close()


if __name__ == '__main__':
    main()
