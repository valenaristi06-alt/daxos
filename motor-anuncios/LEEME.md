# Motor de anuncios Método Hana
- engine.html: plantilla 1080x1920 (figura de la marca, textos con rebote, teléfono, tarjetas de quiz, CTA).
- v1.js / v2.js / v3.js: guion de cada video (función render(t) en segundos).
- render.py: `python3 render.py v1 stills 0 3 8` (cuadros de control) o `python3 render.py v1 video` (MP4 15 s, 30 fps, cuadro a cuadro).
- statics.py: estáticos 4:5.
- frames/: cuadros del video demo de la app. Generarlos con:
  `mkdir -p frames && ffmpeg -i ../video/demo.mp4 -vf fps=30,scale=540:-2 -q:v 3 frames/%04d.jpg`
- Requiere: python3, playwright (chromium), ffmpeg, Pillow, fuente Poppins.
