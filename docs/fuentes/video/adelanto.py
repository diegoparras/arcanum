"""Adelanto animado para el README: un tramo del video convertido en GIF con paleta optimizada.

Requisitos: imageio-ffmpeg (trae ffmpeg) y el video ya renderizado (video.py).
Uso:  python adelanto.py [--desde 27.6] [--duracion 8] [--ancho 720] [--fps 12]
"""
from __future__ import annotations

import argparse
import pathlib
import subprocess

import imageio_ffmpeg

AQUI = pathlib.Path(__file__).resolve().parent
MEDIA = AQUI.parents[1] / 'media'


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--video', default=str(MEDIA / 'arcanum.mp4'))
    ap.add_argument('--salida', default=str(MEDIA / 'adelanto.gif'))
    ap.add_argument('--desde', type=float, default=27.6)
    ap.add_argument('--duracion', type=float, default=8.0)
    ap.add_argument('--ancho', type=int, default=8.0)
    ap.add_argument('--fps', type=int, default=12)
    a = ap.parse_args()

    filtro = (f'fps={a.fps},scale={a.ancho}:-1:flags=lanczos,split[x][y];'
              '[x]palettegen=max_colors=128:stats_mode=diff[p];'
              '[y][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle')
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-loglevel', 'error',
                    '-ss', str(a.desde), '-t', str(a.duracion), '-i', a.video,
                    '-filter_complex', filtro, '-loop', '0', a.salida], check=True)
    print(a.salida, f'{pathlib.Path(a.salida).stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()
