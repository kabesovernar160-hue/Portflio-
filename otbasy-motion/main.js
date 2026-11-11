// Отбасы — motion. Детерминированный таймлайн: window.renderAt(t) рисует кадр для времени t.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import * as opentype from 'opentype';

const W = 1920, H = 1080, FPS = 60, DURATION = 22;
const params = new URLSearchParams(location.search);
const SUB = +(params.get('sub') || 4);          // субкадры для motion blur
const SHUTTER = 0.55;                           // доля кадра
const USE_DOF = params.get('dof') !== '0';

// ---------- утилиты ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => a + (b - a) * k;
const prog = (t, t0, d) => clamp((t - t0) / d);
const smooth = (x) => x * x * (3 - 2 * x);
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
const easeInCubic = (x) => x * x * x;
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOutBack = (x, s = 1.70158) => 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2);
const spring = (dt, amp = 1, damp = 9, freq = 28) => (dt < 0 ? 0 : amp * Math.exp(-dt * damp) * Math.cos(dt * freq));
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const col = (h) => new THREE.Color(h);
function lerpColors(stops, k) { // stops: [[pos, hex], ...]
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i], [p1, c1] = stops[i + 1];
    if (k <= p1 || i === stops.length - 2) return col(c0).lerp(col(c1), smooth(clamp((k - p0) / (p1 - p0))));
  }
}

// ---------- расписание событий (общее для картинки и звука) ----------
const STACKS = [];
for (const z of [0.65, -0.65]) for (const x of [-1.3, 0, 1.3]) STACKS.push({ x, z });
const COIN_H = 0.13, COIN_R = 0.5;
const EV = { coins: [], bonus: [], houses: [], windows: [13.5, 13.75, 14.0], family: [14.5, 14.75, 15.0] };
{
  const r = rng(7);
  const order = [];
  for (let level = 0; level < 5; level++) {
    const idx = [0, 1, 2, 3, 4, 5].sort(() => r() - 0.5);
    for (const s of idx) order.push({ s, level });
  }
  // первая монета — из шанырака в центральную переднюю стопку
  const fi = order.findIndex((o) => o.s === 1 && o.level === 0);
  order.unshift(order.splice(fi, 1)[0]);
  order.forEach((o, i) => EV.coins.push({ ...o, t: i === 0 ? 4.0 : 4.375 + (i - 1) * 0.125 }));
  [1, 0, 2, 4, 3, 5].forEach((s, i) => EV.bonus.push({ s, level: 5, t: 8.0 + i * 0.25 }));
}
const T = { coinLaunch: 3.35, firstCoin: 4.0, bonus: 8.0, build: 12.0, roof: 13.0, village: 16.0, title: 18.0 };

// ---------- рендерер ----------
const glCanvas = document.createElement('canvas');
glCanvas.width = W; glCanvas.height = H;
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xffc9a0, 90, 620);
const camera = new THREE.PerspectiveCamera(38, W / H, 0.3, 1200);

const hemi = new THREE.HemisphereLight(0xffe2c4, 0x5a4a3a, 0.9);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffd2a0, 2.6);
key.position.set(-14, 22, 18);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 90 });
key.shadow.bias = -0.0006; key.shadow.normalBias = 0.03; key.shadow.radius = 4;
scene.add(key);
const rim = new THREE.DirectionalLight(0xffa066, 1.2); // контровой от солнца
rim.position.set(4, 10, -30);
scene.add(rim);

// ---------- небо ----------
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { top: { value: col('#2b2a5e') }, mid: { value: col('#ff9a6a') }, hor: { value: col('#ffd0a0') }, sunDir: { value: new THREE.Vector3(0, 0.2, -1) }, glow: { value: col('#fff0c0') } },
  vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `varying vec3 vDir; uniform vec3 top, mid, hor, glow, sunDir;
    void main(){ vec3 d = normalize(vDir); float h = clamp(d.y, 0.0, 1.0);
      vec3 c = mix(hor, mid, smoothstep(0.0, 0.16, h)); c = mix(c, top, smoothstep(0.1, 0.62, h));
      float s = max(dot(d, normalize(sunDir)), 0.0);
      c += glow * (pow(s, 60.0) * 0.22 + pow(s, 8.0) * 0.05);
      gl_FragColor = vec4(c, 1.0); }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), skyMat);
sky.userData.noDepth = true;
scene.add(sky);

// ---------- земля, орнамент ----------
const groundMat = new THREE.MeshLambertMaterial({ color: 0xcaa560 });
const ground = new THREE.Mesh(new THREE.CircleGeometry(700, 64), groundMat);
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
scene.add(ground);

function ornamentTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 1024;
  const g = c.getContext('2d'); g.translate(512, 512);
  g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineCap = 'round';
  g.lineWidth = 10; g.beginPath(); g.arc(0, 0, 470, 0, 7); g.stroke();
  g.lineWidth = 4; g.beginPath(); g.arc(0, 0, 446, 0, 7); g.stroke();
  g.lineWidth = 6; g.beginPath(); g.arc(0, 0, 300, 0, 7); g.stroke();
  const N = 12;
  for (let i = 0; i < N; i++) { // «қошқар мүйіз» — бараньи рога
    g.save(); g.rotate((i / N) * Math.PI * 2);
    g.lineWidth = 11;
    g.beginPath(); g.moveTo(0, -312); g.lineTo(0, -372); g.stroke();
    for (const s of [-1, 1]) {
      g.beginPath();
      for (let k = 0; k <= 40; k++) { const a = (k / 40) * Math.PI * 1.9; const rr = 34 * (1 - k / 52);
        const cx = s * 36, cy = -384; const x = cx - s * Math.cos(a) * rr, y = cy - Math.sin(a) * rr + (k / 40) * 6;
        k ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
    }
    g.rotate(Math.PI / N); g.beginPath(); g.moveTo(0, -300); g.lineTo(13, -325); g.lineTo(0, -350); g.lineTo(-13, -325); g.closePath(); g.fill();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
const ornament = new THREE.Mesh(new THREE.PlaneGeometry(13, 13),
  new THREE.MeshBasicMaterial({ map: ornamentTexture(), transparent: true, opacity: 0, depthWrite: false, color: 0xfff1cf }));
ornament.rotation.x = -Math.PI / 2; ornament.position.y = 0.02; ornament.userData.noDepth = true;
scene.add(ornament);

// ударные кольца пыли
function makeRing() {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 64), new THREE.MeshBasicMaterial({ color: 0xfff3d6, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.04; m.userData.noDepth = true; scene.add(m); return m;
}
const ringCoin = makeRing(), ringRoof = makeRing(), ringBonus = makeRing();

// ---------- горы, облака, трава ----------
{
  const r = rng(21);
  const rock = new THREE.MeshLambertMaterial({ color: 0x4d4585, flatShading: true });
  const snow = new THREE.MeshLambertMaterial({ color: 0xfff4ee, flatShading: true });
  for (let row = 0; row < 3; row++) for (let i = 0; i < 26; i++) {
    const x = -330 + i * 26 + (r() - 0.5) * 18; const h = (16 + r() * 26 + row * 8) * (0.4 + 0.6 * smooth(clamp((Math.abs(x) - 30) / 110))), rad = h * (0.8 + r() * 0.5);
    const z = -190 - row * 34 - r() * 14;
    const m = new THREE.Mesh(new THREE.ConeGeometry(rad, h, 5 + Math.floor(r() * 3)), rock);
    m.position.set(x, h / 2 - 1, z); m.rotation.y = r() * 6;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.36, h * 0.36, 5), snow);
    cap.position.y = h * 0.325; m.add(cap);
    scene.add(m);
  }
}
const clouds = [];
{
  const r = rng(5);
  const cm = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, emissive: 0xffc9b0, emissiveIntensity: 0.25 });
  for (let i = 0; i < 9; i++) {
    const g = new THREE.Group();
    const n = 3 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      const s = 2 + r() * 2.6;
      const p = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 1), cm);
      p.position.set((k - n / 2) * 3 + r(), (r() - 0.5) * 1.2, (r() - 0.5) * 2); p.scale.y = 0.6; g.add(p);
    }
    g.position.set(-110 + i * 27 + r() * 10, 24 + r() * 22, -60 - r() * 90);
    g.userData.speed = 0.5 + r() * 0.7; g.userData.x0 = g.position.x;
    scene.add(g); clouds.push(g);
  }
}
{
  const r = rng(99);
  const N = 1400;
  const tuft = new THREE.InstancedMesh(new THREE.ConeGeometry(0.06, 0.3, 4), new THREE.MeshLambertMaterial({ color: 0x7d8f3a, flatShading: true }), N);
  const d = new THREE.Object3D();
  for (let i = 0; i < N; i++) {
    const a = r() * Math.PI * 2, rad = 4.5 + Math.pow(r(), 0.7) * 60;
    d.position.set(Math.cos(a) * rad, 0.18, Math.sin(a) * rad); if (Math.abs(d.position.x) < 9 && d.position.z > 7.5 && d.position.z < 16) d.position.z += 12; if (d.position.z > 1.2 && d.position.z < 5.5 && Math.abs(d.position.x) < 9.5) d.position.z += 5; d.rotation.set((r() - 0.5) * 0.5, r() * 6, (r() - 0.5) * 0.5);
    const s = 0.6 + r() * 1.4; d.scale.set(s, s * (0.7 + r()), s); d.updateMatrix(); tuft.setMatrixAt(i, d.matrix);
  }
  tuft.receiveShadow = true; scene.add(tuft);
  const stone = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.3, 0), new THREE.MeshLambertMaterial({ color: 0xa7998a, flatShading: true }), 60);
  for (let i = 0; i < 60; i++) {
    const a = r() * Math.PI * 2, rad = 6 + r() * 40;
    d.position.set(Math.cos(a) * rad, 0.05, Math.sin(a) * rad); if (Math.abs(d.position.x) < 10 && d.position.z > 4 && d.position.z < 22) d.position.x += d.position.x < 0 ? -12 : 12; d.rotation.set(r() * 6, r() * 6, r() * 6);
    const s = 0.4 + r() * 1.3; d.scale.set(s, s * 0.6, s); d.updateMatrix(); stone.setMatrixAt(i, d.matrix);
  }
  stone.castShadow = true; stone.receiveShadow = true; scene.add(stone);
}
// пылинки в воздухе — близкий план для параллакса
const motes = [];
{
  const r = rng(3);
  const g = new THREE.SphereGeometry(0.035, 6, 4), m = new THREE.MeshBasicMaterial({ color: 0xfff2c8, transparent: true, opacity: 0.85 });
  for (let i = 0; i < 130; i++) {
    const p = new THREE.Mesh(g, m);
    p.userData = { x: (r() - 0.5) * 34, y: 0.4 + r() * 7, z: -10 + r() * 34, ph: r() * 6, sp: 0.3 + r() * 0.6, s: 0.5 + r() * 1.6 };
    p.scale.setScalar(p.userData.s); scene.add(p); motes.push(p);
  }
}

// ---------- шанырак-солнце ----------
const SUN = new THREE.Vector3(0, 47, -320); const SUN_S = 1.8;
const shanyrak = new THREE.Group();
{
  const mat = new THREE.MeshBasicMaterial({ color: 0xffbf3a, fog: false });
  const R = 14;
  shanyrak.add(new THREE.Mesh(new THREE.TorusGeometry(R, 1.25, 10, 64), mat));
  shanyrak.add(new THREE.Mesh(new THREE.TorusGeometry(R * 0.985, 0.5, 8, 64), new THREE.MeshBasicMaterial({ color: 0xffc35a, fog: false })));
  for (const rot of [0, Math.PI / 2]) for (const off of [-3.6, 0, 3.6]) {
    const half = Math.sqrt(R * R - off * off);
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(-half, off, 0), new THREE.Vector3(0, off, 6), new THREE.Vector3(half, off, 0));
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.55, 8), mat);
    tube.rotation.z = rot; shanyrak.add(tube);
  }
  for (let i = 0; i < 24; i++) { // зубцы-уыки по ободу
    const a = (i / 24) * Math.PI * 2;
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.7, 3.2, 0.7), mat);
    s.position.set(Math.cos(a) * (R + 2.4), Math.sin(a) * (R + 2.4), 0); s.rotation.z = a - Math.PI / 2; shanyrak.add(s);
  }
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, 'rgba(255,244,200,0.75)'); gr.addColorStop(0.25, 'rgba(255,200,120,0.3)'); gr.addColorStop(1, 'rgba(255,170,90,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true }));
  glow.scale.setScalar(110); glow.position.z = -4; glow.userData.noDepth = true; shanyrak.add(glow); shanyrak.userData.glow = glow;
  shanyrak.traverse((o) => { o.userData.noDepth = true; });
  scene.add(shanyrak);
}

// ---------- текст: настоящие экструдированные буквы из Inter ----------
const fonts = {};
async function loadFont(name, url) { fonts[name] = opentype.parse(await (await fetch(url)).arrayBuffer()); }
const geoCache = new Map();
function glyphGeometry(fontName, ch, depth) {
  const k = fontName + ch + depth;
  if (geoCache.has(k)) return geoCache.get(k);
  const font = fonts[fontName], glyph = font.charToGlyph(ch);
  const path = glyph.getPath(0, 0, 1);
  const sp = new THREE.ShapePath();
  for (const c of path.commands) {
    if (c.type === 'M') sp.moveTo(c.x, -c.y);
    else if (c.type === 'L') sp.lineTo(c.x, -c.y);
    else if (c.type === 'Q') sp.quadraticCurveTo(c.x1, -c.y1, c.x, -c.y);
    else if (c.type === 'C') sp.bezierCurveTo(c.x1, -c.y1, c.x2, -c.y2, c.x, -c.y);
  }
  const shapes = SVGLoader.createShapes(sp);
  let geo = null;
  if (shapes.length) {
    geo = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.008, bevelSegments: 2, curveSegments: 8 });
    geo.translate(0, 0, -depth);
  }
  const out = { geo, adv: glyph.advanceWidth / font.unitsPerEm, glyph };
  geoCache.set(k, out); return out;
}
function makeText(str, { font = 'black', size = 1, depth = 0.22, front = 0xfffaf0, side = 0x0e6b63, tracking = 0, emissive = 0.36 } = {}) {
  const group = new THREE.Group();
  const mats = [
    new THREE.MeshLambertMaterial({ color: front, emissive: front, emissiveIntensity: emissive }),
    new THREE.MeshLambertMaterial({ color: side }),
  ];
  const f = fonts[font]; let x = 0; const letters = [];
  const chars = [...str];
  chars.forEach((ch, i) => {
    const { geo, adv, glyph } = glyphGeometry(font, ch, depth);
    if (geo) {
      const pivot = new THREE.Group();
      const mesh = new THREE.Mesh(geo, mats); mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.position.x = -adv / 2; pivot.add(mesh);
      pivot.position.x = x + adv / 2; pivot.userData.i = letters.length; pivot.userData.x0 = pivot.position.x;
      group.add(pivot); letters.push(pivot);
    }
    x += adv + tracking + (ch === ' ' ? 0.16 : 0);
    if (i < chars.length - 1) x += f.getKerningValue(glyph, f.charToGlyph(chars[i + 1])) / f.unitsPerEm;
  });
  const width = x - tracking;
  letters.forEach((l) => { l.position.x -= width / 2; l.userData.x0 = l.position.x; });
  const wrap = new THREE.Group(); group.scale.setScalar(size); wrap.add(group);
  wrap.userData = { letters, width: width * size, mats };
  return wrap;
}
// буквы поднимаются с земли (откидываются вперёд, как таблички) и падают назад на выходе
function animText(tx, t, tin, tout, { stagger = 0.06, dur = 0.55, hopT = -1, hopAmp = 0 } = {}) {
  const L = tx.userData.letters;
  tx.visible = t >= tin && t < tout + 0.5 + L.length * 0.03;
  if (!tx.visible) return;
  L.forEach((l, i) => {
    const os = Math.min(0.03, 0.22 / L.length); const p = prog(t, tin + i * stagger, dur), q = prog(t, tout + i * os, 0.4);
    const up = easeOutBack(p, 2.2);
    l.rotation.x = (1 - up) * (-Math.PI / 2) - easeInCubic(q) * (Math.PI / 2) * 1.02;
    const s = clamp(p * 6) * (1 - prog(t, tout + i * os + 0.34, 0.1));
    l.scale.setScalar(Math.max(s, 0.0001));
    l.position.y = (hopT >= 0 ? Math.max(0, spring(t - hopT - i * 0.015, hopAmp, 10, 26)) : 0);
    l.visible = p > 0;
  });
}

// ---------- монеты ----------
function tengeTexture(bg, fg) {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = fg; g.lineWidth = 9; g.beginPath(); g.arc(128, 128, 104, 0, 7); g.stroke();
  g.fillStyle = fg; g.fillRect(78, 74, 100, 16); g.fillRect(78, 104, 100, 16); g.fillRect(119, 104, 18, 88); // знак ₸
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
const coinGeo = new THREE.CylinderGeometry(COIN_R, COIN_R, COIN_H * 0.92, 40);
const goldSide = new THREE.MeshStandardMaterial({ color: 0xffbe2e, roughness: 0.4, metalness: 0.35, emissive: 0xb86a00, emissiveIntensity: 0.4 });
const goldTop = new THREE.MeshStandardMaterial({ map: tengeTexture('#ffd044', '#b96d00'), roughness: 0.35, metalness: 0.3, emissive: 0xa85e00, emissiveIntensity: 0.35 });
const bonusSide = new THREE.MeshStandardMaterial({ color: 0x14b9ad, roughness: 0.3, metalness: 0.5, emissive: 0x18e0d0, emissiveIntensity: 0.7 });
const bonusTop = new THREE.MeshStandardMaterial({ map: tengeTexture('#3fe8da', '#087a72'), roughness: 0.3, metalness: 0.4, emissive: 0x18e0d0, emissiveIntensity: 0.55 });
const coinsRoot = new THREE.Group(); scene.add(coinsRoot);
const coins = [];
function addCoin(ev, bonus, i) {
  const m = new THREE.Mesh(coinGeo, bonus ? [bonusSide, bonusTop, bonusTop] : [goldSide, goldTop, goldTop]);
  m.castShadow = true; m.receiveShadow = true;
  const st = STACKS[ev.s], r = rng(100 + i + (bonus ? 500 : 0));
  m.userData = { ...ev, bonus, x: st.x + (r() - 0.5) * 0.07, z: st.z + (r() - 0.5) * 0.07, y: COIN_H * (ev.level + 0.5), yaw: (r() - 0.5) * 0.5, ax: (r() - 0.5) * 2, az: (r() - 0.5) * 2, spin: 2 + r() * 3, first: !bonus && i === 0 };
  coinsRoot.add(m); coins.push(m);
}
EV.coins.forEach((e, i) => addCoin(e, false, i));
EV.bonus.forEach((e, i) => addCoin(e, true, i));

// ---------- дом ----------
const house = new THREE.Group(); scene.add(house);
const HW = 4.5, HH = 2.5, HD = 3.1;
const wallMat = new THREE.MeshLambertMaterial({ color: 0xfff1dc });
const roofMat = new THREE.MeshLambertMaterial({ color: 0xd9512f });
const tealMat = new THREE.MeshLambertMaterial({ color: 0x0e6b63 });
const winMat = () => new THREE.MeshLambertMaterial({ color: 0x35424f, emissive: 0xffc24a, emissiveIntensity: 0 });
function roofGeometry(w, h, d) {
  const s = new THREE.Shape(); s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(0, h); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false }); g.translate(0, 0, -d / 2); return g;
}
const walls = new THREE.Mesh(new THREE.BoxGeometry(HW, HH, HD).translate(0, HH / 2, 0), wallMat);
walls.castShadow = walls.receiveShadow = true; house.add(walls);
const plinth = new THREE.Mesh(new THREE.BoxGeometry(HW + 0.3, 0.22, HD + 0.3).translate(0, 0.11, 0), tealMat);
plinth.castShadow = plinth.receiveShadow = true; house.add(plinth);
const roof = new THREE.Group(); house.add(roof);
{
  const r = new THREE.Mesh(roofGeometry(HW + 0.9, 1.75, HD + 0.7), roofMat); r.castShadow = r.receiveShadow = true; roof.add(r);
  const ch = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.2, 0.5), wallMat); ch.position.set(1.25, 1.1, -0.5); ch.castShadow = true; roof.add(ch);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.16, 0.66), tealMat); cap.position.set(1.25, 1.74, -0.5); roof.add(cap);
  // круглое окошко-шанырак на фронтоне
  const att = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.07, 8, 28), tealMat); att.position.set(0, 0.68, (HD + 0.7) / 2 + 0.02); roof.add(att);
  for (const rz of [0, Math.PI / 2]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.05), tealMat); b.position.copy(att.position); b.rotation.z = rz; roof.add(b); }
}
const door = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.45, 0.1).translate(0, 0.725, 0), tealMat);
door.position.set(0, 0.22, HD / 2 + 0.03); house.add(door);
const knob = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), goldSide); knob.position.set(0.26, 0.72, 0.08); door.add(knob);
const windows = [];
for (const x of [-1.42, 1.42, 0]) {
  const g = new THREE.Group();
  const side = x === 0; // третье «окно» — свет над дверью
  const fw = side ? 0.8 : 1.0, fh = side ? 0.3 : 1.0;
  const frame = new THREE.Mesh(new THREE.BoxGeometry(fw + 0.16, fh + 0.16, 0.08), tealMat);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(fw, fh, 0.1), winMat());
  g.add(frame, glass);
  if (!side) for (const rz of [0, Math.PI / 2]) { const b = new THREE.Mesh(new THREE.BoxGeometry(fw, 0.06, 0.13), tealMat); b.rotation.z = rz; g.add(b); }
  g.position.set(x, side ? 1.95 : 1.35, HD / 2 + 0.03); g.userData.glass = glass; house.add(g); windows.push(g);
}
const houseLight = new THREE.PointLight(0xffb84a, 0, 9, 1.6); houseLight.position.set(0, 1.2, 3.2); house.add(houseLight);

// семья
const family = [];
{
  const defs = [{ x: 2.9, z: 2.5, h: 1.25, c: 0x0e8f84 }, { x: 3.65, z: 2.7, h: 1.12, c: 0xd9512f }, { x: 3.3, z: 3.25, h: 0.7, c: 0xffc531 }];
  for (const d of defs) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(d.h * 0.2, d.h * 0.42, 6, 14), new THREE.MeshLambertMaterial({ color: d.c }));
    body.position.y = d.h * 0.41; body.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(d.h * 0.17, 16, 12), new THREE.MeshLambertMaterial({ color: 0xf2c9a0 }));
    head.position.y = d.h * 0.92; head.castShadow = true;
    g.add(body, head); g.position.set(d.x, 0, d.z); scene.add(g); family.push(g);
  }
}

// посёлок
const village = [];
{
  const r = rng(42);
  const roofCols = [0xd9512f, 0x0e8f84, 0xe58a2b, 0x2f7fb8, 0xc7433a];
  const P = [[-9.5, -4.5], [9.5, -5.5], [-15, -11], [15, -12], [-5.5, -11.5], [5.5, -12.5], [0, -20], [-21, -3.5], [21, -4.5], [-11, -20], [11, -21], [-27, -15], [27, -16], [-16.5, 2.2], [16.5, 1.8], [-33, -6], [33, -7], [-20, -26], [20, -27], [0, -31]];
  P.forEach(([x, z], i) => {
    const g = new THREE.Group(); const s = 0.62 + r() * 0.3;
    const w = new THREE.Mesh(new THREE.BoxGeometry(HW, HH, HD).translate(0, HH / 2, 0), wallMat); w.castShadow = w.receiveShadow = true;
    const rf = new THREE.Mesh(roofGeometry(HW + 0.9, 1.75, HD + 0.7), new THREE.MeshLambertMaterial({ color: roofCols[i % roofCols.length] }));
    rf.position.y = HH; rf.castShadow = true;
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.45, 0.1).translate(0, 0.725, 0), tealMat); d.position.z = HD / 2 + 0.03;
    g.add(w, rf, d);
    for (const wx of [-1.42, 1.42]) { const gl = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.1), new THREE.MeshLambertMaterial({ color: 0x35424f, emissive: 0xffc24a, emissiveIntensity: 1.3 })); gl.position.set(wx, 1.35, HD / 2 + 0.03); g.add(gl); }
    g.position.set(x, 0, z); g.rotation.y = (r() - 0.5) * 0.5 - x * 0.012; g.userData = { s, t: T.village + 0.125 * i * 0.8, kind: 'house' };
    scene.add(g); village.push(g); EV.houses.push(g.userData.t);
  });
  const trunkM = new THREE.MeshLambertMaterial({ color: 0x7a5a3c }), leafM = new THREE.MeshLambertMaterial({ color: 0x3f9a5a, flatShading: true });
  for (let i = 0; i < 34; i++) {
    let x, z, ok = false, tries = 0;
    while (!ok && tries++ < 40) { x = (r() - 0.5) * 70; z = -34 + r() * 38; ok = Math.hypot(x, z) > 5.5 && P.every(([px, pz]) => Math.hypot(px - x, pz - z) > 3.6) && !(z > 3 && Math.abs(x) < 12); }
    const g = new THREE.Group(); const s = 0.8 + r() * 0.9;
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.9, 6).translate(0, 0.45, 0), trunkM);
    const lf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8, 0).translate(0, 1.45, 0), leafM); lf.scale.y = 1.25;
    tr.castShadow = lf.castShadow = true; g.add(tr, lf);
    g.position.set(x, 0, z); g.rotation.y = r() * 6; g.userData = { s, t: T.village + 0.2 + r() * 1.8, kind: 'tree' };
    scene.add(g); village.push(g);
  }
}

// ---------- постобработка ----------
// лёгкий DOF: глубина берётся из основного прохода (без повторного рендера сцены), 16 выборок по спирали
class DofPass extends Pass {
  constructor() {
    super();
    this.uniforms = { tDiffuse: { value: null }, tDepth: { value: null }, near: { value: camera.near }, far: { value: camera.far }, focus: { value: 10 }, k: { value: 0.07 }, maxblur: { value: 0.006 }, aspect: { value: W / H } };
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `#include <packing>
        varying vec2 vUv; uniform sampler2D tDiffuse, tDepth; uniform float near, far, focus, k, maxblur, aspect;
        float dist(vec2 uv){ return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, near, far); }
        float coc(float d){ return min(k * abs(1.0 / focus - 1.0 / d), maxblur); }
        void main(){
          float d0 = dist(vUv), c0 = coc(d0);
          vec4 acc = texture2D(tDiffuse, vUv); float wsum = 1.0;
          if (c0 > 0.0004) {
            for (int i = 1; i <= 16; i++) {
              float fi = float(i); float r = sqrt(fi / 16.0) * c0; float a = fi * 2.39996323;
              vec2 uv = vUv + vec2(cos(a), sin(a) * aspect) * r;
              float ds = dist(uv); float w = ds > d0 - 0.6 ? 1.0 : smoothstep(0.0, 1.0, coc(ds) / (r + 1e-5));
              acc += texture2D(tDiffuse, uv) * w; wsum += w;
            }
          }
          gl_FragColor = acc / wsum;
        }`,
    }));
  }
  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture; this.uniforms.tDepth.value = readBuffer.depthTexture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer); this.quad.render(renderer);
  }
}
const mkRT = () => new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(W, H) });
const composer = new EffectComposer(renderer, mkRT());
composer.renderTarget2.dispose(); composer.renderTarget2 = mkRT(); composer.writeBuffer = composer.renderTarget1; composer.readBuffer = composer.renderTarget2;
composer.addPass(new RenderPass(scene, camera));
const bokeh = new DofPass();
if (USE_DOF) composer.addPass(bokeh);
composer.addPass(new OutputPass());

const out = document.getElementById('out');
const octx = out.getContext('2d');
const acc = document.createElement('canvas'); acc.width = W; acc.height = H;
const actx = acc.getContext('2d');

// ---------- камера: непрерывная траектория по ключам (Catmull-Rom во времени) ----------
// [t, позиция, цель, фокус-расстояние (0 = до цели)]
const CAM = [
  [0.0, [1.5, 2.2, 17], [0, 15, -150]],
  [1.3, [-2.6, 3.9, 13.5], [0, 2.6, -8]],
  [3.2, [2.4, 3.7, 12.0], [0.2, 2.4, -8]],
  [4.05, [2.2, 2.1, 9.0], [-0.6, 0.9, 0]],
  [6.0, [-3.3, 2.5, 10.4], [-2.6, 1.05, 0]],
  [7.8, [-0.8, 2.9, 10.8], [-1.2, 1.2, 0]],
  [9.3, [3.0, 3.1, 10.6], [2.9, 1.15, 0.5]],
  [11.8, [5.6, 4.0, 10.8], [3.1, 0.85, 0.9]],
  [12.9, [2.0, 3.4, 12.0], [0, 2.0, 0]],
  [14.6, [-4.4, 3.7, 13.4], [-3.1, 1.6, 0]],
  [16.0, [-3.4, 3.7, 15.0], [-1.8, 2.2, 0]],
  [18.4, [0, 5.9, 25.5], [0, 2.7, 0]],
  [22.0, [1.2, 6.4, 26.6], [0, 2.5, 0]],
];
function camAt(t, out) {
  let i = 0; while (i < CAM.length - 2 && t > CAM[i + 1][0]) i++;
  const k0 = CAM[Math.max(i - 1, 0)], k1 = CAM[i], k2 = CAM[i + 1], k3 = CAM[Math.min(i + 2, CAM.length - 1)];
  const u = clamp((t - k1[0]) / (k2[0] - k1[0])), dt = k2[0] - k1[0];
  for (const ch of [1, 2]) for (let a = 0; a < 3; a++) {
    const m1 = k1 === k0 ? 0 : ((k2[ch][a] - k0[ch][a]) / (k2[0] - k0[0])) * dt;
    const m2 = k3 === k2 ? 0 : ((k3[ch][a] - k1[ch][a]) / (k3[0] - k1[0])) * dt;
    const u2 = u * u, u3 = u2 * u;
    out[ch - 1][a] = (2 * u3 - 3 * u2 + 1) * k1[ch][a] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * k2[ch][a] + (u3 - u2) * m2;
  }
}
const camBuf = [[0, 0, 0], [0, 0, 0]];

// ---------- тексты ----------
let TX = {};
function buildTexts() {
  TX.otbasy = makeText('ОТБАСЫ', { size: 3.3, depth: 0.2, tracking: 0.02 }); TX.otbasy.position.set(0, 0, -8);
  TX.semya = makeText('по-казахски — «семья»', { font: 'bold', size: 0.92, depth: 0.12, front: 0xffd45a, side: 0x8a4a00 }); TX.semya.position.set(0, 0, -1.6);
  TX.kopi = makeText('КОПИ', { size: 1.9, depth: 0.2 }); TX.kopi.position.set(-4.7, 0, 0.2); TX.kopi.rotation.y = 0.2;
  TX.kopi2 = makeText('на своё жильё', { font: 'bold', size: 0.62, depth: 0.12, front: 0xffd45a, side: 0x8a4a00 }); TX.kopi2.position.set(-4.5, 0, 2.0); TX.kopi2.rotation.y = 0.2;
  TX.pct = new THREE.Group(); TX.pct.position.set(4.9, 0, 0.2); TX.pct.rotation.y = -0.2; TX.pct.userData.cache = {};
  TX.prem = makeText('премия государства', { font: 'bold', size: 0.5, depth: 0.12, front: 0xfffaf0, side: 0x0e6b63 }); TX.prem.position.set(4.6, 0.53, 3.3); TX.prem.rotation.y = -0.2;
  TX.prem2 = makeText('до 20% в год', { font: 'bold', size: 0.5, depth: 0.12, front: 0x7ff3e8, side: 0x0e6b63 }); TX.prem2.position.set(4.6, 0, 3.3); TX.prem2.rotation.y = -0.2;
  TX.ipo = makeText('ИПОТЕКА', { size: 1.32, depth: 0.2 }); TX.ipo.position.set(-6.1, 0, 0.6); TX.ipo.rotation.y = 0.22;
  TX.ipo2 = makeText('по сниженной ставке', { font: 'bold', size: 0.56, depth: 0.12, front: 0xffd45a, side: 0x8a4a00 }); TX.ipo2.position.set(-5.8, 0, 2.7); TX.ipo2.rotation.y = 0.22;
  TX.title = makeText('ОТБАСЫ БАНК', { size: 2.0, depth: 0.24, tracking: 0.01 }); TX.title.position.set(0, 0, 9);
  for (const k in TX) scene.add(TX[k]);
  for (let n = 0; n <= 20; n++) { // счётчик +N%
    const g = makeText('+' + n + '%', { size: 2.0, depth: 0.22, front: 0x5ff0e3, side: 0x0a5f58, emissive: 0.45 });
    g.visible = false; TX.pct.add(g); TX.pct.userData.cache[n] = g;
  }
}

// ---------- обновление сцены на время t ----------
const v3 = new THREE.Vector3(); const firstCoinPos = new THREE.Vector3(); let moteCheck = false;
function update(t) {
  const day = clamp(t / 17);
  // свет и небо: рассвет → день
  skyMat.uniforms.top.value.copy(lerpColors([[0, '#2a2a66'], [0.45, '#3b6fc4'], [1, '#2f86d8']], day));
  skyMat.uniforms.mid.value.copy(lerpColors([[0, '#f7774f'], [0.45, '#ffb877'], [1, '#8cc8f0']], day));
  const horC = lerpColors([[0, '#ffb070'], [0.45, '#ffd9a0'], [1, '#d2ebfa']], day);
  skyMat.uniforms.hor.value.copy(horC); scene.fog.color.copy(horC);
  groundMat.color.copy(lerpColors([[0, '#a8824c'], [0.5, '#bfa658'], [1, '#9dbb62']], day));
  key.color.copy(lerpColors([[0, '#ffc38a'], [0.5, '#ffe2bd'], [1, '#fff6e6']], day));
  key.intensity = lerp(2.3, 3.0, day);
  hemi.color.copy(lerpColors([[0, '#ffd9c0'], [1, '#dff0ff']], day)); hemi.intensity = lerp(0.85, 1.15, day);
  rim.intensity = lerp(1.6, 0.5, day);

  // шанырак-солнце
  const rise = easeOutCubic(prog(t, 0, 2.2));
  shanyrak.position.set(SUN.x, lerp(-34, SUN.y, rise) + t * 0.4, SUN.z);
  shanyrak.rotation.z = t * 0.12;
  const pulse = 1 + 0.12 * Math.max(0, spring(t - T.coinLaunch, 1, 5, 14)) + 0.06 * Math.max(0, spring(t - T.title, 1, 4, 10));
  shanyrak.scale.setScalar(pulse * SUN_S);
  shanyrak.userData.glow.scale.setScalar(110 * (0.9 + 0.1 * Math.sin(t * 1.3)) * pulse);
  skyMat.uniforms.sunDir.value.copy(shanyrak.position).normalize();

  clouds.forEach((c) => { c.position.x = c.userData.x0 + t * c.userData.speed; });
  motes.forEach((m) => { const d = m.userData; m.position.set(d.x + Math.sin(t * d.sp + d.ph) * 0.6 + t * 0.12, d.y + Math.sin(t * d.sp * 0.7 + d.ph * 2) * 0.35, d.z + Math.cos(t * d.sp * 0.5 + d.ph) * 0.5); });
  moteCheck = true;

  // тексты
  animText(TX.otbasy, t, 0.95, 3.42, { stagger: 0.125, dur: 0.6 });
  animText(TX.semya, t, 2.0, 3.3, { stagger: 0.022, dur: 0.45 });
  let lastLand = -1; for (const e of EV.coins) if (e.t <= t) lastLand = e.t;
  animText(TX.kopi, t, 4.5, 7.95, { stagger: 0.09, hopT: t < 8 ? lastLand : -1, hopAmp: 0.045 });
  animText(TX.kopi2, t, 5.0, 7.9, { stagger: 0.025, dur: 0.45 });
  animText(TX.prem, t, 8.75, 11.68, { stagger: 0.02, dur: 0.45 });
  animText(TX.prem2, t, 8.5, 11.64, { stagger: 0.03, dur: 0.45 });
  animText(TX.ipo, t, 13.5, 16.4, { stagger: 0.06 });
  animText(TX.ipo2, t, 14.0, 16.5, { stagger: 0.02, dur: 0.45 });
  animText(TX.title, t, T.title, 99, { stagger: 0.05, dur: 0.6 });
  // счётчик процентов: растёт с каждой бонусной монетой
  {
    let n = 0, lastB = -1;
    EV.bonus.forEach((e, i) => { if (t >= e.t) { lastB = e.t; n = Math.round(((i + 1) / 6) * 20); } });
    if (lastB >= 0 && n < 20) { const nxt = Math.round(((EV.bonus.filter((e) => e.t <= t).length + 1) / 6) * 20); n = Math.round(lerp(n, nxt, clamp((t - lastB) / 0.25) * 0.8)); }
    const cache = TX.pct.userData.cache;
    for (const k in cache) cache[k].visible = false;
    const cur = cache[n];
    const vis = t >= T.bonus - 0.02;
    if (vis) { animText(cur, t, T.bonus - 0.02, 11.72, { stagger: 0.02, dur: 0.01 }); cur.visible = t < 12.2;
      const inS = easeOutBack(prog(t, T.bonus, 0.4), 2.5), punch = 1 + Math.max(0, spring(t - lastB, 0.13, 9, 30));
      TX.pct.scale.set(inS * punch, inS * (2 - punch) * (1 + Math.max(0, spring(t - lastB, 0.1, 9, 30))), inS); }
    TX.pct.visible = vis;
  }

  // монеты
  const build = prog(t, T.build, 0.75);
  coinsRoot.visible = t < T.build + 0.6;
  for (const c of coins) {
    const d = c.userData; let dt = t - d.t;
    if (d.first) {
      const p = prog(t, T.coinLaunch, T.firstCoin - T.coinLaunch);
      c.visible = t >= T.coinLaunch;
      if (p < 1) {
        const e = Math.pow(p, 1.5);
        v3.copy(shanyrak.position).lerp(new THREE.Vector3(d.x, d.y, d.z), e); v3.y += Math.sin(p * Math.PI) * 4 * (1 - p);
        c.position.copy(v3); firstCoinPos.copy(v3); c.scale.setScalar(lerp(42, 1, Math.pow(p, 0.6)) * clamp(p * 10));
        c.rotation.set((1 - p) * (Math.PI / 2 + Math.PI * 4), d.yaw, 0); continue;
      }
    }
    const fall = 0.42;
    c.visible = dt > -fall;
    if (!c.visible) continue;
    let y = d.y, rx = 0, rz = 0, s = 1;
    if (dt < 0) { const p = 1 + dt / fall; y = d.y + (1 - p * p) * (d.bonus ? 9 : 7.5); rx = (1 - p) * d.spin * d.ax * 2.2; rz = (1 - p) * d.spin * d.az * 2.2; s = clamp(p * 5); }
    else { y += Math.abs(spring(dt, 0.16, 9, 22)); rx = spring(dt, 0.12, 10, 30) * d.ax; }
    // реакция стопки на следующие монеты сверху
    let sq = 0; for (const o of coins) { const od = o.userData; if (od.s === d.s && od.level > d.level) sq += spring(t - od.t, 0.035, 11, 34); }
    y -= sq * (d.level + 1) * 0.35;
    if (d.bonus) { const g = 0.6 + Math.max(0, spring(dt, 1.6, 4, 0)); bonusSide.emissiveIntensity = Math.max(bonusSide.emissiveIntensity, 0); c.scale.setScalar(s * (1 + Math.max(0, spring(dt, 0.12, 8, 24)))); c.userData.glow = g; }
    else c.scale.setScalar(s);
    if (build > 0) { const k = easeInCubic(build); c.scale.multiplyScalar(1 + 0.18 * Math.sin(build * Math.PI)); y += k * 0.4 * d.level; }
    c.position.set(d.x, y, d.z); c.rotation.set(rx, d.yaw, rz);
  }
  bonusSide.emissiveIntensity = 0.7 + 0.5 * Math.pow(Math.max(0, Math.sin((t - 8) * Math.PI * 2)), 6);
  bonusTop.emissiveIntensity = 0.55 + 0.5 * Math.pow(Math.max(0, Math.sin((t - 8) * Math.PI * 2)), 6);
  goldSide.emissiveIntensity = 0.35 + 1.4 * Math.sin(prog(t, T.build - 0.25, 0.9) * Math.PI);
  goldTop.emissiveIntensity = 0.3 + 1.4 * Math.sin(prog(t, T.build - 0.25, 0.9) * Math.PI);

  // кольца и орнамент
  const ringAnim = (ring, t0, x, z, r0, r1, dur) => { const p = prog(t, t0, dur); ring.visible = p > 0 && p < 1; ring.position.x = x; ring.position.z = z; ring.scale.setScalar(lerp(r0, r1, easeOutCubic(p))); ring.material.opacity = 0.5 * (1 - p) * (1 - p); };
  ringAnim(ringCoin, T.firstCoin, 0, 0.65, 0.5, 8.5, 0.9);
  ringAnim(ringBonus, T.bonus, 0, 0, 1.5, 7, 0.8);
  ringAnim(ringRoof, T.roof, 0, 0, 2.5, 11, 1.0);
  {
    const p = prog(t, T.firstCoin + 0.05, 0.9), e = easeOutBack(p, 1.2);
    ornament.scale.setScalar(Math.max(e, 0.001) * (1 + 0.03 * Math.max(0, spring(t - T.roof, 1, 6, 16))));
    ornament.rotation.z = -1.2 * (1 - easeOutCubic(prog(t, T.firstCoin, 2.5))) + t * 0.015;
    ornament.material.opacity = 0.42 * clamp(p * 3) * lerp(1, 0.75, day);
    ornament.visible = p > 0;
  }

  // дом
  {
    const wp = prog(t, T.build + 0.05, 0.7);
    const roofP = prog(t, T.roof - 0.45, 0.45);
    const land = t - T.roof;
    const squash = land >= 0 ? spring(land, 0.09, 8, 22) : 0;
    house.visible = wp > 0;
    walls.scale.set(1 + squash * 0.5, Math.max(0.001, easeOutBack(wp, 1.4)) * (1 - squash), 1 + squash * 0.5);
    plinth.scale.setScalar(Math.max(0.001, easeOutBack(prog(t, T.build, 0.4), 2)));
    roof.visible = roofP > 0;
    roof.position.y = HH * (1 - squash) + (1 - roofP * roofP) * 14;
    roof.rotation.z = (1 - roofP) * 0.5 + (land >= 0 ? spring(land, 0.04, 7, 18) : 0);
    roof.rotation.y = (1 - easeOutCubic(roofP)) * 1.6;
    door.scale.setScalar(Math.max(0.001, easeOutBack(prog(t, T.build + 0.5, 0.3), 2.2)));
    windows.forEach((w, i) => {
      const t0 = EV.windows[i], p = prog(t, T.build + 0.42 + i * 0.1, 0.3);
      w.scale.setScalar(Math.max(0.001, easeOutBack(p, 2.6)) * (1 + Math.max(0, spring(t - t0, 0.16, 9, 26))));
      w.userData.glass.material.emissiveIntensity = t >= t0 ? 1.9 + 2.5 * Math.exp(-(t - t0) * 7) : 0;
    });
    houseLight.intensity = 14 * prog(t, 13.5, 0.6) * lerp(1, 0.4, prog(t, 16, 2));
    family.forEach((f, i) => {
      const t0 = EV.family[i], p = prog(t, t0, 0.35);
      f.visible = p > 0;
      const s = Math.max(0.001, easeOutBack(p, 2.4));
      const hop = Math.abs(Math.sin(Math.max(0, t - t0 - 0.2) * Math.PI * 2 + i)) * 0.14 * (1 - prog(t, 17.2, 1));
      f.scale.set(s, s * (1 + hop * 0.5), s); f.position.y = hop * 1.2;
      f.rotation.y = -0.25 + Math.sin(t * 2 + i) * 0.15;
    });
  }
  // посёлок
  village.forEach((g) => {
    const d = g.userData, p = prog(t, d.t, 0.5);
    g.visible = p > 0;
    const e = easeOutBack(p, d.kind === 'tree' ? 3 : 2);
    g.scale.set(d.s * (0.6 + 0.4 * e), d.s * Math.max(0.001, e), d.s * (0.6 + 0.4 * e));
  });

  // камера
  camAt(t, camBuf);
  const shake = Math.max(0, spring(t - T.firstCoin, 0.1, 9, 40)) + Math.max(0, spring(t - T.roof, 0.14, 8, 36));
  camera.position.set(camBuf[0][0], camBuf[0][1] + shake * Math.sin(t * 90), camBuf[0][2]);
  v3.set(camBuf[1][0], camBuf[1][1], camBuf[1][2]);
  { const p = prog(t, T.coinLaunch, T.firstCoin - T.coinLaunch); if (p > 0 && p < 1) v3.lerp(firstCoinPos, 0.72 * clamp(p * 4) * Math.pow(1 - p, 0.7)); }
  camera.lookAt(v3);
  camera.rotation.z += Math.sin(t * 0.7) * 0.006 + lerp(0.02, 0, prog(t, 0, 3)) - 0.012 * Math.sin(prog(t, 12, 4.5) * Math.PI);
  camera.fov = lerp(42, 38, smooth(prog(t, 0, 4))) + 2.0 * smooth(prog(t, 16, 2.4));
  camera.updateProjectionMatrix();
  motes.forEach((m) => { m.visible = m.position.distanceTo(camera.position) > 4.5; });
  // фокус: следует за смысловым объектом
  let focus = camera.position.distanceTo(v3);
  if (t < 3.6) focus = lerp(60, camera.position.distanceTo(TX.otbasy.position), smooth(prog(t, 0.3, 1.2)));
  if (t > 17.2) focus = lerp(focus, camera.position.distanceTo(TX.title.position), smooth(prog(t, 17.2, 1.0)));
  bokeh.uniforms.focus.value = focus - 0.8;
  bokeh.uniforms.k.value = lerp(0.05, 0.03, smooth(prog(t, 16.5, 2)));
}

// ---------- 2D-слой: слоган, дисклеймер, виньетка ----------
function overlay(t) {
  const g = octx;
  // виньетка
  const vg = g.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 1.05);
  vg.addColorStop(0, 'rgba(20,10,30,0)'); vg.addColorStop(1, 'rgba(20,10,30,0.34)');
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  // слоган
  const words = [['Копи.', 19.0], ['Получай премию.', 19.5], ['Живи в своём доме.', 20.0]];
  g.font = '700 50px "Inter Display", Inter, sans-serif'; g.textBaseline = 'alphabetic';
  const gap = 26; const ws = words.map((w) => g.measureText(w[0]).width);
  let x = (W - ws.reduce((a, b) => a + b, 0) - gap * 2) / 2;
  words.forEach(([w, t0], i) => {
    const p = prog(t, t0, 0.4);
    if (p > 0) { const e = easeOutBack(p, 1.8);
      g.save(); g.globalAlpha = clamp(p * 2.5); g.shadowColor = 'rgba(10,40,50,0.55)'; g.shadowBlur = 18; g.shadowOffsetY = 3;
      g.fillStyle = i === 1 ? '#7ff3e8' : '#ffffff'; g.fillText(w, x, 986 + (1 - e) * 34); g.restore(); }
    x += ws[i] + gap;
  });
  const dp = prog(t, 20.5, 0.6);
  if (dp > 0) { g.save(); g.globalAlpha = 0.78 * dp; g.font = '500 23px Inter, sans-serif'; g.textAlign = 'center'; g.shadowColor = 'rgba(10,40,50,0.6)'; g.shadowBlur = 10;
    g.fillStyle = '#fff'; g.fillText('Неофициальный ролик. Актуальные условия — на сайте банка.', W / 2, 1042); g.restore(); }
  // вход из чёрного и мягкий выход
  const fade = 1 - smooth(prog(t, 0, 0.5)) + smooth(prog(t, DURATION - 0.35, 0.35)) * 0.0;
  if (fade > 0) { g.fillStyle = `rgba(8,6,20,${fade})`; g.fillRect(0, 0, W, H); }
}

const JIT = [[-0.25, -0.375], [0.375, -0.125], [-0.375, 0.125], [0.25, 0.375], [0, 0], [0.125, -0.25]];
function renderAt(t) {
  actx.globalCompositeOperation = 'source-over';
  for (let s = 0; s < SUB; s++) {
    const ts = t + ((s + 0.5) / SUB - 0.5) * SHUTTER / FPS;
    update(Math.max(0, ts));
    const J = JIT[s % JIT.length]; camera.setViewOffset(W, H, SUB > 1 ? J[0] : 0, SUB > 1 ? J[1] : 0, W, H);
    composer.render();
    actx.globalAlpha = 1 / (s + 1);
    actx.drawImage(glCanvas, 0, 0);
  }
  actx.globalAlpha = 1;
  octx.drawImage(acc, 0, 0);
  overlay(t);
}

await Promise.all([loadFont('black', './fonts/InterDisplay-Black.otf'), loadFont('bold', './fonts/Inter-Bold.otf'), document.fonts.load('700 50px "Inter Display"'), document.fonts.load('500 23px Inter')]);
buildTexts();
window.EVENTS = { ...EV, T, DURATION, FPS };
window.DURATION = DURATION; window.FPS = FPS;
window.renderAt = renderAt;
window.READY = true;
