// Método Hana · dibujo de figura animada en SVG (vista lateral). Sin dependencias.
(function (g) {
  const NS = 'http://www.w3.org/2000/svg';
  const C = { near: '#5b3a5e', far: '#c6a8c4', skin: '#5b3a5e', mat: '#f3d9dc', prop: '#d8cbbf', ground: '#e9ddd3' };
  const lerp = (a, b, t) => a + (b - a) * t;
  const mix = (A, B, t) => { const o = {}; for (const k in A) o[k] = [lerp(A[k][0], B[k][0], t), lerp(A[k][1], B[k][1], t)]; return o; };
  function el(tag, attrs) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function limb(P, a, b, c, col, w) { return el('polyline', { points: [P[a], P[b], P[c]].map(p => p.join(',')).join(' '), fill: 'none', stroke: col, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); }
  function scene(svg, P, prop) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.appendChild(el('rect', { x: 8, y: 184, width: 184, height: 6, rx: 3, fill: C.mat }));
    if (prop === 'chair') {
      const x = P.hip[0] - 34;
      svg.appendChild(el('path', { d: `M${x - 6} 112 L${x - 6} 184 M${x - 6} 140 L${x + 26} 140 L${x + 26} 184`, stroke: C.prop, 'stroke-width': 5, fill: 'none', 'stroke-linecap': 'round' }));
    }
    if (prop === 'wall') svg.appendChild(el('rect', { x: Math.min(196, Math.max(P.hand_n[0], P.hand_f[0]) + 3), y: 30, width: 6, height: 156, rx: 2, fill: C.prop }));
    svg.appendChild(limb(P, 'neck', 'elbow_f', 'hand_f', C.far, 8));
    svg.appendChild(limb(P, 'hip', 'knee_f', 'ankle_f', C.far, 10));
    svg.appendChild(el('line', { x1: P.ankle_f[0], y1: P.ankle_f[1], x2: P.toe_f[0], y2: P.toe_f[1], stroke: C.far, 'stroke-width': 7, 'stroke-linecap': 'round' }));
    svg.appendChild(el('line', { x1: P.hip[0], y1: P.hip[1], x2: P.neck[0], y2: P.neck[1], stroke: C.near, 'stroke-width': 15, 'stroke-linecap': 'round' }));
    svg.appendChild(limb(P, 'hip', 'knee_n', 'ankle_n', '#fffaf6', 15));
    svg.appendChild(limb(P, 'hip', 'knee_n', 'ankle_n', C.near, 11));
    svg.appendChild(el('line', { x1: P.ankle_n[0], y1: P.ankle_n[1], x2: P.toe_n[0], y2: P.toe_n[1], stroke: C.near, 'stroke-width': 8, 'stroke-linecap': 'round' }));
    svg.appendChild(limb(P, 'neck', 'elbow_n', 'hand_n', '#fffaf6', 12.5));
    svg.appendChild(limb(P, 'neck', 'elbow_n', 'hand_n', C.near, 8.5));
    svg.appendChild(el('circle', { cx: P.head[0], cy: P.head[1], r: 10, fill: C.skin }));
    // moño (rodete) para que la figura se lea femenina sin rasgos
    const dx = P.head[0] - P.neck[0], dy = P.head[1] - P.neck[1], n = Math.hypot(dx, dy) || 1;
    svg.appendChild(el('circle', { cx: P.head[0] + dx / n * 9 - dy / n * 5, cy: P.head[1] + dy / n * 9 + dx / n * 5, r: 5.5, fill: C.skin }));
  }
  // anima entre A y B con vaivén suave; devuelve función para detener
  function animate(svg, ex, period) {
    period = period || 2600; let stop = false; const t0 = performance.now();
    (function f(now) {
      if (stop) return;
      const ph = ((now - t0) % period) / period;
      const t = 0.5 - 0.5 * Math.cos(ph * 2 * Math.PI);
      scene(svg, mix(ex.A, ex.B, t), ex.prop);
      requestAnimationFrame(f);
    })(t0);
    return () => { stop = true; };
  }
  g.HanaFig = { scene, animate, mix };
})(window);
