"""Música del video de presentación de Arcanum, sintetizada desde cero (sin samples ni licencias).

Electrónica a 124 BPM en La menor (Am - F - C - G), con un guiño a la cumbia: una güira en los
drops. La estructura sigue las escenas del video, compás por compás:

    0-4   intro       pad, arpegio filtrado y subida
    4-10  el problema bombo, hats y bajo: tensión
    10-31 la solución drop completo
    31-35 seguridad   quiebre: pad y arpegio, sin bombo; subida al final
    35-41 instalación drop final
    41-43 cierre      pad y golpe final

Uso:  python musica.py salida.wav
"""
from __future__ import annotations

import sys

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 44100
BPM = 124
BEAT = 60 / BPM
BAR = 4 * BEAT
COMPASES = 43
DUR = COMPASES * BAR + 2.5  # cola para que el último acorde respire
N = int(DUR * SR)
rng = np.random.default_rng(2026)


def t_(seg: float) -> np.ndarray:
    return np.arange(int(seg * SR)) / SR


def env(n: int, a: float = 0.005, d: float = 0.2, s: float = 0.0, r: float = 0.05, largo: float | None = None) -> np.ndarray:
    """Envolvente ADSR de n muestras."""
    a_n, d_n, r_n = int(a * SR), int(d * SR), int(r * SR)
    sus_n = max(0, n - a_n - d_n - r_n)
    e = np.concatenate([
        np.linspace(0, 1, max(a_n, 1)), np.linspace(1, s, max(d_n, 1)),
        np.full(sus_n, s), np.linspace(s, 0, max(r_n, 1))])
    return e[:n] if len(e) >= n else np.pad(e, (0, n - len(e)))


def lp(x, f, orden=2):
    b, a = signal.butter(orden, min(f / (SR / 2), 0.99), 'low')
    return signal.lfilter(b, a, x)


def hp(x, f, orden=2):
    b, a = signal.butter(orden, min(f / (SR / 2), 0.99), 'high')
    return signal.lfilter(b, a, x)


def bp(x, f1, f2, orden=2):
    b, a = signal.butter(orden, [f1 / (SR / 2), min(f2 / (SR / 2), 0.99)], 'band')
    return signal.lfilter(b, a, x)


def saw(f, t, detune=0.0):
    return 2 * ((f * (1 + detune) * t) % 1) - 1


def nota(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def poner(pista: np.ndarray, sonido: np.ndarray, seg: float, gan: float = 1.0) -> None:
    i = int(seg * SR)
    if i >= len(pista):
        return
    fin = min(len(pista), i + len(sonido))
    pista[i:fin] += sonido[:fin - i] * gan


# --- instrumentos -----------------------------------------------------------------------------
def bombo():
    t = t_(0.42)
    f = 48 + 110 * np.exp(-t * 28)
    fase = 2 * np.pi * np.cumsum(f) / SR
    cuerpo = np.sin(fase) * np.exp(-t * 7.5)
    click = hp(rng.standard_normal(len(t)), 2000) * np.exp(-t * 300) * 0.25
    return np.tanh((cuerpo + click) * 1.6)


def palmas():
    t = t_(0.3)
    ruido = bp(rng.standard_normal(len(t)), 900, 5200)
    e = np.zeros(len(t))
    for k, retardo in enumerate((0, 0.011, 0.022)):
        i = int(retardo * SR)
        e[i:] += np.exp(-np.arange(len(t) - i) / SR * (60 if k < 2 else 18))
    return np.tanh(ruido * e * 1.4) * 0.8


def hat(abierto=False):
    t = t_(0.28 if abierto else 0.06)
    return hp(rng.standard_normal(len(t)), 7500) * np.exp(-t * (14 if abierto else 85)) * (0.55 if abierto else 0.5)


def guira(acento: bool):
    """Raspado de güira: ruido brillante con un tremolo rápido."""
    t = t_(0.11 if acento else 0.07)
    raspado = hp(rng.standard_normal(len(t)), 3500) * (0.6 + 0.4 * np.sign(np.sin(2 * np.pi * 180 * t)))
    return raspado * np.exp(-t * (30 if acento else 55)) * (0.4 if acento else 0.26)


def bajo(midi, largo, brillo=900):
    t = t_(largo)
    f = nota(midi)
    x = 0.6 * saw(f, t) + 0.4 * np.sin(2 * np.pi * f * t) + 0.25 * np.sin(np.pi * f * t)
    x = lp(x, brillo, 2)
    return np.tanh(x * 1.8) * env(len(t), 0.004, 0.12, 0.7, 0.03) * 0.8


def pluck(midi, largo=0.22, brillo=3800):
    t = t_(largo)
    f = nota(midi)
    x = saw(f, t) * 0.6 + saw(f, t, 0.006) * 0.4
    x = lp(x, brillo, 2)
    return x * env(len(t), 0.002, largo * 0.9, 0.0, 0.01) * 0.5


def pad(midis, largo, brillo=1700):
    t = t_(largo)
    x = np.zeros(len(t))
    for m in midis:
        f = nota(m)
        for d in (-0.004, 0.0, 0.0045):
            x += saw(f, t, d)
    x = lp(x / (len(midis) * 3), brillo, 2)
    return x * env(len(t), 0.35, 0.2, 0.85, 0.6)


def subida(largo):
    """Ruido que sube de filtro y de volumen: anticipa un drop."""
    t = t_(largo)
    x = rng.standard_normal(len(t))
    out = np.zeros(len(t))
    pasos = 24
    for k in range(pasos):
        a, b = k * len(t) // pasos, (k + 1) * len(t) // pasos
        out[a:b] = bp(x[a:b], 300 + 9000 * (k / pasos) ** 2, 300 + 9000 * (k / pasos) ** 2 + 2500)
    return out * np.linspace(0, 1, len(t)) ** 2 * 0.5


def impacto():
    t = t_(2.2)
    grave = np.sin(2 * np.pi * (38 + 40 * np.exp(-t * 6)) * t) * np.exp(-t * 2.2)
    platillo = hp(rng.standard_normal(len(t)), 4000) * np.exp(-t * 2.6) * 0.3
    return np.tanh((grave + platillo) * 1.3) * 0.9


# --- armado -----------------------------------------------------------------------------------
# Am - F - C - G, un acorde por compás.
ACORDES = [(57, 60, 64), (53, 57, 60), (48, 52, 55), (55, 59, 62)]
RAICES = [45, 41, 48, 43]
ARP = [0, 1, 2, 1, 2, 0, 2, 1]

pistas = {k: np.zeros(N) for k in ('bombo', 'perc', 'bajo', 'pad', 'arp', 'fx')}


def seccion(c):
    if c < 4:
        return 'intro'
    if c < 10:
        return 'problema'
    if c < 31:
        return 'drop'
    if c < 35:
        return 'quiebre'
    if c < 41:
        return 'drop'
    return 'cierre'


BOMBO, PALMAS, HAT, HAT_A = bombo(), palmas(), hat(), hat(True)
for c in range(COMPASES):
    sec = seccion(c)
    t0 = c * BAR
    acorde, raiz = ACORDES[c % 4], RAICES[c % 4]
    # Pad: siempre, mas abierto en los drops.
    if sec != 'cierre' or c == 41:
        poner(pistas['pad'], pad([m + 12 for m in acorde], BAR + 0.4, 1200 if sec in ('intro', 'quiebre') else 2200), t0, 0.5)
    # Arpegio a semicorcheas.
    for k in range(16):
        if sec == 'cierre':
            break
        m = acorde[ARP[k % 8]] + 24 + (12 if (k % 8) == 4 else 0)
        brillo = {'intro': 900 + 2800 * (c / 4), 'problema': 2000, 'drop': 6500, 'quiebre': 2200}[sec]
        gan = {'intro': 0.35, 'problema': 0.22, 'drop': 0.55, 'quiebre': 0.5}[sec]
        poner(pistas['arp'], pluck(m, 0.2, brillo), t0 + k * BEAT / 4, gan)
    if sec in ('problema', 'drop'):
        for b in range(4):
            poner(pistas['bombo'], BOMBO, t0 + b * BEAT, 1.0)
        for b in (1, 3):
            if sec == 'drop' or c >= 7:  # en el problema las palmas entran a mitad: crece la tension
                poner(pistas['perc'], PALMAS, t0 + b * BEAT, 0.6 if sec == 'drop' else 0.35)
        for k in range(16):
            if k % 4 == 2:
                poner(pistas['perc'], HAT_A, t0 + k * BEAT / 4, 0.35)
            elif sec == 'drop' or k % 2 == 0:
                poner(pistas['perc'], HAT, t0 + k * BEAT / 4, 0.34 if k % 2 else 0.22)
        # Bajo: corcheas a contratiempo (el bombo marca el tiempo).
        for k in range(8):
            if k % 2 == 1:
                poner(pistas['bajo'], bajo(raiz + (12 if k == 7 and sec == 'drop' else 0), BEAT / 2 * 0.95,
                                            1300 if sec == 'drop' else 700), t0 + k * BEAT / 2, 0.9)
    if sec == 'drop':
        # Güira: el rasgueo de la cumbia (larga-corta-corta) sobre cada tiempo.
        for b in range(4):
            poner(pistas['perc'], guira(True), t0 + b * BEAT, 0.9)
            poner(pistas['perc'], guira(False), t0 + b * BEAT + BEAT * 0.5, 0.9)
            poner(pistas['perc'], guira(False), t0 + b * BEAT + BEAT * 0.75, 0.9)
    if sec == 'quiebre':
        poner(pistas['bajo'], bajo(raiz, BAR * 0.95, 400), t0, 0.7)

# Subidas antes de cada drop e impactos en el golpe.
for antes, golpe in ((4, 0), (10, 10), (35, 35)):
    largo = (2 if golpe != 0 else 4) * BAR
    poner(pistas['fx'], subida(largo), golpe * BAR - largo if golpe else 0, 0.9)
for golpe in (10, 35):
    poner(pistas['fx'], impacto(), golpe * BAR, 1.0)
poner(pistas['fx'], impacto(), 41 * BAR, 1.1)
poner(pistas['bombo'], BOMBO, 41 * BAR, 1.2)

# Sidechain: todo menos bombo y fx "respira" con cada bombo de los drops.
duck = np.ones(N)
for c in range(COMPASES):
    if seccion(c) in ('problema', 'drop'):
        for b in range(4):
            i = int((c * BAR + b * BEAT) * SR)
            largo = int(BEAT * SR * 0.6)
            curva = 1 - 0.55 * np.exp(-np.arange(largo) / SR * 9)
            duck[i:i + largo] = np.minimum(duck[i:i + largo], curva[:len(duck[i:i + largo])])

mezcla_mono = (pistas['bombo'] * 0.95 + pistas['perc'] * 1.15 + pistas['bajo'] * duck * 0.8
               + pistas['pad'] * duck * 0.55 + pistas['arp'] * duck * 0.5 + pistas['fx'] * 0.7)

# Espacio: reverb corta por convolución (ruido con decaimiento) sobre pad y arpegio, en estéreo.
ir_t = t_(1.6)
ir_l = rng.standard_normal(len(ir_t)) * np.exp(-ir_t * 3.2)
ir_r = rng.standard_normal(len(ir_t)) * np.exp(-ir_t * 3.2)
envio = (pistas['pad'] * 0.5 + pistas['arp'] * 0.6) * duck
rev_l = signal.fftconvolve(envio, ir_l)[:N] * 0.03
rev_r = signal.fftconvolve(envio, ir_r)[:N] * 0.03

# Paneo leve del arpegio con un LFO lento, para ancho estéreo.
lfo = 0.5 + 0.35 * np.sin(2 * np.pi * np.arange(N) / SR / (BAR * 2))
izq = mezcla_mono - pistas['arp'] * duck * 0.5 * (1 - lfo) * 0.6 + rev_l
der = mezcla_mono - pistas['arp'] * duck * 0.5 * lfo * 0.6 + rev_r
st = np.stack([izq, der], axis=1)

# Master: filtro de graves sucios, compresión suave y limitador.
st = hp(st.T, 28).T
st = st + hp(st.T, 5000).T * 0.6  # brillo: realce de agudos
st = np.tanh(st * 1.1) / np.tanh(1.1)
st = st / (np.max(np.abs(st)) + 1e-9) * 0.93
fade = np.ones(N)
fade[-int(2.0 * SR):] = np.linspace(1, 0, int(2.0 * SR))
st *= fade[:, None]

salida = sys.argv[1] if len(sys.argv) > 1 else 'musica.wav'
wavfile.write(salida, SR, (st * 32767).astype(np.int16))
print(f'{salida}: {DUR:.1f} s, {BPM} BPM, compás = {BAR:.3f} s')
