/* Offline, dependency-free bathymetric bands. Validate at settings boundaries. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UWColors = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_BANDS = 2048;
  const BASE = [
    {from: 0, to: 5, color: '#c3e7d8'},
    {from: 5, to: 10, color: '#4eaca1'},
    {from: 10, to: 15, color: '#247caa'},
    {from: 15, to: 30, color: '#163e6c'}
  ];
  function defaults() { return BASE.map(b => ({...b})); }
  // Naturgrund (0.12.0): 1-m-Stufen bis 11 m, Farben aus dem Navico-6×6×6-Würfel (Plotter = Tool), darunter grau.
  const NATURGRUND = [
    {from: 0, to: 1, color: '#ffffcc'}, {from: 1, to: 2, color: '#cccc99'}, {from: 2, to: 3, color: '#99cc99'},
    {from: 3, to: 4, color: '#669966'}, {from: 4, to: 5, color: '#669999'}, {from: 5, to: 6, color: '#339999'},
    {from: 6, to: 7, color: '#336699'}, {from: 7, to: 8, color: '#336666'}, {from: 8, to: 9, color: '#003366'},
    {from: 9, to: 10, color: '#003333'}, {from: 10, to: 11, color: '#000033'}, {from: 11, to: 100, color: '#666666'}
  ];
  function naturgrund() { return NATURGRUND.map(b => ({...b})); }
  // Weitere Skalen (0.16.0): aus Farb-Stützstellen interpoliert, 1-m-Stufen bis 20 m – validate-konform.
  function mix(a, b, t) {
    const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16)), pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
    return '#' + pa.map((v, k) => Math.round(v + (pb[k] - v) * t).toString(16).padStart(2, '0')).join('');
  }
  function sampleStops(stops, d) {
    if (d <= stops[0].d) return stops[0].color;
    for (let i = 1; i < stops.length; i++) if (d <= stops[i].d) return mix(stops[i - 1].color, stops[i].color, (d - stops[i - 1].d) / (stops[i].d - stops[i - 1].d));
    return stops[stops.length - 1].color;
  }
  function ramp(stops, maxDepth = 20, step = 1) {
    const n = Math.ceil(maxDepth / step), out = [];
    for (let i = 0; i < n; i++) { const from = i * step, to = Math.min((i + 1) * step, maxDepth); out.push({from, to, color: sampleStops(stops, (from + to) / 2)}); }
    return out;
  }
  const SCALES = {
    tiefblau: [{d: 0, color: '#dff3ff'}, {d: 6, color: '#3aa0d6'}, {d: 12, color: '#1b5fa6'}, {d: 20, color: '#0a2452'}],
    ampel:    [{d: 0, color: '#c81e1e'}, {d: 3, color: '#e8a81d'}, {d: 6, color: '#e6e01c'}, {d: 12, color: '#39a83a'}, {d: 20, color: '#0f5f2a'}],
    spektrum: [{d: 0, color: '#ff2a2a'}, {d: 4, color: '#ffd21a'}, {d: 8, color: '#36d13b'}, {d: 12, color: '#1ec9d1'}, {d: 16, color: '#2a5bff'}, {d: 20, color: '#7a1ad1'}]
  };
  function tiefblau() { return ramp(SCALES.tiefblau); }
  function ampel() { return ramp(SCALES.ampel); }
  function spektrum() { return ramp(SCALES.spektrum); }
  const halfMeter = v => typeof v === 'number' && Number.isFinite(v) && Number.isSafeInteger(v * 2) && v >= 0;
  function validate(bands) {
    if (!Array.isArray(bands) || !bands.length || bands.length > MAX_BANDS)
      throw new Error('Farbintervalle: 1 bis ' + MAX_BANDS + ' Intervalle erforderlich.');
    let end = 0;
    const result = [];
    for (const b of bands) {
      if (!b || !halfMeter(b.from) || !halfMeter(b.to) || b.from !== end || b.to <= b.from)
        throw new Error('Tiefenintervalle müssen ab 0 m lückenlos aufsteigen, ohne Überlappung; Grenzen in 0,5-m-Schritten.');
      if (typeof b.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(b.color))
        throw new Error('Farbe bitte als sechsstelligen Hexwert angeben (#rrggbb).');
      result.push({from: b.from, to: b.to, color: b.color.toLowerCase()});
      end = b.to;
    }
    return result;
  }
  // Hot rendering path: bands must already have passed validate(). No sorting/mutation.
  function colorRGB(depth, bands = BASE) {
    if (typeof depth !== 'number' || !Number.isFinite(depth)) throw new Error('Tiefe muss endlich sein.');
    let low = 0, high = bands.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (depth < bands[mid].to) high = mid;
      else low = mid + 1;
    }
    const hex = bands[low].color;
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  }
  function generate(step, maxDepth) {
    if (!halfMeter(step) || !step) throw new Error('Schrittweite muss ein positives Vielfaches von 0,5 m sein.');
    if (!halfMeter(maxDepth) || !maxDepth) throw new Error('Maximale Tiefe muss ein positives Vielfaches von 0,5 m sein.');
    const count = Math.ceil(maxDepth / step);
    if (count > MAX_BANDS) throw new Error('Zu viele Farbintervalle (höchstens ' + MAX_BANDS + '). Schrittweite erhöhen.');
    const first = colorRGB(0), last = colorRGB(BASE[BASE.length - 1].from);
    return Array.from({length: count}, (_, i) => {
      const t = count === 1 ? 0 : i / (count - 1);
      const color = '#' + first.map((v,k) => Math.round(v + (last[k] - v) * t).toString(16).padStart(2, '0')).join('');
      return {from: i * step, to: Math.min((i + 1) * step, maxDepth), color};
    });
  }
  return {MAX_BANDS, defaults, naturgrund, tiefblau, ampel, spektrum, validate, colorRGB, generate};
});
