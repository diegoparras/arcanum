"""Versión web del video para el reproductor del README: 720p, menos de 10 MB (límite de GitHub).

El primer cuadro es el logo con el lema, para que la vista previa del reproductor no quede negra.
Después se sube arrastrando el archivo a un comentario de GitHub (sin publicarlo) y el enlace
https://github.com/user-attachments/assets/... va solo en una línea del README.

Requisitos: imageio-ffmpeg y el video ya renderizado (video.py).
Uso:  python web.py [salida.mp4] [--portada 4.2]
"""
from __future__ import annotations

import argparse
import os
import pathlib
import subprocess
import tempfile

import imageio_ffmpeg

AQUI = pathlib.Path(__file__).resolve().parent
VIDEO = AQUI.parents[1] / 'media' / 'arcanum.mp4'


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('salida', nargs='?', default=str(pathlib.Path(tempfile.gettempdir()) / 'arcanum-web.mp4'))
    ap.add_argument('--portada', type=float, default=4.2, help='segundo del video que se usa como portada')
    a = ap.parse_args()

    ff = imageio_ffmpeg.get_ffmpeg_exe()
    tmp = pathlib.Path(tempfile.mkdtemp())
    portada = tmp / 'portada.png'
    subprocess.run([ff, '-y', '-loglevel', 'error', '-ss', str(a.portada), '-i', str(VIDEO), '-frames:v', '1',
                    '-vf', 'scale=1280:-2:flags=lanczos', str(portada)], check=True)
    base = [ff, '-y', '-loglevel', 'error', '-i', str(VIDEO), '-loop', '1', '-i', str(portada),
            '-filter_complex', "[0:v]scale=1280:-2:flags=lanczos[b];[b][1:v]overlay=enable='lt(t,0.07)':shortest=1[o]",
            '-map', '[o]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'slow', '-b:v', '760k', '-pix_fmt', 'yuv420p',
            '-passlogfile', str(tmp / 'pase')]
    nulo = 'NUL' if os.name == 'nt' else '/dev/null'
    subprocess.run(base + ['-pass', '1', '-an', '-f', 'mp4', nulo], check=True)
    subprocess.run(base + ['-pass', '2', '-c:a', 'aac', '-b:a', '112k', '-movflags', '+faststart', a.salida], check=True)
    mb = pathlib.Path(a.salida).stat().st_size / 1048576
    print(f'{a.salida}  {mb:.1f} MB' + ('' if mb < 10 else '  (pasa de 10 MB: GitHub no lo acepta)'))


if __name__ == '__main__':
    main()
