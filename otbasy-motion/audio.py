#!/usr/bin/env python3
"""Музыка и звуковой дизайн ролика: синтез с нуля (numpy), события берутся из events.json.
Выход: music.wav, sfx.wav, mix.wav (48 кГц, стерео, 22 с)."""
import json, wave, numpy as np

SR = 48000
ev = json.load(open('events.json'))
DUR = ev['DURATION']
N = int(SR * DUR)
rs = np.random.RandomState(11)

def buf(): return np.zeros((N, 2))
def place(dst, sig, t, gain=1.0, pan=0.0):
    i = int(round(t * SR))
    if i >= N: return
    if i < 0: sig = sig[-i:]; i = 0
    sig = sig[: N - i]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    dst[i:i + len(sig), 0] += sig * gain * l * 1.414
    dst[i:i + len(sig), 1] += sig * gain * r * 1.414
def tt(d): return np.arange(int(SR * d)) / SR
def env_ad(t, a, d): return np.minimum(t / max(a, 1e-5), 1.0) * np.exp(-np.maximum(t - a, 0) / d)
def fade(sig, a=0.003, r=0.01):
    n = len(sig); e = np.ones(n); na, nr = int(a * SR), int(r * SR)
    if na: e[:na] = np.linspace(0, 1, na)
    if nr: e[-nr:] *= np.linspace(1, 0, nr)
    return sig * e
def fftfilt(x, lo=None, hi=None, slope=4):
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR); g = np.ones_like(f)
    if lo: g *= 1 / np.sqrt(1 + (lo / np.maximum(f, 1e-3)) ** (2 * slope))
    if hi: g *= 1 / np.sqrt(1 + (f / hi) ** (2 * slope))
    return np.fft.irfft(X * g, len(x))
def noise(d): return rs.randn(int(SR * d))
def hz(n): return 440.0 * 2 ** ((n - 69) / 12)
NOTE = {n: i for i, n in enumerate(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'])}
def nn(s): return 12 * (int(s[-1]) + 1) + NOTE[s[:-1]]

# ---------- инструменты ----------
def pluck(f, d=0.9, bright=1.0, vel=1.0):
    """Щипок нейлоновой струны (домбра): гармоники с частотно-зависимым затуханием + щелчок медиатора."""
    t = tt(d); s = np.zeros_like(t)
    for k in range(1, 22):
        fk = f * k * (1 + 0.00025 * k * k)
        if fk > 12000: break
        a = np.sin(np.pi * k * 0.23) / k ** (1.15 - 0.25 * bright)
        s += a * np.exp(-t * (3.2 + 0.55 * k ** 1.5)) * np.sin(2 * np.pi * fk * t + k)
    body = np.exp(-t * 28) * np.sin(2 * np.pi * 190 * t) * 0.25          # деревянный корпус
    click = fftfilt(noise(d), 1500, 7000) * np.exp(-t * 420) * 0.5 * bright
    return fade((s + body + click) * vel, 0.001, 0.02)
def bell(f, d=1.6, vel=1.0):
    t = tt(d); s = np.zeros_like(t)
    for r, a, dc in [(1, 1, 3.2), (2.0, 0.45, 4.5), (2.76, 0.3, 6), (4.07, 0.16, 8), (5.4, 0.1, 11)]:
        s += a * np.exp(-t * dc) * np.sin(2 * np.pi * f * r * t)
    return fade(s * vel * env_ad(t, 0.002, 9), 0.001, 0.05)
def kick(vel=1.0):
    t = tt(0.4); f = 46 + 95 * np.exp(-t * 32)
    return fade(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9) * vel + fftfilt(noise(0.4), 800, 5000) * np.exp(-t * 300) * 0.12, 0.001, 0.03)
def clap(vel=1.0):
    t = tt(0.25); n = fftfilt(noise(0.25), 900, 3800, 2)
    e = sum(np.exp(-np.maximum(t - o, 0) * 55) * (t >= o) for o in (0, 0.011, 0.023)) / 2
    return fade(n * e * vel, 0.0005, 0.02)
def hat(vel=1.0, d=0.06):
    t = tt(d * 4); return fade(fftfilt(noise(d * 4), 7000, None, 3) * np.exp(-t / d * 3) * vel, 0.0005, 0.01)
def pad(notes, d, vel=1.0):
    t = tt(d); s = np.zeros_like(t)
    for n in notes:
        f = hz(n)
        for det in (-0.004, 0.0, 0.005):
            for k, a in ((1, 1), (2, 0.35), (3, 0.18), (4, 0.07)):
                s += a * np.sin(2 * np.pi * f * k * (1 + det) * t + rs.rand() * 6)
    e = np.minimum(t / 0.5, 1) * np.minimum((d - t) / 0.6, 1).clip(0, 1)
    return s * e * vel / (len(notes) * 4)
def bass(n, d=0.45, vel=1.0):
    t = tt(d); f = hz(n)
    return fade((np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) + 0.12 * np.sin(6 * np.pi * f * t)) * env_ad(t, 0.006, 0.28) * vel, 0.002, 0.03)

# ---------- SFX ----------
def clink(f=3000, vel=1.0):
    t = tt(0.35); s = np.zeros_like(t)
    for r, a, dc in [(1, 1, 26), (1.52, 0.6, 34), (2.31, 0.4, 44), (3.42, 0.22, 60)]:
        s += a * np.exp(-t * dc) * np.sin(2 * np.pi * f * r * t)
    tick = fftfilt(noise(0.35), 2500, 9000) * np.exp(-t * 500) * 0.6
    return fade((s * 0.5 + tick) * vel, 0.0005, 0.02)
def thud(f0=70, vel=1.0, d=0.7):
    t = tt(d); f = f0 * (1 + 1.2 * np.exp(-t * 26))
    return fade(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 6.5) * vel + fftfilt(noise(d), 120, 1400, 2) * np.exp(-t * 34) * 0.5 * vel, 0.001, 0.05)
def whoosh(d, lo=400, hi=5000, rising=True, vel=1.0):
    t = tt(d); x = t / d
    e = (x ** 2.4 if rising else (1 - x) ** 2) * np.sin(np.pi * np.minimum(x * 1.02, 1)) ** 0.3
    a, b = fftfilt(noise(d), lo, lo * 3, 2), fftfilt(noise(d), hi / 2.5, hi, 2)
    mix = a * (1 - x if rising else x) + b * (x if rising else 1 - x)
    return fade(mix * e * vel, 0.01, 0.02)
def glide(f0, f1, d, vel=1.0, curve=1.0):
    t = tt(d); x = (t / d) ** curve; f = f0 * (f1 / f0) ** x
    return fade(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * t / d) ** 0.7 * vel, 0.005, 0.02)
def pop(f=600, vel=1.0):
    t = tt(0.09); fr = f * (1 + 0.9 * (t / 0.09))
    return fade(np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t * 30) * vel, 0.001, 0.01)
def tick(vel=1.0):
    t = tt(0.05); return fade((np.sin(2 * np.pi * 1300 * t) * np.exp(-t * 130) + fftfilt(noise(0.05), 2000, 8000) * np.exp(-t * 300) * 0.5) * vel, 0.0005, 0.005)
def shimmer(d, vel=1.0):
    t = tt(d); s = np.zeros_like(t)
    for f in [hz(nn(x)) for x in ('D6', 'F#6', 'A6', 'D7', 'E7')]:
        s += np.sin(2 * np.pi * f * t + rs.rand() * 6) * (0.5 + 0.5 * np.sin(2 * np.pi * (3 + rs.rand() * 4) * t + rs.rand() * 6))
    return fade(s / 5 * np.sin(np.pi * np.minimum(t / d, 1)) ** 0.5 * np.exp(-t * 1.2) * vel + fftfilt(noise(d), 6000, None, 2) * np.exp(-t * 2.2) * 0.25 * vel, 0.02, 0.2)

music, sfx = buf(), buf()
BEAT = 0.5
import sys
GAIN = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
T = ev['T']

# ---------- МУЗЫКА (120 BPM, ре мажорная пентатоника, домбра в «скачущем» ритме) ----------
chords = {  # такт (2 с) → аккорд пэда и бас
    0: ['D3', 'A3', 'D4', 'F#4'], 1: ['D3', 'A3', 'E4', 'F#4'], 2: ['D3', 'A3', 'D4', 'F#4'], 3: ['G2', 'D3', 'G3', 'B3', 'D4'],
    4: ['B2', 'F#3', 'B3', 'D4'], 5: ['A2', 'E3', 'A3', 'C#4', 'E4'], 6: ['G2', 'D3', 'G3', 'B3', 'D4'], 7: ['A2', 'E3', 'A3', 'C#4', 'E4'],
    8: ['G2', 'D3', 'B3', 'E4'], 9: ['D3', 'A3', 'D4', 'F#4', 'A4'], 10: ['D3', 'A3', 'D4', 'F#4', 'A4'],
}
for b, ch in chords.items():
    v = 0.16 if b < 2 else 0.2 if b < 9 else 0.22
    d = 2.35 if b < 10 else 2.0
    place(music, pad([nn(x) for x in ch], d, v), b * 2 - 0.12 if b else 0, 1.0)
# вступление: шесть нот поднимают шесть букв «ОТБАСЫ»
for i, n in enumerate(['D4', 'E4', 'F#4', 'A4', 'B4', 'D5']):
    place(music, pluck(hz(nn(n)), 1.1, 0.9, 0.5 + i * 0.05), 0.95 + i * 0.125 + 0.1, 1.0, -0.4 + i * 0.16)
    place(music, pluck(hz(nn('D3')), 0.8, 0.6, 0.22), 0.95 + i * 0.125 + 0.1, 1.0, 0)
for t0, n in [(2.0, 'A4'), (2.5, 'F#4'), (2.75, 'A4'), (3.0, 'B4'), (3.25, 'A4')]:
    place(music, pluck(hz(nn(n)), 1.0, 0.8, 0.42), t0, 1.0, 0.1)
# основная тема: на каждую долю — восьмая и две шестнадцатых (скачущий ритм домбры)
melody = {
    2: ['A4', 'A4', 'B4', 'A4'], 3: ['D5', 'B4', 'A4', 'F#4'], 4: ['B4', 'B4', 'D5', 'B4'], 5: ['A4', 'E5', 'D5', 'B4'],
    6: ['D5', 'D5', 'E5', 'F#5'], 7: ['E5', 'F#5', 'A5', 'E5'], 8: ['F#5', 'E5', 'D5', 'B4'],
}
drone = {2: ('D3', 'A3'), 3: ('G3', 'D4'), 4: ('B2', 'F#3'), 5: ('A2', 'E3'), 6: ('G3', 'D4'), 7: ('A3', 'E4'), 8: ('G3', 'D4')}
for b, notes in melody.items():
    for k, n in enumerate(notes):
        t0 = b * 2 + k * BEAT
        lvl = 0.5 if b < 4 else 0.58 if b < 6 else 0.66
        for off, v in ((0, 1.0), (0.25, 0.62), (0.375, 0.75)):
            place(music, pluck(hz(nn(n)), 0.7, 1.0, lvl * v), t0 + off, 1.0, 0.18)
            for dn in drone[b]:
                place(music, pluck(hz(nn(dn)), 0.6, 0.7, lvl * v * 0.42), t0 + off + 0.006, 1.0, -0.22)
# пробежка в финал
for i, n in enumerate(['A4', 'B4', 'D5', 'E5', 'F#5', 'A5', 'B5', 'D6']):
    place(music, pluck(hz(nn(n)), 0.5, 1.1, 0.4 + i * 0.045), 17.0 + i * 0.125, 1.0, -0.3 + i * 0.09)
# ритм-секция
for b in range(2, 9):
    for k in range(4):
        t0 = b * 2 + k * BEAT
        if b == 6 and k == 0: continue  # удар стройки заменяет бочку
        place(music, kick(0.85 if k % 2 == 0 else 0.6), t0)
        if k % 2 == 1 and b >= 3: place(music, clap(0.34), t0, 1.0, 0.1)
        if b >= 4:
            for h in range(4): place(music, hat(0.1 if h % 2 else 0.16), t0 + h * 0.125, 1.0, 0.35)
        root = chords[b][0]
        if b >= 4:
            place(music, bass(nn(root), 0.42, 0.5), t0); place(music, bass(nn(root) + 12, 0.2, 0.26), t0 + 0.25)
for i in range(8):  # дробь перед финалом
    place(music, clap(0.12 + i * 0.035), 17.0 + i * 0.125, 1.0, 0)
# финал: аккорд на титр, три слова слогана, последний перебор
place(music, kick(1.0), 18.0); place(music, bass(nn('D2'), 1.6, 0.6), 18.0)
for i, n in enumerate(['D3', 'A3', 'D4', 'F#4', 'A4', 'D5']):
    place(music, pluck(hz(nn(n)), 2.2, 1.0, 0.6), 18.0 + i * 0.016, 1.0, -0.3 + i * 0.12)
for t0, n in [(18.5, 'A4'), (18.75, 'F#4')]:
    place(music, pluck(hz(nn(n)), 1.0, 0.8, 0.36), t0, 1.0, 0.15)
for t0, ns in [(19.0, ('D4', 'A4')), (19.5, ('F#4', 'B4')), (20.0, ('A4', 'D5'))]:
    for n in ns: place(music, pluck(hz(nn(n)), 1.6, 0.9, 0.5), t0, 1.0, 0.0)
    place(music, kick(0.5), t0)
for i, n in enumerate(['D3', 'A3', 'D4', 'F#4', 'A4', 'D5', 'F#5']):
    place(music, pluck(hz(nn(n)), 2.4, 0.9, 0.42), 20.5 + i * 0.03, 1.0, -0.3 + i * 0.1)

# ---------- ЗВУКОВОЙ ДИЗАЙН ----------
place(sfx, whoosh(1.6, 200, 2500, True, 0.2), 0.0)                       # восход
place(sfx, shimmer(2.0, 0.22), 0.6)
place(sfx, whoosh(0.3, 250, 1500, False, 0.22), 3.3)                     # буквы ложатся
place(sfx, glide(2600, 700, T['firstCoin'] - T['coinLaunch'], 0.16, 1.6), T['coinLaunch'])  # монета летит из шанырака
place(sfx, whoosh(T['firstCoin'] - T['coinLaunch'], 500, 7000, True, 0.5), T['coinLaunch'])
place(sfx, thud(62, 0.95), T['firstCoin']); place(sfx, clink(2300, 0.6), T['firstCoin'])
pent = [nn(x) for x in ('D6', 'E6', 'F#6', 'A6', 'B6', 'D7')]
for i, c in enumerate(ev['coins'][1:]):                                    # монеты копятся
    place(sfx, clink(2400 + 160 * c['level'] + rs.rand() * 250, 0.2 + 0.05 * rs.rand()), c['t'], 1.0, (c['s'] % 3 - 1) * 0.5)
for i in range(4): place(sfx, tick(0.16), 4.5 + i * 0.09 + 0.2, 1.0, -0.5)   # буквы «КОПИ»
place(sfx, whoosh(0.3, 250, 1500, False, 0.2), 7.9)
for i, c in enumerate(ev['bonus']):                                        # премия: колокольчики вверх по пентатонике
    place(sfx, bell(hz(pent[i]), 1.5, 0.3), c['t'], 1.0, (c['s'] % 3 - 1) * 0.5)
    place(sfx, clink(3300, 0.14), c['t'], 1.0, (c['s'] % 3 - 1) * 0.5)
place(sfx, shimmer(1.6, 0.3), T['bonus']); place(sfx, thud(80, 0.35, 0.4), T['bonus'])
place(sfx, whoosh(0.3, 250, 1500, False, 0.2), 11.66)
place(sfx, whoosh(0.5, 300, 6000, True, 0.4), T['build'] - 0.5)           # стройка
place(sfx, thud(52, 0.9, 0.9), T['build']); place(sfx, glide(180, 720, 0.7, 0.2, 0.7), T['build'] + 0.05)
place(sfx, glide(1500, 380, 0.45, 0.14, 1.4), T['roof'] - 0.45)           # крыша падает
place(sfx, thud(58, 1.0, 0.8), T['roof']); place(sfx, fade(fftfilt(noise(0.3), 300, 2500, 2) * np.exp(-tt(0.3) * 26) * 0.5), T['roof'])
for i, t0 in enumerate(ev['windows']):                                     # окна зажигаются
    place(sfx, bell(hz(nn(['A5', 'D6', 'F#6'][i])), 1.2, 0.26), t0, 1.0, [-0.4, 0.4, 0][i]); place(sfx, tick(0.2), t0)
for i in range(7): place(sfx, tick(0.13), 13.5 + i * 0.06 + 0.2, 1.0, -0.5)
for i, t0 in enumerate(ev['family']): place(sfx, pop([520, 620, 880][i], 0.3), t0 + 0.05, 1.0, 0.4)
place(sfx, whoosh(0.3, 250, 1500, False, 0.2), 16.4)
place(sfx, whoosh(1.9, 200, 3000, True, 0.2), 16.0)
for i, t0 in enumerate(ev['houses']):                                      # посёлок вырастает
    place(sfx, pop(hz([nn(x) for x in ('D4', 'E4', 'F#4', 'A4', 'B4')][i % 5]) * (1 + (i // 5) * 0.5), 0.2), t0 + 0.08, 1.0, rs.rand() * 1.6 - 0.8)
for i in range(10): place(sfx, tick(0.13), T['title'] + i * 0.05 + 0.2, 1.0, -0.6 + i * 0.13)
place(sfx, shimmer(3.2, 0.4), T['title']); place(sfx, thud(55, 0.55, 1.0), T['title'])
for t0 in (19.0, 19.5, 20.0): place(sfx, whoosh(0.22, 800, 5000, False, 0.1), t0)

# ---------- сведение ----------
def reverb(x, d=1.4, wet=0.16):
    n = int(SR * d); t = np.arange(n) / SR; out = np.zeros_like(x)
    for c in range(2):
        ir = rs.randn(n) * np.exp(-t * 4.2); ir[: int(0.012 * SR)] = 0; ir = fftfilt(ir, 250, 6500, 1); ir /= np.sqrt((ir ** 2).sum())
        L = len(x) + n; out[:, c] = np.fft.irfft(np.fft.rfft(x[:, c], L) * np.fft.rfft(ir, L), L)[: len(x)]
    return x + out * wet
def finish(x, peak=0.89):
    x = np.tanh(x * 1.1) / 1.1
    e = np.ones(N); fo = int(0.7 * SR); e[-fo:] = np.linspace(1, 0, fo) ** 1.6
    return x * e[:, None]
music = reverb(music * 0.9, 1.4, 0.2)
sfx = reverb(sfx * 0.85, 1.0, 0.14)
mix = music + sfx
raw = np.abs(mix).max(); pre = 1.0 / raw            # в tanh заходим почти линейно: мягкое ограничение только пиков
music *= pre; sfx *= pre; mix *= pre
print('raw peak before limiter: %.2f' % raw)
g = 0.5 / np.abs(np.tanh(mix * 1.1) / 1.1).max() * GAIN
def save(name, x):
    y = (np.clip(finish(x) * g, -1, 1) * 32767).astype('<i2')
    with wave.open(name, 'wb') as w: w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(y.tobytes())
save('music.wav', music); save('sfx.wav', sfx); save('mix.wav', mix)
m = finish(mix) * g
print('peak %.3f  rms %.1f dBFS  dur %.3f s' % (np.abs(m).max(), 20 * np.log10(np.sqrt((m ** 2).mean())), N / SR))
