// Generates the 5 missing brand images as on-brand SVG figures, rasterized to WebP.
// Style matches mov-*.webp: ciruela #4a2a4f rounded stick figures with white halo,
// hair bun, soft radial pink background, floor shadow. Faceless (consistent w/ brand).
const fs = require('fs');
const sharp = require('sharp');

const PLUM = '#4a2a4f', ACC = '#c2456a', SOFT = '#fbe9ee', BG = '#fffaf5';
const CHAIR = '#cdbfb4', FLOOR = '#f0d8e0';

// background + floor shadow, reused by every scene
function bg(w, h) {
  return `
  <defs>
    <radialGradient id="g" cx="50%" cy="38%" r="70%">
      <stop offset="0" stop-color="${SOFT}"/>
      <stop offset="1" stop-color="${BG}"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <rect x="0" y="${h - 22}" width="${w}" height="22" fill="${FLOOR}"/>`;
}

// a limb = white halo stroke under a plum stroke (gives the gap/outline look)
function limb(pts, wdt) {
  const d = 'M' + pts.map(p => p.join(',')).join(' L');
  return `<path d="${d}" fill="none" stroke="#fff" stroke-width="${wdt + 9}" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="${d}" fill="none" stroke="${PLUM}" stroke-width="${wdt}" stroke-linecap="round" stroke-linejoin="round"/>`;
}
function headBun(cx, cy, r, bunSide) {
  const bx = cx + (bunSide >= 0 ? r * 0.8 : -r * 0.8);
  const by = cy - r * 0.75;
  return `
    <circle cx="${bx}" cy="${by}" r="${r * 0.55}" fill="#fff"/>
    <circle cx="${bx}" cy="${by}" r="${r * 0.48}" fill="${PLUM}"/>
    <circle cx="${cx}" cy="${cy}" r="${r + 4.5}" fill="#fff"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${PLUM}"/>`;
}

// standing figure. build: 'slim'|'mid'|'full'  pose: 'stand'|'armsUp'|'hand'
function figure(cx, feetY, scale, build, pose, bunSide = 1) {
  const s = scale;
  const bw = build === 'full' ? 44 : build === 'mid' ? 34 : 26;   // torso width
  const lw = build === 'full' ? 34 : build === 'mid' ? 28 : 22;   // limb width
  const hipSpread = build === 'full' ? 26 : build === 'mid' ? 20 : 15;
  const legLen = 150 * s, torsoLen = 120 * s, armLen = 95 * s, headR = 34 * s;

  const hipY = feetY - legLen;
  const shoulderY = hipY - torsoLen;
  const headCY = shoulderY - headR - 6 * s;

  const shW = bw * s * 0.5;          // shoulder offset from center
  const shY = shoulderY + 8 * s;     // shoulder y
  const slL = [cx - shW, shY], slR = [cx + shW, shY];
  const downL = [cx - hipSpread - lw * 0.3 * s, hipY - 6 * s];
  const downR = [cx + hipSpread + lw * 0.3 * s, hipY - 6 * s];

  let parts = [];
  // legs
  parts.push(limb([[cx - hipSpread, hipY], [cx - hipSpread - 6, feetY]], lw * s));
  parts.push(limb([[cx + hipSpread, hipY], [cx + hipSpread + 6, feetY]], lw * s));
  // feet
  parts.push(limb([[cx - hipSpread - 6, feetY], [cx - hipSpread - 30, feetY]], lw * s));
  parts.push(limb([[cx + hipSpread + 6, feetY], [cx + hipSpread + 30, feetY]], lw * s));
  // torso (slight belly curve for full build)
  if (build === 'full') {
    parts.push(limb([[cx, hipY], [cx + 12, hipY - torsoLen * 0.5], [cx, shoulderY]], bw * s));
  } else {
    parts.push(limb([[cx, hipY], [cx, shoulderY]], bw * s));
  }
  // arms — anchored at offset shoulders so they never cross the torso
  if (pose === 'armsUp') {
    parts.push(limb([slL, [cx - 52 * s, shoulderY - 45 * s], [cx - 66 * s, shoulderY - 118 * s]], lw * s));
    parts.push(limb([slR, [cx + 52 * s, shoulderY - 45 * s], [cx + 66 * s, shoulderY - 118 * s]], lw * s));
  } else if (pose === 'hand') {
    parts.push(limb([slL, downL], lw * s));
    parts.push(limb([slR, [cx + 58 * s, shoulderY - 35 * s], [cx + 72 * s, shoulderY - 96 * s]], lw * s)); // waving
  } else {
    parts.push(limb([slL, downL], lw * s));
    parts.push(limb([slR, downR], lw * s));
  }
  parts.push(headBun(cx, headCY, headR, bunSide));
  return parts.join('\n');
}

function chair(x, floorY) {
  const seatY = floorY - 150, w = 90, legW = 10;
  return `
    <rect x="${x}" y="${seatY}" width="${w}" height="16" rx="6" fill="${CHAIR}"/>
    <rect x="${x}" y="${seatY - 90}" width="14" height="92" rx="6" fill="${CHAIR}"/>
    <rect x="${x}" y="${seatY + 14}" width="14" height="${floorY - seatY - 14}" rx="5" fill="${CHAIR}"/>
    <rect x="${x + w - 14}" y="${seatY + 14}" width="14" height="${floorY - seatY - 14}" rx="5" fill="${CHAIR}"/>`;
}

// ---- scenes ----
const scenes = {
  'hero.webp': { w: 600, h: 800, svg(w, h) {
    const floorY = h - 22;
    return bg(w, h) + chair(60, floorY) + figure(w * 0.56, floorY, 1.5, 'mid', 'armsUp', 1);
  }},
  'grupo.webp': { w: 900, h: 675, svg(w, h) {
    const floorY = h - 22;
    return bg(w, h)
      + figure(w * 0.25, floorY, 1.25, 'full', 'stand', 1)
      + figure(w * 0.5,  floorY, 1.4,  'mid',  'hand', -1)
      + figure(w * 0.75, floorY, 1.2, 'slim', 'stand', 1);
  }},
  'biotipo-endo.webp': { w: 600, h: 450, svg(w, h) {
    return bg(w, h) + figure(w / 2, h - 22, 1.08, 'full', 'stand', 1);
  }},
  'biotipo-meso.webp': { w: 600, h: 450, svg(w, h) {
    return bg(w, h) + figure(w / 2, h - 22, 1.08, 'mid', 'stand', 1);
  }},
  'biotipo-ecto.webp': { w: 600, h: 450, svg(w, h) {
    return bg(w, h) + figure(w / 2, h - 22, 1.08, 'slim', 'stand', 1);
  }},
};

(async () => {
  for (const [name, c] of Object.entries(scenes)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${c.w}" height="${c.h}" viewBox="0 0 ${c.w} ${c.h}">${c.svg(c.w, c.h)}</svg>`;
    await sharp(Buffer.from(svg)).webp({ quality: 88 }).toFile('img/' + name);
    const kb = (fs.statSync('img/' + name).size / 1024).toFixed(1);
    console.log(name, c.w + 'x' + c.h, kb + 'KB');
  }
})();
