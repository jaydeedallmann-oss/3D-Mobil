/* Gewässerpaket (.uwpaket) – ein Gewässer als eine Datei fürs Handy: Tiefenraster + Luftbild + Georeferenz.
 *
 * Inhalt der ZIP:
 *   manifest.json   Metadaten, Raster-Kopf, Georeferenz, Palette, Luftbild-Eckpunkte, Grenze, Hotspots
 *   depth.bin       Int16 little-endian, Tiefe×10 (Dezimeter), zeilenweise; -32768 = keine Daten
 *   aerial.jpg      georeferenziertes Luftbild des Gewässers + Umland (optional)
 *
 * Rein rechnerisch, ohne DOM – läuft im Browser (Export im GSD-Tool, Import in der Handy-PWA) und in Node-Tests.
 * Die Georeferenz ist die lokale Projektion des Tools (äquirektangular um die Seemitte):
 *   lat = lat0 + y/metersPerLat ,  lon = lon0 + x/metersPerLon. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UWPackage = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FORMAT = 'uw-gewaesserpaket', VERSION = 1, NO_DATA = -32768, SCALE = 0.1;
  const MANIFEST = 'manifest.json', DEPTH = 'depth.bin', AERIAL = 'aerial.jpg';

  function safeName(name) {
    let s = String(name || '');
    for (const [a, b] of [['Ä', 'Ae'], ['ä', 'ae'], ['Ö', 'Oe'], ['ö', 'oe'], ['Ü', 'Ue'], ['ü', 'ue'], ['ß', 'ss']]) s = s.split(a).join(b);
    s = s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
    return s || 'Gewaesser';
  }
  const bytes = b => b instanceof Uint8Array ? b : new Uint8Array(b);
  const enc = s => new TextEncoder().encode(s);

  // ---- Tiefenraster <-> Int16-Dezimeter --------------------------------------------------------
  function encodeDepth(values, nx, ny) {
    if (!Array.isArray(values) && !(values instanceof Float32Array)) throw new Error('Rasterwerte fehlen.');
    if (values.length !== nx * ny) throw new Error('Rastergröße passt nicht zu nx·ny.');
    const out = new Int16Array(nx * ny);
    for (let i = 0; i < out.length; i++) {
      const v = values[i];
      out[i] = (v === null || v === undefined || !Number.isFinite(v)) ? NO_DATA
        : Math.max(-32767, Math.min(32767, Math.round(v / SCALE)));
    }
    return new Uint8Array(out.buffer);
  }
  function decodeDepth(buf, nx, ny) {
    const u = bytes(buf).slice(0, nx * ny * 2);   // Kopie mit Offset 0 → 2-Byte-ausgerichtet
    const i16 = new Int16Array(u.buffer, 0, nx * ny), out = new Float32Array(nx * ny);
    for (let i = 0; i < out.length; i++) out[i] = i16[i] === NO_DATA ? NaN : i16[i] * SCALE;
    return out;
  }

  // ---- Web-Mercator-Kacheln (für das gebackene Luftbild) ---------------------------------------
  function lonToTileX(lon, z) { return (lon + 180) / 360 * (2 ** z); }
  function latToTileY(lat, z) { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (2 ** z); }
  function tileXToLon(x, z) { return x / (2 ** z) * 360 - 180; }
  function tileYToLat(y, z) { const n = Math.PI - 2 * Math.PI * y / (2 ** z); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); }
  /** Kachelbereich, der die BBox bei Zoom z abdeckt; verkleinert z, bis die Kachelzahl ≤ maxTiles ist. */
  function coverTiles(bbox, zoom, maxTiles = 256) {
    const { west, south, east, north } = bbox;
    if (![west, south, east, north].every(Number.isFinite) || west > east || south > north)
      throw new Error('Ungültige Luftbild-BBox.');
    let z = Math.max(0, Math.min(22, Math.floor(zoom)));
    for (; ; z--) {
      const n = 2 ** z;
      const x0 = Math.max(0, Math.floor(lonToTileX(west, z))), x1 = Math.min(n - 1, Math.floor(lonToTileX(east, z)));
      const y0 = Math.max(0, Math.floor(latToTileY(north, z))), y1 = Math.min(n - 1, Math.floor(latToTileY(south, z)));
      const nxT = x1 - x0 + 1, nyT = y1 - y0 + 1;
      if (z === 0 || nxT * nyT <= maxTiles) {
        return {
          z, x0, y0, nx: nxT, ny: nyT, tiles: nxT * nyT, pxW: nxT * 256, pxH: nyT * 256,
          bounds: { west: tileXToLon(x0, z), east: tileXToLon(x1 + 1, z), north: tileYToLat(y0, z), south: tileYToLat(y1 + 1, z) }
        };
      }
    }
  }

  // ---- Georeferenz: Zelle (i,j) <-> lat/lon ----------------------------------------------------
  function cellToLatLon(i, j, grid, geo) {
    const x = grid.x0 + i * grid.cellSize, y = grid.y0 + j * grid.cellSize;
    return { lat: geo.lat0 + y / geo.metersPerLat, lon: geo.lon0 + x / geo.metersPerLon };
  }
  function gridBBox(grid, geo) {
    const a = cellToLatLon(0, 0, grid, geo), b = cellToLatLon(grid.nx - 1, grid.ny - 1, grid, geo);
    return { west: Math.min(a.lon, b.lon), east: Math.max(a.lon, b.lon), south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat) };
  }

  // ---- Stored-ZIP (ohne Kompression) lesen -----------------------------------------------------
  function unzipStored(buf) {
    const u = bytes(buf), dv = new DataView(u.buffer, u.byteOffset, u.byteLength), files = new Map();
    let eo = u.length - 22;
    for (; eo >= 0; eo--) if (dv.getUint32(eo, true) === 0x06054b50) break;
    if (eo < 0) throw new Error('Keine gültige ZIP (EOCD fehlt).');
    const count = dv.getUint16(eo + 10, true); let o = dv.getUint32(eo + 16, true);
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(o, true) !== 0x02014b50) throw new Error('ZIP-Zentralverzeichnis beschädigt.');
      const method = dv.getUint16(o + 10, true), size = dv.getUint32(o + 24, true);
      const nameLen = dv.getUint16(o + 28, true), extraLen = dv.getUint16(o + 30, true), commentLen = dv.getUint16(o + 32, true);
      const local = dv.getUint32(o + 42, true), name = new TextDecoder().decode(u.subarray(o + 46, o + 46 + nameLen));
      if (method !== 0) throw new Error('ZIP-Eintrag „' + name + '“ ist komprimiert – nicht unterstützt.');
      const lNameLen = dv.getUint16(local + 26, true), lExtraLen = dv.getUint16(local + 28, true), start = local + 30 + lNameLen + lExtraLen;
      files.set(name, u.subarray(start, start + size));
      o += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  // ---- Bauen -----------------------------------------------------------------------------------
  /** Paket bauen. `zip` ist die Stored-ZIP-Funktion (im Tool UWEcho.zip). aerial optional. */
  function build(opts, { zip }) {
    if (typeof zip !== 'function') throw new Error('ZIP-Funktion fehlt.');
    const { name, grid, projection, palette, boundary = null, waypoints = [], aerial = null } = opts;
    if (!grid || !Number.isFinite(grid.nx) || !Number.isFinite(grid.ny) || !Number.isFinite(grid.cellSize)) throw new Error('Tiefenraster fehlt oder ist unvollständig.');
    if (!projection || !Number.isFinite(projection.lat0) || !Number.isFinite(projection.metersPerLat) || !Number.isFinite(projection.metersPerLon)) throw new Error('Georeferenz (Projektion) fehlt.');
    const manifest = {
      format: FORMAT, version: VERSION,
      name: String(name || 'Gewässer'),
      created: opts.created || new Date().toISOString().slice(0, 10),
      tool: opts.tool || 'Unterwasserwelt 3D',
      grid: { nx: grid.nx, ny: grid.ny, cellSize: grid.cellSize, x0: grid.x0, y0: grid.y0,
              dtype: 'int16le', scale: SCALE, noData: NO_DATA, file: DEPTH, rowOrder: 'row-major; i=0→West (x0), j=0→Süd (y0)' },
      geo: { lat0: projection.lat0, lon0: projection.lon0, metersPerLat: projection.metersPerLat, metersPerLon: projection.metersPerLon },
      palette: Array.isArray(palette) ? palette.map(b => ({ from: b.from, to: b.to, color: b.color })) : null,
      aerial: aerial ? { file: AERIAL, bounds: aerial.bounds, px: aerial.px || null,
                         attribution: aerial.attribution || '', year: aerial.year || null, provider: aerial.provider || '' } : null,
      boundary: boundary || null,
      waypoints: (waypoints || []).map(w => ({ name: w.name, lat: w.lat, lon: w.lon, symbol: w.symbol }))
    };
    const files = [{ name: MANIFEST, data: JSON.stringify(manifest) }, { name: DEPTH, data: encodeDepth(grid.values, grid.nx, grid.ny) }];
    if (aerial) files.push({ name: AERIAL, data: bytes(aerial.bytes) });
    return { bytes: zip(files), filename: safeName(name) + '.uwpaket', manifest };
  }

  // ---- Lesen (PWA) -----------------------------------------------------------------------------
  function parse(zipBytes) {
    const files = unzipStored(zipBytes);
    const mf = files.get(MANIFEST);
    if (!mf) throw new Error('manifest.json fehlt – keine Gewässerpaket-Datei.');
    const manifest = JSON.parse(new TextDecoder().decode(mf));
    if (manifest.format !== FORMAT) throw new Error('Unbekanntes Paketformat.');
    const g = manifest.grid, depthBuf = files.get(g.file || DEPTH);
    if (!depthBuf) throw new Error('Tiefenraster (depth.bin) fehlt.');
    const values = decodeDepth(depthBuf, g.nx, g.ny);
    const grid = { nx: g.nx, ny: g.ny, x0: g.x0, y0: g.y0, cellSize: g.cellSize, values };
    const aerialBytes = manifest.aerial ? files.get(manifest.aerial.file || AERIAL) || null : null;
    return { manifest, grid, geo: manifest.geo, palette: manifest.palette, boundary: manifest.boundary || null,
             waypoints: manifest.waypoints || [], aerial: manifest.aerial, aerialBytes };
  }

  return { FORMAT, VERSION, NO_DATA, SCALE, safeName, encodeDepth, decodeDepth,
           lonToTileX, latToTileY, tileXToLon, tileYToLat, coverTiles, cellToLatLon, gridBBox,
           unzipStored, build, parse };
});
