"""Renderiza el video de presentación de Arcanum: video.html cuadro por cuadro + musica.wav -> MP4.

Requisitos: playwright (con Chromium) e imageio-ffmpeg (trae ffmpeg).
Uso:  python video.py [salida.mp4] [--desde S --hasta S] [--fps 30]
"""
from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys
import tempfile

import imageio_ffmpeg
from playwright.sync_api import sync_playwright

AQUI = pathlib.Path(__file__).resolve().parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('salida', nargs='?', default=str(AQUI.parents[1] / 'media' / 'arcanum.mp4'))
    ap.add_argument('--fps', type=int, default=30)
    ap.add_argument('--desde', type=float, default=0.0)
    ap.add_argument('--hasta', type=float, default=None)
    ap.add_argument('--cuadros', help='en vez del video, guarda PNG de estos segundos (coma)')
    a = ap.parse_args()

    musica = pathlib.Path(tempfile.gettempdir()) / 'arcanum-musica.wav'
    if not a.cuadros:
        subprocess.run([sys.executable, str(AQUI / 'musica.py'), str(musica)], check=True)

    with sync_playwright() as p:
        nav = p.chromium.launch()
        pag = nav.new_page(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1)
        pag.goto((AQUI / 'video.html').as_uri())
        pag.wait_for_function('window.listo && window.listo()', timeout=30000)
        dur = pag.evaluate('window.DURACION')
        fin = a.hasta if a.hasta is not None else dur

        if a.cuadros:
            for s in a.cuadros.split(','):
                pag.evaluate(f'render({float(s)})')
                pag.screenshot(path=f'cuadro-{float(s):06.2f}.png')
            nav.close()
            return

        ff = imageio_ffmpeg.get_ffmpeg_exe()
        cmd = [ff, '-y', '-loglevel', 'error',
               '-f', 'image2pipe', '-framerate', str(a.fps), '-c:v', 'mjpeg', '-i', '-',
               '-ss', str(a.desde), '-i', str(musica),
               '-vf', 'scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p', '-color_range', 'tv', '-colorspace', 'bt709',
               '-color_primaries', 'bt709', '-color_trc', 'bt709',
               '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-movflags', '+faststart',
               '-c:a', 'aac', '-b:a', '192k', '-shortest', a.salida]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        total = int((fin - a.desde) * a.fps)
        for i in range(total):
            t = a.desde + i / a.fps
            pag.evaluate(f'render({t})')
            proc.stdin.write(pag.screenshot(type='jpeg', quality=93))
            if i % (a.fps * 5) == 0:
                print(f'  {t:5.1f} s / {fin:.1f} s', flush=True)
        proc.stdin.close()
        proc.wait()
        nav.close()
    print('listo:', a.salida)


if __name__ == '__main__':
    main()
