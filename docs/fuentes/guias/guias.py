"""Arma las guías en PDF: tapa a página completa + cuerpo con encabezado y número de página.

Requisitos: playwright (con Chromium) y pypdf.
Uso:  python guias.py [version]
"""
from __future__ import annotations

import io
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright
from pypdf import PdfReader, PdfWriter

AQUI = pathlib.Path(__file__).resolve().parent
SALIDA = AQUI.parents[1] / 'guias'
GUIAS = {'instalacion': 'Guía de instalación', 'uso': 'Guía de uso'}

ENCABEZADO = """<div style="width:100%;font-family:Inter,Arial,sans-serif;font-size:7.5pt;color:#8a93a8;
  padding:0 18mm;display:flex;justify-content:space-between"><span>Arcanum · {titulo}</span><span>v{version}</span></div>"""
PIE = """<div style="width:100%;font-family:Inter,Arial,sans-serif;font-size:7.5pt;color:#8a93a8;
  padding:0 18mm;display:flex;justify-content:space-between"><span>github.com/diegoparras/arcanum</span>
  <span class="pageNumber"></span></div>"""


def version() -> str:
    if len(sys.argv) > 1:
        return sys.argv[1]
    return json.loads((AQUI.parents[2] / 'package.json').read_text(encoding='utf-8'))['version']


def main() -> None:
    v = version()
    SALIDA.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        nav = p.chromium.launch()
        for nombre, titulo in GUIAS.items():
            pag = nav.new_page()
            pag.goto((AQUI / f'{nombre}.html').as_uri())
            pag.evaluate(f"document.body.innerHTML = document.body.innerHTML.replaceAll('{{{{VERSION}}}}', '{v}')")
            pag.wait_for_load_state('networkidle')
            pag.evaluate('document.fonts.ready')
            # Tapa: sin márgenes ni encabezado.
            pag.add_style_tag(content='main.cuerpo{display:none}')
            tapa = pag.pdf(format='A4', print_background=True, margin={'top': '0', 'bottom': '0', 'left': '0', 'right': '0'},
                           page_ranges='1')
            # Cuerpo: márgenes, encabezado y número de página.
            pag.add_style_tag(content='main.cuerpo{display:block!important}.tapa{display:none}')
            cuerpo = pag.pdf(format='A4', print_background=True, display_header_footer=True,
                             header_template=ENCABEZADO.format(titulo=titulo, version=v), footer_template=PIE,
                             margin={'top': '20mm', 'bottom': '18mm', 'left': '18mm', 'right': '18mm'})
            w = PdfWriter()
            for parte in (tapa, cuerpo):
                for hoja in PdfReader(io.BytesIO(parte)).pages:
                    w.add_page(hoja)
            w.add_metadata({'/Title': f'Arcanum · {titulo}', '/Author': 'Diego Parras · Ecosistema Escriba',
                            '/Subject': 'Gateway REST para los Web Services de ARCA', '/Creator': 'Arcanum'})
            destino = SALIDA / f'arcanum-guia-{nombre}.pdf'
            with open(destino, 'wb') as f:
                w.write(f)
            print(f'{destino.name}: {len(w.pages)} páginas')
            pag.close()
        nav.close()


if __name__ == '__main__':
    main()
