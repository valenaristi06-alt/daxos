#!/usr/bin/env python3
# Detecta la cara de la presentadora por cuadro (OpenCV Haar) y guarda su caja.
# Uso: python3 scripts/face-detect.py <video> <out.json> [step]
import sys, json
import cv2

def main():
    vid = sys.argv[1]
    out = sys.argv[2]
    step = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    casc = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    cap = cv2.VideoCapture(vid)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    boxes = []
    fi = -1
    last = None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        fi += 1
        if fi % step != 0:
            continue
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = casc.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(120, 120))
        if len(faces):
            x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
            last = [int(x), int(y), int(w), int(h)]
        box = last  # si no detecta, repite el último
        if box:
            boxes.append({'f': fi, 't': round(fi / fps, 3), 'x': box[0], 'y': box[1], 'w': box[2], 'h': box[3]})
    cap.release()
    # stats (mediana)
    import statistics as st
    med = {}
    if boxes:
        for k in ('x', 'y', 'w', 'h'):
            med[k] = int(st.median([b[k] for b in boxes]))
    data = {'fps': fps, 'count': len(boxes), 'median': med,
            'srcW': int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) if False else None, 'boxes': boxes}
    with open(out, 'w') as f:
        json.dump(data, f)
    print(f"faces: {len(boxes)} cuadros; mediana {med}")

if __name__ == '__main__':
    main()
