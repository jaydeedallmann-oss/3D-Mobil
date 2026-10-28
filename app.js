'use strict';
/* Gewässer-3D mobil – PWA. Lädt Gewässerpakete (.uwpaket) aus dem Desktop-Tool und zeigt sie offline
 * als 3D-Relief mit Luftbild, GPS-Standort und Hotspots. Keine Server, keine Messdaten verlassen das Gerät. */
(() => {
const $ = id => document.getElementById(id);
const VERSION = '0.1.0';
const fmt = (n, d = 1) => Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const toast = msg => { const c = $('depthChip'), t = $('depthText'); c.classList.remove('hidden'); t.textContent = msg; };

// ------------------------------------------------------------------ IndexedDB
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('uw-mobil', 1);
    r.onupgradeneeded = () => { const d = r.result;
      if (!d.objectStoreNames.contains('packages')) d.createObjectStore('packages', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('hotspots')) d.createObjectStore('hotspots', { keyPath: 'id' }).createIndex('pkg', 'pkgId');
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const store = (s, m) => db.transaction(s, m).objectStore(s);
const prom = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const dbPut = (s, v) => prom(store(s, 'readwrite').put(v));
const dbDel = (s, k) => prom(store(s, 'readwrite').delete(k));
const dbAll = s => prom(store(s, 'readonly').getAll());
const hotspotsFor = pkgId => prom(store('hotspots', 'readonly').index('pkg').getAll(IDBKeyRange.only(pkgId)));

// ------------------------------------------------------------------ Zustand
let current = null;          // {id, grid, geo, palette, aerial(bitmap), cx, cy}
let hotspots = [];
const exag = () => Number($('exag').value);

// ------------------------------------------------------------------ Three.js
let renderer, scene, camera, root, terrain = null, aerialMesh = null, waterMesh = null, gpsGroup = null, hotGroup;
let contourGroup = null, steepGroup = null, shoreLine = null;
let contourOn = true, contourInterval = 1, steepOn = false, steepPct = 20;
let needRender = true;
const cam = { az: 0.7, pol: 0.95, dist: 800, tx: 0, ty: 0, tz: 0, twoD: false };

function initThree() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor('#0f1f2b');
  $('scene').appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#eaf6ff', '#30414d', 2.0));
  const sun = new THREE.DirectionalLight('#ffffff', 1.6); sun.position.set(-0.6, 1, 0.4); scene.add(sun);
  camera = new THREE.PerspectiveCamera(55, 1, 1, 200000);
  root = new THREE.Group(); scene.add(root);
  hotGroup = new THREE.Group(); root.add(hotGroup);
  resize(); applyCam();
  setupPointer();
  const loop = () => { requestAnimationFrame(loop); if (needRender) { needRender = false; renderer.render(scene, camera); } };
  loop();
  window.addEventListener('resize', resize);
}
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); needRender = true;
}
function applyCam() {
  const p = cam.twoD ? 0.0001 : Math.max(0.03, Math.min(1.52, cam.pol)), sp = Math.sin(p), cp = Math.cos(p);
  camera.position.set(cam.tx + cam.dist * sp * Math.sin(cam.az), cam.ty + cam.dist * cp, cam.tz + cam.dist * sp * Math.cos(cam.az));
  camera.up.set(0, 1, 0); camera.lookAt(cam.tx, cam.ty, cam.tz); needRender = true;
}

// ---- Touch/Maus: ein Finger dreht, zwei Finger zoomen+schieben, Tipp = Hotspot
function setupPointer() {
  const el = renderer.domElement, pts = new Map(); let moved = 0, downT = 0, pinch = 0, panMid = null;
  el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0; downT = Date.now();
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); panMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; } });
  el.addEventListener('pointermove', e => { const p = pts.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
    if (pts.size === 1) { if (!cam.twoD) { cam.az -= dx * 0.006; cam.pol -= dy * 0.006; } else { panBy(dx, dy); } applyCam(); }
    else if (pts.size === 2) { const [a, b] = [...pts.values()]; const nd = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) cam.dist = Math.max(15, Math.min(60000, cam.dist * pinch / nd)); pinch = nd;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; if (panMid) panBy(mid.x - panMid.x, mid.y - panMid.y); panMid = mid; applyCam(); } });
  const up = e => { const wasTap = moved < 8 && Date.now() - downT < 350 && pts.size === 1; pts.delete(e.pointerId); if (pts.size < 2) { pinch = 0; panMid = null; }
    if (wasTap && hotMode) tryHotspot(e.clientX, e.clientY); };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', e => { e.preventDefault(); cam.dist = Math.max(15, Math.min(60000, cam.dist * (e.deltaY > 0 ? 1.1 : 0.9))); applyCam(); }, { passive: false });
}
function panBy(dx, dy) {
  const k = cam.dist / innerHeight * 1.6, right = new THREE.Vector3(Math.cos(cam.az), 0, -Math.sin(cam.az)), fwd = new THREE.Vector3(Math.sin(cam.az), 0, Math.cos(cam.az));
  cam.tx -= (right.x * dx - fwd.x * dy) * k; cam.tz -= (right.z * dx - fwd.z * dy) * k;
}

// ------------------------------------------------------------------ Szene bauen
function clearScene() {
  for (const m of [terrain, aerialMesh, waterMesh]) if (m) { root.remove(m); m.geometry.dispose(); if (m.material.map) m.material.map.dispose(); m.material.dispose(); }
  terrain = aerialMesh = waterMesh = null;
  disposeOverlays();
  if (gpsGroup) { root.remove(gpsGroup); gpsGroup = null; }
  while (hotGroup.children.length) { const c = hotGroup.children.pop(); c.geometry?.dispose(); c.material?.dispose(); }
}
function disposeOverlays() {
  if (contourGroup) { root.remove(contourGroup); contourGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); contourGroup = null; }
  if (steepGroup) { root.remove(steepGroup); steepGroup.geometry.dispose(); steepGroup.material.dispose(); steepGroup = null; }
  if (shoreLine) { root.remove(shoreLine); shoreLine.geometry.dispose(); shoreLine.material.dispose(); shoreLine = null; }
}
// Konturlinien per Marching Squares aus dem Tiefenraster (jede 5. kräftig).
function buildContours() {
  if (contourGroup) { root.remove(contourGroup); contourGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); contourGroup = null; }
  if (!contourOn || !current) return;
  const g = current.grid, cs = g.cellSize, cx = current.cx, cy = current.cy, ex = exag(), V = g.values, nx = g.nx, ny = g.ny, iv = contourInterval;
  let mn = Infinity, mx = -Infinity; for (const v of V) if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!Number.isFinite(mn)) return;
  const minor = [], major = [], X = i => g.x0 + i * cs - cx, Z = j => -(g.y0 + j * cs - cy);
  const k0 = Math.ceil(mn / iv), k1 = Math.floor(mx / iv), maxLevels = 120;
  for (let k = k0; k <= k1 && (k - k0) < maxLevels; k++) {
    const L = k * iv, out = (k % 5 === 0) ? major : minor, y = -L * ex + 0.12;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = V[j * nx + i], b = V[j * nx + i + 1], c = V[(j + 1) * nx + i], d = V[(j + 1) * nx + i + 1];
      if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d))) continue;
      const pts = [], xi = X(i), xi1 = X(i + 1), zj = Z(j), zj1 = Z(j + 1);
      const edge = (va, vb, xa, za, xb, zb) => { if ((va < L) !== (vb < L)) { const t = (L - va) / (vb - va); pts.push(xa + (xb - xa) * t, za + (zb - za) * t); } };
      edge(a, b, xi, zj, xi1, zj); edge(b, d, xi1, zj, xi1, zj1); edge(d, c, xi1, zj1, xi, zj1); edge(c, a, xi, zj1, xi, zj);
      if (pts.length === 4) { out.push(pts[0], y, pts[1], pts[2], y, pts[3]); }
      else if (pts.length === 8) { out.push(pts[0], y, pts[1], pts[2], y, pts[3], pts[4], y, pts[5], pts[6], y, pts[7]); }
    }
  }
  contourGroup = new THREE.Group();
  const add = (arr, color, op) => { if (!arr.length) return; const geom = new THREE.BufferGeometry(); geom.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); contourGroup.add(new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color, transparent: true, opacity: op }))); };
  add(minor, '#19323f', 0.5); add(major, '#0a1b24', 0.92);
  root.add(contourGroup); needRender = true;
}
// Steile Flächen (physikalische Neigung in %, ohne Überhöhung) violett überlegen.
function buildSteep() {
  if (steepGroup) { root.remove(steepGroup); steepGroup.geometry.dispose(); steepGroup.material.dispose(); steepGroup = null; }
  if (!steepOn || !current) return;
  const g = current.grid, cs = g.cellSize, cx = current.cx, cy = current.cy, ex = exag(), V = g.values, nx = g.nx, ny = g.ny, thr = steepPct / 100;
  const pos = [], X = i => g.x0 + i * cs - cx, Z = j => -(g.y0 + j * cs - cy);
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = V[j * nx + i], b = V[j * nx + i + 1], c = V[(j + 1) * nx + i], d = V[(j + 1) * nx + i + 1];
    if (!(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d))) continue;
    const gx = ((b - a) + (d - c)) / (2 * cs), gy = ((c - a) + (d - b)) / (2 * cs);
    if (Math.hypot(gx, gy) < thr) continue;
    const xi = X(i), xi1 = X(i + 1), zj = Z(j), zj1 = Z(j + 1);
    pos.push(xi, -a * ex + 0.2, zj, xi, -c * ex + 0.2, zj1, xi1, -b * ex + 0.2, zj,
             xi1, -b * ex + 0.2, zj, xi, -c * ex + 0.2, zj1, xi1, -d * ex + 0.2, zj1);
  }
  needRender = true; if (!pos.length) return;
  const geom = new THREE.BufferGeometry(); geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  steepGroup = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: '#9b4dff', transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
  root.add(steepGroup);
}
// Ufergrenze als Linie (falls im Paket).
function buildShore() {
  if (shoreLine) { root.remove(shoreLine); shoreLine.geometry.dispose(); shoreLine.material.dispose(); shoreLine = null; }
  const b = current && current.boundary; if (!b) return;
  const geom = b.type === 'Feature' ? b.geometry : b, polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates, pos = [];
  for (const poly of polys) for (const ring of poly) for (let i = 0; i < ring.length - 1; i++) {
    const p = scenePos(ring[i][1], ring[i][0], 0.3), q = scenePos(ring[i + 1][1], ring[i + 1][0], 0.3);
    pos.push(p.x, p.y, p.z, q.x, q.y, q.z);
  }
  if (!pos.length) return;
  const g2 = new THREE.BufferGeometry(); g2.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  shoreLine = new THREE.LineSegments(g2, new THREE.LineBasicMaterial({ color: '#ffb24d' })); root.add(shoreLine); needRender = true;
}
function buildTerrain() {
  const g = current.grid, cs = g.cellSize, cx = current.cx, cy = current.cy, V = g.values, nx = g.nx, ny = g.ny, ex = exag(), bands = current.palette;
  const pos = new Float32Array(nx * ny * 3), col = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const k = j * nx + i, d = V[k], ok = Number.isFinite(d);
    pos[k * 3] = g.x0 + i * cs - cx; pos[k * 3 + 1] = ok ? -d * ex : 0; pos[k * 3 + 2] = -(g.y0 + j * cs - cy);
    const rgb = UWColors.colorRGB(ok ? d : 0, bands); col[k * 3] = rgb[0] / 255; col[k * 3 + 1] = rgb[1] / 255; col[k * 3 + 2] = rgb[2] / 255; }
  const idx = [];
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    const fa = Number.isFinite(V[a]), fb = Number.isFinite(V[b]), fc = Number.isFinite(V[c]), fd = Number.isFinite(V[d]);
    if (fa && fb && fc) idx.push(a, c, b); if (fb && fc && fd) idx.push(b, c, d); }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geom.setIndex(idx); geom.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide });
  const m = new THREE.Mesh(geom, mat); m.name = 'terrain'; return m;
}
function buildMasks() {
  const bmp = current.aerial, W = bmp.width, H = bmp.height, g = current.grid, geo = current.geo, b = current.aerialBounds;
  const ac = document.createElement('canvas'); ac.width = W; ac.height = H; const actx = ac.getContext('2d'); actx.drawImage(bmp, 0, 0);
  const aimg = actx.getImageData(0, 0, W, H), a = aimg.data;
  const wc = document.createElement('canvas'); wc.width = W; wc.height = H; const wctx = wc.getContext('2d'); const wimg = wctx.createImageData(W, H), w = wimg.data;
  const dw = b.east - b.west, dh = b.north - b.south;
  for (let py = 0; py < H; py++) { const lat = b.north - (py + 0.5) / H * dh, y = (lat - geo.lat0) * geo.metersPerLat, j = Math.round((y - g.y0) / g.cellSize);
    for (let px = 0; px < W; px++) { const lon = b.west + (px + 0.5) / W * dw, x = (lon - geo.lon0) * geo.metersPerLon, i = Math.round((x - g.x0) / g.cellSize);
      const water = i >= 0 && i < g.nx && j >= 0 && j < g.ny && Number.isFinite(g.values[j * g.nx + i]); const o = (py * W + px) * 4;
      if (water) { a[o + 3] = 0; w[o] = 40; w[o + 1] = 110; w[o + 2] = 150; w[o + 3] = 255; } } }
  actx.putImageData(aimg, 0, 0); wctx.putImageData(wimg, 0, 0);
  const at = new THREE.CanvasTexture(ac), wt = new THREE.CanvasTexture(wc);
  if ('SRGBColorSpace' in THREE) at.colorSpace = THREE.SRGBColorSpace;
  return { at, wt };
}
function groundPlane(tex, water) {
  const b = current.aerialBounds, cx = current.cx, cy = current.cy, geo = current.geo;
  const xW = (b.west - geo.lon0) * geo.metersPerLon - cx, xE = (b.east - geo.lon0) * geo.metersPerLon - cx;
  const yS = (b.south - geo.lat0) * geo.metersPerLat, yN = (b.north - geo.lat0) * geo.metersPerLat, zN = -(yN - cy), zS = -(yS - cy), Y = water ? 0.06 : 0;
  const pos = new Float32Array([xW, Y, zN, xE, Y, zN, xW, Y, zS, xE, Y, zS]), uv = new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]);
  const geom = new THREE.BufferGeometry(); geom.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geom.setIndex([0, 2, 1, 1, 2, 3]); geom.computeVertexNormals();
  const mat = water
    ? new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.5, roughness: 1, side: THREE.DoubleSide });
  return new THREE.Mesh(geom, mat);
}
function fitCamera() {
  const g = current.grid, R = Math.hypot((g.nx - 1) * g.cellSize, (g.ny - 1) * g.cellSize) / 2;
  cam.tx = 0; cam.tz = 0; cam.ty = 0; cam.dist = Math.max(60, R * 2.3); cam.az = 0.7; cam.pol = 0.95; applyCam();
}
function buildScene() {
  clearScene();
  const g = current.grid;
  current.cx = g.x0 + (g.nx - 1) * g.cellSize / 2; current.cy = g.y0 + (g.ny - 1) * g.cellSize / 2;
  if (current.aerial) { const { at, wt } = buildMasks(); aerialMesh = groundPlane(at, false); waterMesh = groundPlane(wt, true); root.add(aerialMesh); root.add(waterMesh); waterMesh.visible = $('waterBtn').classList.contains('on'); }
  terrain = buildTerrain(); root.add(terrain);
  buildContours(); buildSteep(); buildShore();
  drawHotspots(); fitCamera();
}
function rebuildTerrain() { if (!current) return; if (terrain) { root.remove(terrain); terrain.geometry.dispose(); terrain.material.dispose(); } terrain = buildTerrain(); root.add(terrain); buildContours(); buildSteep(); drawHotspots(); updateGpsMarker(); needRender = true; }

// ------------------------------------------------------------------ Georeferenz
const toLocal = (lat, lon) => ({ x: (lon - current.geo.lon0) * current.geo.metersPerLon, y: (lat - current.geo.lat0) * current.geo.metersPerLat });
const fromScene = (X, Z) => { const x = X + current.cx, y = current.cy - Z; return { lat: current.geo.lat0 + y / current.geo.metersPerLat, lon: current.geo.lon0 + x / current.geo.metersPerLon }; };
function sampleDepth(lat, lon) {
  const g = current.grid, p = toLocal(lat, lon), fi = (p.x - g.x0) / g.cellSize, fj = (p.y - g.y0) / g.cellSize, i = Math.floor(fi), j = Math.floor(fj);
  if (i < 0 || j < 0 || i >= g.nx - 1 || j >= g.ny - 1) return null;
  const V = g.values, d00 = V[j * g.nx + i], d10 = V[j * g.nx + i + 1], d01 = V[(j + 1) * g.nx + i], d11 = V[(j + 1) * g.nx + i + 1];
  if (![d00, d10, d01, d11].every(Number.isFinite)) return null;
  const tx = fi - i, ty = fj - j; return (d00 * (1 - tx) + d10 * tx) * (1 - ty) + (d01 * (1 - tx) + d11 * tx) * ty;
}
const scenePos = (lat, lon, y = 0) => { const p = toLocal(lat, lon); return new THREE.Vector3(p.x - current.cx, y, -(p.y - current.cy)); };

// ------------------------------------------------------------------ GPS
let watchId = null, follow = false, lastPos = null;
function toggleGps() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; follow = false; $('gpsBtn').classList.remove('on'); $('gpsDot').classList.remove('ok'); toast('GPS aus'); if (gpsGroup) { root.remove(gpsGroup); gpsGroup = null; needRender = true; } return; }
  if (!navigator.geolocation) return toast('Kein GPS verfügbar');
  $('gpsBtn').classList.add('on'); toast('GPS startet …'); follow = true;
  watchId = navigator.geolocation.watchPosition(onPos, err => toast('GPS: ' + err.message), { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
}
function onPos(pos) {
  lastPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
  $('gpsDot').classList.add('ok');
  const d = sampleDepth(lastPos.lat, lastPos.lon);
  $('depthText').innerHTML = d === null ? 'außerhalb der Karte' : 'Tiefe unter mir <b>' + fmt(d, 1) + ' m</b>';
  updateGpsMarker();
  if (follow) { const p = scenePos(lastPos.lat, lastPos.lon); cam.tx = p.x; cam.tz = p.z; applyCam(); }
}
function updateGpsMarker() {
  if (!current || !lastPos) return;
  if (gpsGroup) { root.remove(gpsGroup); gpsGroup = null; }
  const d = sampleDepth(lastPos.lat, lastPos.lon), base = scenePos(lastPos.lat, lastPos.lon, 0), bottomY = d === null ? 0 : -d * exag();
  const grp = new THREE.Group();
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(base.x, 2, base.z), new THREE.Vector3(base.x, bottomY, base.z)]), new THREE.LineBasicMaterial({ color: '#ff3b30' }));
  const head = new THREE.Mesh(new THREE.ConeGeometry(Math.max(3, current.grid.cellSize * 0.8), Math.max(8, current.grid.cellSize * 2), 16), new THREE.MeshStandardMaterial({ color: '#ff3b30', roughness: .5 }));
  head.position.set(base.x, 2 + Math.max(8, current.grid.cellSize * 2) / 2, base.z);
  grp.add(line, head); if (d !== null) { const dot = new THREE.Mesh(new THREE.SphereGeometry(Math.max(2.5, current.grid.cellSize * 0.6), 12, 10), new THREE.MeshStandardMaterial({ color: '#ffd60a' })); dot.position.set(base.x, bottomY, base.z); grp.add(dot); }
  gpsGroup = grp; root.add(grp); needRender = true;
}

// ------------------------------------------------------------------ Hotspots
let hotMode = false;
function tryHotspot(clientX, clientY) {
  if (!terrain) return;
  const rc = new THREE.Raycaster(), ndc = new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  rc.setFromCamera(ndc, camera); const hit = rc.intersectObject(terrain, false)[0];
  if (!hit) return toast('Kein Grund getroffen – näher heranzoomen');
  const ll = fromScene(hit.point.x, hit.point.z), d = sampleDepth(ll.lat, ll.lon);
  $('hotCoord').textContent = ll.lat.toFixed(6) + ' / ' + ll.lon.toFixed(6) + (d !== null ? ' · ' + fmt(d, 1) + ' m' : '');
  $('hotName').value = ''; $('hotDlg').dataset.lat = ll.lat; $('hotDlg').dataset.lon = ll.lon; $('hotDlg').showModal();
}
async function saveHotspot() {
  const lat = Number($('hotDlg').dataset.lat), lon = Number($('hotDlg').dataset.lon), name = $('hotName').value.trim() || 'Hotspot';
  const h = { id: crypto.randomUUID(), pkgId: current.id, name, lat, lon };
  hotspots.push(h); await dbPut('hotspots', h); $('hotDlg').close(); drawHotspots(); renderHotList(); setHotMode(false);
}
function drawHotspots() {
  while (hotGroup.children.length) { const c = hotGroup.children.pop(); c.geometry?.dispose(); c.material?.dispose(); }
  for (const h of hotspots) { const d = sampleDepth(h.lat, h.lon), p = scenePos(h.lat, h.lon, 0), bY = d === null ? 0 : -d * exag();
    const r = Math.max(2.5, current.grid.cellSize * 0.7);
    const pin = new THREE.Mesh(new THREE.ConeGeometry(r, r * 3, 12), new THREE.MeshStandardMaterial({ color: '#39d0ff', roughness: .5 }));
    pin.position.set(p.x, bY + r * 1.6, p.z); pin.rotation.x = Math.PI; hotGroup.add(pin); }
  needRender = true;
}
function renderHotList() {
  const box = $('hotList'); box.replaceChildren();
  if (!hotspots.length) { box.innerHTML = '<p class="tiny">Noch keine Hotspots. Unten „＋ Hotspot“ antippen und in die Karte tippen.</p>'; return; }
  for (const h of hotspots) { const row = document.createElement('div'); row.className = 'hot';
    const d = sampleDepth(h.lat, h.lon); const label = document.createElement('div'); label.className = 'name'; label.textContent = h.name + (d !== null ? ' · ' + fmt(d, 1) + ' m' : '');
    const go = document.createElement('button'); go.textContent = 'zeigen'; go.onclick = () => { const p = scenePos(h.lat, h.lon); cam.tx = p.x; cam.tz = p.z; cam.dist = Math.max(60, cam.dist); applyCam(); closeMenu(); };
    const del = document.createElement('button'); del.textContent = '✕'; del.onclick = async () => { hotspots = hotspots.filter(x => x.id !== h.id); await dbDel('hotspots', h.id); drawHotspots(); renderHotList(); };
    row.append(label, go, del); box.appendChild(row); }
}
function setHotMode(on) { hotMode = on; $('hotBtn').classList.toggle('on', on); if (on) toast('In die Karte tippen, um einen Hotspot zu setzen'); }

// ------------------------------------------------------------------ Pakete
async function importFile(file) {
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = UWPackage.parse(bytes);
    const rec = { id: crypto.randomUUID(), name: parsed.manifest.name, created: parsed.manifest.created, added: Date.now(), bytes };
    await dbPut('packages', rec); await renderPkgList(); await loadPackage(rec);
  } catch (e) { alert('Konnte die Datei nicht lesen: ' + e.message); }
}
async function loadPackage(rec) {
  const parsed = UWPackage.parse(rec.bytes);
  current = { id: rec.id, grid: parsed.grid, geo: parsed.geo, palette: (parsed.palette && parsed.palette.length) ? parsed.palette : UWColors.naturgrund(), aerial: null, aerialBounds: parsed.aerial ? parsed.aerial.bounds : null, boundary: parsed.boundary || null };
  if (parsed.aerialBytes) { try { current.aerial = await createImageBitmap(new Blob([parsed.aerialBytes], { type: 'image/jpeg' })); } catch { current.aerial = null; } }
  hotspots = await hotspotsFor(rec.id);
  $('welcome').classList.add('hidden'); $('topbar').classList.remove('hidden'); $('dock').classList.remove('hidden'); $('depthChip').classList.remove('hidden');
  $('pkgTitle').textContent = rec.name; $('depthText').textContent = 'GPS aus'; $('gpsDot').classList.remove('ok');
  await dbPut('meta', { k: 'last', id: rec.id });
  buildScene(); renderHotList(); renderPkgList(); closeMenu();
}
async function renderPkgList() {
  const box = $('pkgList'); box.replaceChildren();
  const all = (await dbAll('packages')).sort((a, b) => b.added - a.added);
  if (!all.length) { box.innerHTML = '<p class="tiny" style="margin:8px 0">Noch keine Gewässer gespeichert.</p>'; return; }
  for (const rec of all) { const row = document.createElement('div'); row.className = 'pkg';
    const name = document.createElement('div'); name.className = 'name'; name.innerHTML = rec.name + '<div class="meta">' + (rec.created || '') + ' · ' + (rec.bytes.length / 1048576).toFixed(1) + ' MB' + (current && current.id === rec.id ? ' · geladen' : '') + '</div>';
    const open = document.createElement('button'); open.textContent = 'öffnen'; open.onclick = () => loadPackage(rec);
    const del = document.createElement('button'); del.textContent = '✕'; del.onclick = async () => { if (!confirm('„' + rec.name + '“ vom Gerät löschen?')) return; await dbDel('packages', rec.id); for (const h of await hotspotsFor(rec.id)) await dbDel('hotspots', h.id); if (current && current.id === rec.id) { current = null; location.reload(); } await renderPkgList(); };
    row.append(name, open, del); box.appendChild(row); }
}

// ------------------------------------------------------------------ Menü/Dialoge
const openMenu = () => { $('menuSheet').classList.add('open'); renderPkgList(); renderHotList(); };
const closeMenu = () => $('menuSheet').classList.remove('open');

const GUIDE = [
  ['Willkommen', 'Das ist dein Gewässer als 3D-Relief mit Luftbild – offline nutzbar. Lade zuerst ein Gewässerpaket (.uwpaket), das du im Desktop-Tool „Unterwasserwelt 3D“ unter „Export → Gewässerpaket fürs Handy“ erzeugt hast.'],
  ['Drehen & Zoomen', 'Ein Finger dreht die Ansicht, zwei Finger zoomen und verschieben. Mit „2D/3D“ wechselst du zwischen Schrägansicht und Draufsicht.'],
  ['Wasser & Höhe', '„Wasser“ blendet die halbtransparente Wasserfläche ein/aus – aus siehst du den Grund klarer. Mit „Höhe“ überhöhst du das Relief, damit Kanten und Rinnen deutlicher werden (nur Darstellung).'],
  ['Linien & Steil', '„Linien“ zeigt Tiefen-Konturlinien (jede 5. kräftig), „Steil“ färbt steile Hänge violett – ideal zum Finden von Kanten. Linienabstand und Steilheits-Schwelle stellst du im Menü (☰ → Darstellung) ein.'],
  ['GPS am Wasser', 'Tippe „GPS“: dein Standort erscheint als rote Nadel im Relief, oben steht die Tiefe unter dir laut Karte. So fährst du gezielt Kanten und Spots an.'],
  ['Hotspots', 'Mit „＋ Hotspot“ und einem Tipp in die Karte setzt du einen benannten Punkt (Stein, Kante, Krautkante …). Hotspots bleiben auf dem Handy gespeichert – auch offline.'],
  ['Offline installieren', 'Über das Browsermenü „Zum Startbildschirm hinzufügen“. Danach startet die App wie eine normale App und funktioniert ohne Internet. Deine Gewässer und Hotspots liegen nur auf deinem Gerät.']
];
let guideStep = 0;
function showGuide() { const g = GUIDE[guideStep]; $('guideTitle').textContent = g[0]; $('guideBody').textContent = g[1];
  $('guideDots').innerHTML = GUIDE.map((_, i) => '<span class="guidedot' + (i === guideStep ? ' active' : '') + '"></span>').join('');
  $('guidePrev').style.visibility = guideStep ? 'visible' : 'hidden'; $('guideNext').textContent = guideStep === GUIDE.length - 1 ? 'Los geht’s' : 'Weiter';
  if (!$('tutorialDlg').open) $('tutorialDlg').showModal(); }

$('helpBody').innerHTML = `
<p>Die App zeigt ein Gewässer als 3D-Relief mit amtlichem Luftbild – komplett offline.</p>
<h3 style="color:var(--acc)">Bedienung</h3>
<p>Ein Finger dreht, zwei Finger zoomen/schieben. „2D/3D“ wechselt die Ansicht, „Wasser“ schaltet die Wasserfläche, „Höhe“ überhöht das Relief (nur optisch).</p>
<h3 style="color:var(--acc)">Linien & Steil</h3>
<p>„Linien“ zeigt Tiefen-Konturlinien (jede 5. kräftig), „Steil“ färbt Hänge über der Schwelle violett (physikalische Neigung, ohne Überhöhung). Linienabstand und Steilheits-Schwelle im Menü unter „Darstellung“. Enthält das Paket eine Ufergrenze, wird der See darauf beschnitten und die Uferlinie orange gezeigt.</p>
<h3 style="color:var(--acc)">GPS & Tiefe</h3>
<p>„GPS“ zeigt deinen Standort als rote Nadel; oben erscheint die Tiefe unter dir laut Karte. Außerhalb des Gewässers steht „außerhalb der Karte“. Die Tiefe stammt aus den gemessenen Daten, nicht aus einer Live-Messung.</p>
<h3 style="color:var(--acc)">Hotspots</h3>
<p>„＋ Hotspot“ antippen, dann in die Karte tippen und benennen. Hotspots liegen pro Gewässer lokal auf dem Gerät.</p>
<h3 style="color:var(--acc)">Gewässer verwalten</h3>
<p>Über ☰ lädst du neue Pakete (.uwpaket) und wechselst zwischen gespeicherten Gewässern. Alles bleibt auf dem Handy.</p>
<p class="tiny">Luftbild © Geobasis NRW bzw. PDOK (Beeldmateriaal.nl). Nur zur Orientierung, nicht zur Navigation.</p>`;

$('historyBody').innerHTML = `
<p><b>0.2.0 · 28.10.2026 · aktuell:</b> Konturlinien (jede 5. kräftig, Abstand einstellbar), steile Flächen violett (Schwelle einstellbar, Standard 20 %) und Beschnitt auf die mitgelieferte Ufergrenze. Passend zum feineren Gewässerpaket aus dem Desktop-Tool (Detailstufe bis 1 m).</p>
<p><b>0.1.0 · 28.10.2026:</b> Erste Version. Lädt Gewässerpakete (.uwpaket) aus dem Desktop-Tool, zeigt 3D-Relief (Naturgrund-Farben) mit Luftbild und zuschaltbarer Wasserfläche, 2D/3D-Umschalter und Überhöhung. GPS-Standort mit Tiefe unter mir, Hotspots lokal setzen. Offline-fähige PWA mit Tutorial und Hilfe.</p>`;

// ------------------------------------------------------------------ Verdrahtung
function wire() {
  $('menuBtn').onclick = openMenu; $('menuClose').onclick = closeMenu; $('menuSheet').onclick = e => { if (e.target === $('menuSheet')) closeMenu(); };
  $('helpBtn').onclick = () => $('helpDlg').showModal(); $('helpClose').onclick = () => $('helpDlg').close(); $('aboutBtn').onclick = () => { closeMenu(); $('helpDlg').showModal(); };
  $('historyBtn').onclick = () => { closeMenu(); $('historyDlg').showModal(); }; $('historyClose').onclick = () => $('historyDlg').close();
  $('tutorialBtn').onclick = () => { closeMenu(); guideStep = 0; showGuide(); };
  $('guidePrev').onclick = () => { if (guideStep) { guideStep--; showGuide(); } };
  $('guideNext').onclick = () => { if (guideStep < GUIDE.length - 1) { guideStep++; showGuide(); } else { $('tutorialDlg').close(); try { localStorage.setItem('uwm-tut', '0.1.0'); } catch {} } };
  for (const id of ['importBtn', 'welcomeImport']) $(id).onclick = () => $('fileInput').click();
  $('fileInput').onchange = e => { importFile(e.target.files[0]); e.target.value = ''; };
  $('welcomeHelp').onclick = () => { guideStep = 0; showGuide(); };
  $('view2d3d').onclick = () => { cam.twoD = !cam.twoD; $('view2d3d').textContent = cam.twoD ? '3D' : '2D'; $('view2d3d').classList.toggle('on', cam.twoD); applyCam(); };
  $('waterBtn').onclick = () => { const on = !$('waterBtn').classList.contains('on'); $('waterBtn').classList.toggle('on', on); if (waterMesh) { waterMesh.visible = on; needRender = true; } };
  $('lineBtn').onclick = () => { contourOn = !contourOn; $('lineBtn').classList.toggle('on', contourOn); buildContours(); };
  $('steepBtn').onclick = () => { steepOn = !steepOn; $('steepBtn').classList.toggle('on', steepOn); buildSteep(); };
  $('lineIv').oninput = () => { contourInterval = Number($('lineIv').value); $('lineIvVal').textContent = fmt(contourInterval, 1) + ' m'; if (contourOn) buildContours(); };
  $('steepIv').oninput = () => { steepPct = Number($('steepIv').value); $('steepIvVal').textContent = steepPct + ' %'; if (steepOn) buildSteep(); };
  $('gpsBtn').onclick = toggleGps;
  $('hotBtn').onclick = () => setHotMode(!hotMode);
  $('exag').oninput = () => { $('exagVal').textContent = exag() + '×'; rebuildTerrain(); };
  $('hotCancel').onclick = () => $('hotDlg').close(); $('hotSave').onclick = saveHotspot;
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('cancel', e => { /* ESC schließt */ }));
}

// ------------------------------------------------------------------ Start
async function boot() {
  wire(); initThree();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
  try { db = await openDB(); } catch (e) { alert('Speicher nicht verfügbar: ' + e.message); return; }
  try { const est = await navigator.storage?.estimate?.(); if (est) $('storageNote').textContent = 'Belegt ' + (est.usage / 1048576).toFixed(0) + ' MB von ' + (est.quota / 1048576 / 1024).toFixed(1) + ' GB auf diesem Gerät.'; } catch {}
  await renderPkgList();
  const last = await (async () => { try { return (await prom(store('meta', 'readonly').get('last')))?.id; } catch { return null; } })();
  const all = await dbAll('packages');
  if (last && all.find(r => r.id === last)) await loadPackage(all.find(r => r.id === last));
  else if (all.length) { /* zeige Willkommen mit Liste im Menü */ }
  let seen; try { seen = localStorage.getItem('uwm-tut'); } catch {}
  if (!seen && !all.length) showGuide();
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch {} }
}
boot();
})();
