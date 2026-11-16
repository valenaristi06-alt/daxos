#!/usr/bin/env python3
# Verificación automática del UGC:
#  1) Sincronía: correlación cruzada del audio final vs referencia (voz recortada igual),
#     en ventanas de 1 s -> desfase máximo (ms). Debe ser < 40 ms.
#  2) Superposición: por cuadro, la caja de la cara de la presentadora no se cruza con
#     ningún texto/sticker (+40 px margen). Reporta cuadros fallados (debe ser 0).
# Uso: python3 scripts/verify-ugc.py <final.mp4> <presA.wav> <layout.json> <ffmpeg>
import sys, json, subprocess, tempfile, os
import numpy as np
from scipy.io import wavfile
from scipy.signal import correlate
import cv2

def load_wav_mono(path):
    sr, d = wavfile.read(path)
    if d.ndim > 1:
        d = d.mean(axis=1)
    d = d.astype(np.float64)
    if d.max() != 0:
        d = d / (np.abs(d).max() + 1e-9)
    return sr, d

def sync_check(final_mp4, ref_wav, ffmpeg):
    tmp = tempfile.mktemp(suffix='.wav')
    subprocess.run([ffmpeg, '-y', '-hide_banner', '-loglevel', 'error', '-i', final_mp4,
                    '-vn', '-ac', '1', '-ar', '44100', tmp], check=True)
    sr, fin = load_wav_mono(tmp)
    _, ref = load_wav_mono(ref_wav)
    os.remove(tmp)
    n = min(len(fin), len(ref))
    fin, ref = fin[:n], ref[:n]
    win = sr  # 1 s
    max_ms = 0.0
    worst_t = 0
    for i in range(0, n - win, win):
        a = fin[i:i+win]; b = ref[i:i+win]
        if np.std(a) < 1e-3 or np.std(b) < 1e-3:
            continue
        a = a - a.mean(); b = b - b.mean()
        c = correlate(a, b, mode='full')
        k = int(np.argmax(c))
        peak = c[k] / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9)
        if peak < 0.5:  # ventana sin voz clara (música/silencio) -> lag no confiable, se omite
            continue
        lag = k - (len(b) - 1)
        ms = abs(lag) / sr * 1000.0
        if ms > max_ms:
            max_ms = ms; worst_t = i / sr
    return max_ms, worst_t

def iou_overlap(face, rect, margin, W):
    fx, fy, fw, fh = face
    fx0, fy0, fx1, fy1 = fx - margin, fy - margin, fx + fw + margin, fy + fh + margin
    rx0, ry0, rx1, ry1 = rect
    return not (fx1 <= rx0 or rx1 <= fx0 or fy1 <= ry0 or ry1 <= fy0)

def active_rects(layout, t):
    out = []
    for r in layout['rects']:
        if r['a'] - 0.02 <= t <= r['b'] + 0.02:
            out.append((0, r['y0'], layout['W'], r['y1']))  # texto a lo ancho (conservador)
    return out

def in_spans(spans, t):
    return any(s[0] - 0.02 <= t <= s[1] + 0.02 for s in spans)

def overlap_check(final_mp4, layout):
    casc = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    cap = cv2.VideoCapture(final_mp4)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W, H = layout['W'], layout['H']
    faceSpans = [tuple(s) for s in layout.get('faceSpans', [])]
    pipSpans = [tuple(s) for s in layout.get('pipSpans', [])]
    pip = layout.get('pip')
    fails = []
    fi = -1
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        fi += 1
        t = fi / fps
        rects = active_rects(layout, t)
        if not rects:
            continue
        faces_to_check = []
        if in_spans(faceSpans, t):
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            det = casc.detectMultiScale(gray, 1.1, 6, minSize=(140, 140))
            if len(det):
                faces_to_check.append(max(det, key=lambda f: f[2]*f[3]))
        if pip and in_spans(pipSpans, t):
            faces_to_check.append((pip['x'], pip['y'], pip['size'], pip['size']))
        for fc in faces_to_check:
            for r in rects:
                if iou_overlap(fc, r, 40, W):
                    fails.append(round(t, 2))
                    break
    cap.release()
    return sorted(set(fails))

def word_check(orig_mp4, pres_wav, words_final, ffmpeg):
    tmp = tempfile.mktemp(suffix='.wav')
    subprocess.run([ffmpeg, '-y', '-hide_banner', '-loglevel', 'error', '-i', orig_mp4,
                    '-vn', '-ac', '1', '-ar', '44100', tmp], check=True)
    sr, orig = load_wav_mono(tmp)
    _, pres = load_wav_mono(pres_wav)
    os.remove(tmp)
    W = int(0.06*sr)  # búsqueda ±60 ms alrededor del tiempo esperado (incluye d=0 exacto)
    step = max(1, int(sr*0.001))
    clipped = []
    for w in words_final:
        if w.get('nStart') is None:
            continue
        o0, o1 = int(w['oStart']*sr), int(w['oEnd']*sr)
        oseg = orig[o0:o1]
        if len(oseg) < sr*0.08:
            continue
        n0 = int(w['nStart']*sr)
        a = oseg - oseg.mean(); na = np.linalg.norm(a) + 1e-9
        best = 0.0
        offs = set(range(-W, W+1, step)); offs.add(0)  # asegurar la posición exacta d=0
        for d in sorted(offs):
            s = n0 + d
            if s < 0 or s + len(oseg) > len(pres):
                continue
            b = pres[s:s+len(oseg)]; b = b - b.mean()
            ncc = float(np.dot(a, b) / (na * (np.linalg.norm(b)+1e-9)))
            if ncc > best:
                best = ncc
        if best < 0.75:
            clipped.append(w['w'])
    return clipped

def main():
    final_mp4, ref_wav, layout_json, ffmpeg = sys.argv[1:5]
    layout = json.load(open(layout_json))
    max_ms, worst_t = sync_check(final_mp4, ref_wav, ffmpeg)
    fails = overlap_check(final_mp4, layout)
    clipped = []
    if len(sys.argv) >= 7:
        clipped = word_check(sys.argv[5], ref_wav, json.load(open(sys.argv[6])), ffmpeg)
    res = {'sync_max_ms': round(max_ms, 1), 'sync_worst_t': round(worst_t, 2),
           'overlap_fail_frames': len(fails),
           'clipped_words': len(clipped), 'clipped_list': clipped[:20]}
    print(json.dumps(res))
    ok = max_ms < 40 and len(fails) == 0 and len(clipped) == 0
    sys.exit(0 if ok else 2)

if __name__ == '__main__':
    main()
