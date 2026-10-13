/* Focalización Cachicamo: visor y estadísticas en el navegador.
   Los rásters llegan como uint16 (0 = sin dato; valor = (v-1)/65534) en malla EPSG:3857.
   Coberturas y veredas llegan como uint8 en la misma malla. */
/* Protección: si el index.html quedó con la página repetida (o el navegador tiene en caché
   una versión así), se eliminan las copias sobrantes y la app se ejecuta una sola vez. */
(function () {
  const sobrantes = (sel) => [...document.querySelectorAll(sel)].slice(1).forEach((el) => el.remove());
  sobrantes("body > header.topbar");
  sobrantes("body > main.layout");
  sobrantes("body > dialog#otros");
})();

(function () {
  "use strict";
  if (window.__cachicamoApp) return;   // ya se está ejecutando (app.js cargado dos veces)
  window.__cachicamoApp = true;

  // ------------------------------------------------------------------ estado
  const S = {
    meta: null, W: 0, H: 0, N: 0,
    data: {},            // id -> Uint16Array
    cob: null,           // Uint8Array código de cobertura
    ver: null,           // Uint8Array id de vereda
    rowHa: null,         // Float64Array ha por píxel según fila
    verIdx: null, verOff: null, // píxeles agrupados por vereda
    cobActive: [],       // por código
    thr: 0.75,
    selVer: null,
    selRaster: null,
    cobRaster: null,
    layers: {},
    cv: {},              // capas de corredores de vida
    charts: {},
    cache: {},
  };
  const SCALE = 65534;

  // Corredores de vida: un GeoJSON en EPSG:4326. Se busca en data/ y, si no está, en la raíz del repo.
  const CV_LAYERS = [
    { id: "corredores", files: ["data/corredores.geojson", "corredores.geojson"], nombre: "Corredores de vida", on: true,
      style: { color: "#ff2bd6", weight: 3, fillColor: "#ff2bd6", fillOpacity: 0.3 },
      halo: { color: "#1a0718", weight: 7, opacity: 0.75, fill: false } },
  ];
  const CV_LABELS = {
    corredor_id: "Corredor", tramo: "Tramo", anc_id: "Anclaje", parque: "Parque", nombre: "Nombre", categoria: "Categoría",
    area_ha: "Área (ha)", area_rect_ha: "Área rectángulo (ha)", area_sel_ha: "Área seleccionada (ha)", llenado: "Llenado",
    largo_m: "Largo (m)", ancho_m: "Ancho (m)", m_CAZ2_rank_media: "CAZ2 rank (media)", m_CAZ2_frac_top: "CAZ2 fracción top",
    m_04_Current_percentil_GLOBAL: "Corriente global (percentil)", m_costo01: "Costo (0 a 1)", m_CCuc2024: "CCuc 2024",
    m_GHMv3_90m: "Huella humana GHM v3",
  };
  const R_EARTH = 6378137;

  const $ = (s) => document.querySelector(s);
  const fmt = (v, d = 3) => (v == null || !isFinite(v)) ? "—" : v.toLocaleString("es-CO", { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtHa = (v) => (v == null || !isFinite(v)) ? "—" : v.toLocaleString("es-CO", { maximumFractionDigits: v < 100 ? 1 : 0 }) + " ha";

  // ------------------------------------------------------------------ paleta turbo
  function turbo(x) {
    x = Math.min(1, Math.max(0, x));
    const r = 0.13572138 + x * (4.61539260 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
    const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
    const b = 0.10667330 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
    const c = (v) => Math.round(255 * Math.min(1, Math.max(0, v)));
    return [c(r), c(g), c(b)];
  }
  const TURBO = Array.from({ length: 256 }, (_, i) => turbo(i / 255));
  const TURBO32 = new Uint32Array(256);
  TURBO.forEach(([r, g, b], i) => { TURBO32[i] = (255 << 24 | b << 16 | g << 8 | r) >>> 0; });
  const turboCss = (x) => { const [r, g, b] = turbo(x); return `rgb(${r},${g},${b})`; };
  const hex32 = (hex, a = 255) => {
    const n = parseInt(hex.slice(1), 16);
    return ((a << 24) | ((n & 255) << 16) | (((n >> 8) & 255) << 8) | (n >> 16)) >>> 0;
  };

  // ------------------------------------------------------------------ carga
  let loaded = 0, toLoad = 1;
  function progress(msg) {
    loaded++;
    $("#loader-bar").style.width = Math.round(100 * loaded / toLoad) + "%";
    if (msg) $("#loader-msg").textContent = msg;
  }
  async function loadBin(url, Type) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`No se pudo leer ${url} (HTTP ${r.status})`);
    let buf = new Uint8Array(await r.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = fflate.gunzipSync(buf);
    const out = new Type(buf.byteLength / Type.BYTES_PER_ELEMENT);
    new Uint8Array(out.buffer).set(buf);
    return out;
  }

  // ------------------------------------------------------------------ capa canvas
  const CanvasOverlay = L.ImageOverlay.extend({
    initialize(canvas, bounds, options) {
      this._canvasEl = canvas;
      L.ImageOverlay.prototype.initialize.call(this, "", bounds, options);
    },
    _initImage() {
      const el = (this._image = this._canvasEl);
      L.DomUtil.addClass(el, "leaflet-image-layer");
      if (this._zoomAnimated) L.DomUtil.addClass(el, "leaflet-zoom-animated");
      if (this.options.className) L.DomUtil.addClass(el, this.options.className);
      el.onselectstart = L.Util.falseFn;
      el.onmousemove = L.Util.falseFn;
      if (this.options.zIndex != null) this._updateZIndex();
    },
  });

  function makeCanvas() {
    const c = document.createElement("canvas");
    c.width = S.W; c.height = S.H;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(S.W, S.H);
    return { canvas: c, ctx, img, px: new Uint32Array(img.data.buffer) };
  }

  function paintRaster(id, cv) {
    const a = S.data[id], px = cv.px;
    for (let i = 0; i < S.N; i++) {
      const v = a[i];
      px[i] = v ? TURBO32[((v - 1) * 255 / SCALE) | 0] : 0;
    }
    cv.ctx.putImageData(cv.img, 0, 0);
  }

  const CORR32 = hex32("#2bd34f");
  function paintCorridor() {
    const cv = S.layers.corridor.cv, a = S.data.caz2, px = cv.px;
    const t = Math.round(S.thr * SCALE) + 1;
    let ha = 0, haAll = 0;
    const rowHa = S.rowHa, W = S.W;
    for (let y = 0, i = 0; y < S.H; y++) {
      const h = rowHa[y];
      for (let x = 0; x < W; x++, i++) {
        const v = a[i];
        if (v) {
          haAll += h;
          if (v >= t) { px[i] = CORR32; ha += h; } else px[i] = 0;
        } else px[i] = 0;
      }
    }
    cv.ctx.putImageData(cv.img, 0, 0);
    $("#corr-ha").textContent = fmtHa(ha);
    $("#corr-pct").textContent = `(${fmt(100 * ha / haAll, 1)} % del área con dato CAZ2)`;
  }

  function paintCob() {
    const cv = S.layers.cob.cv, a = S.cob, px = cv.px;
    const lut = new Uint32Array(256);
    S.meta.coberturas.forEach((c) => { lut[c.code] = S.cobActive[c.code] ? hex32(c.color) : 0; });
    for (let i = 0; i < S.N; i++) px[i] = lut[a[i]];
    cv.ctx.putImageData(cv.img, 0, 0);
  }

  // ------------------------------------------------------------------ mapa
  let map, bounds, basemaps = {}, currentBase = null, verLayer, selOutline;

  function initMap() {
    const g = S.meta.grid;
    bounds = L.latLngBounds(g.bounds_latlon);
    map = L.map("map", { zoomControl: true, preferCanvas: false }).fitBounds(bounds);
    map.attributionControl.setPrefix("");
    basemaps.sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imágenes: Esri, Maxar, Earthstar Geographics" });
    basemaps.light = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom: 19, subdomains: "abcd", attribution: "© OpenStreetMap, © CARTO" });
    basemaps.osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });
    setBase("sat");

    const panes = [["rasterPane", 402], ["cobPane", 403], ["corrPane", 405], ["cvPane", 430], ["ccPane", 435], ["verPane", 450]];
    panes.forEach(([n, z]) => { map.createPane(n).style.zIndex = z; });

    // Coberturas
    const cobCv = makeCanvas();
    S.layers.cob = { cv: cobCv, layer: new CanvasOverlay(cobCv.canvas, bounds, { pane: "cobPane", opacity: 0.75, className: "raster" }) };

    // Rásters (en orden inverso para que el primero quede arriba)
    S.meta.rasters.forEach((r, k) => {
      const cv = makeCanvas();
      paintRaster(r.id, cv);
      const layer = new CanvasOverlay(cv.canvas, bounds, { pane: "rasterPane", opacity: 0.85, className: "raster", zIndex: 10 + k });
      S.layers[r.id] = { cv, layer };
    });

    // Corredor
    const corrCv = makeCanvas();
    S.layers.corridor = { cv: corrCv, layer: new CanvasOverlay(corrCv.canvas, bounds, { pane: "corrPane", opacity: 0.85, className: "raster" }) };
    paintCorridor();
    S.layers.corridor.layer.addTo(map);

    map.on("click", onMapClick);
  }

  function setBase(k) {
    if (currentBase) map.removeLayer(currentBase);
    currentBase = basemaps[k] || null;
    if (currentBase) currentBase.addTo(map);
  }

  function toggleLayer(key, on) {
    const l = S.layers[key].layer;
    if (on) l.addTo(map); else map.removeLayer(l);
  }

  // ------------------------------------------------------------------ identificación por clic
  function pixelAt(latlng) {
    const g = S.meta.grid;
    const x = R_EARTH * latlng.lng * Math.PI / 180;
    const y = R_EARTH * Math.log(Math.tan(Math.PI / 4 + latlng.lat * Math.PI / 360));
    const col = Math.floor((x - g.x0) / g.res), row = Math.floor((g.y0 - y) / g.res);
    if (col < 0 || row < 0 || col >= S.W || row >= S.H) return -1;
    return row * S.W + col;
  }
  const val = (id, i) => { const v = S.data[id][i]; return v ? (v - 1) / SCALE : null; };

  function onMapClick(e) {
    const i = pixelAt(e.latlng);
    if (i < 0) return;
    const cobCode = S.cob[i], vid = S.ver[i];
    const cob = S.meta.coberturas.find((c) => c.code === cobCode);
    const ver = S.meta.veredas.find((v) => v.vid === vid);
    let rows = S.meta.rasters.map((r) => {
      const v = val(r.id, i);
      return `<tr><td>${r.nombre}</td><td>${v == null ? '<span class="muted">sin dato</span>' : fmt(v)}</td></tr>`;
    }).join("");
    const c = val("caz2", i);
    rows += `<tr><td>Corredor (≥ ${fmt(S.thr, 2)})</td><td>${c == null ? '<span class="muted">sin dato</span>' : (c >= S.thr ? "Sí" : "No")}</td></tr>`;
    rows += `<tr><td>Cobertura</td><td>${cob ? cob.nombre : '<span class="muted">—</span>'}</td></tr>`;
    const cvHtml = cvAt(e.latlng) + ccAt(e.latlng);
    const html = `<div class="pop"><h4>${ver ? "Vereda " + ver.nombre : "Fuera de las veredas"}</h4>
      <table>${rows}</table>${cvHtml}
      ${ver ? `<button type="button" data-vid="${ver.vid}">Ver estadísticas de la vereda</button>` : ""}</div>`;
    const pop = L.popup().setLatLng(e.latlng).setContent(html).openOn(map);
    const btn = pop.getElement().querySelector("button[data-vid]");
    if (btn) btn.addEventListener("click", () => { selectVereda(+btn.dataset.vid, true); showTab("veredas"); map.closePopup(); });
  }

  // ------------------------------------------------------------------ corredores de vida
  function pointInRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function pointInGeom(lng, lat, g) {
    if (!g) return false;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    return polys.some((rings) => pointInRing(lng, lat, rings[0]) && !rings.slice(1).some((h) => pointInRing(lng, lat, h)));
  }
  function cvValue(k, v) {
    if (typeof v !== "number") return v == null ? "—" : String(v);
    if (Number.isInteger(v)) return v.toLocaleString("es-CO");
    return k.endsWith("_ha") || k.endsWith("_m") ? v.toLocaleString("es-CO", { maximumFractionDigits: 0 }) : fmt(v);
  }
  // Atributos de los corredores de vida visibles bajo el punto, para el popup
  function cvAt(latlng) {
    let html = "";
    CV_LAYERS.forEach((c) => {
      const L_ = S.cv[c.id];
      if (!L_ || !map.hasLayer(L_.layer)) return;
      L_.data.features.filter((f) => pointInGeom(latlng.lng, latlng.lat, f.geometry)).forEach((f) => {
        const rows = Object.entries(f.properties).map(([k, v]) => `<tr><td>${CV_LABELS[k] || k}</td><td>${cvValue(k, v)}</td></tr>`).join("");
        html += `<h5>${c.nombre}</h5><table>${rows}</table>`;
      });
    });
    return html;
  }
  // EPSG:9377 (MAGNA-SIRGAS 2018 / Origen Nacional, Transversa de Mercator) -> [lon, lat] en grados.
  // Permite cargar GeoJSON exportados desde QGIS sin reproyectar a EPSG:4326.
  function tm9377ToLonLat(x, y) {
    const a = 6378137, f = 1 / 298.257222101, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
    const k0 = 0.9992, lat0 = 4 * Math.PI / 180, lon0 = -73 * Math.PI / 180, FE = 5000000, FN = 2000000;
    const e4 = e2 * e2, e6 = e4 * e2;
    const Mf = (p) => a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * p - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * p)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * p) - (35 * e6 / 3072) * Math.sin(6 * p));
    const M = Mf(lat0) + (y - FN) / k0;
    const mu = M / (a * (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
      + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
    const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1);
    const C1 = ep2 * c * c, T1 = t * t, N1 = a / Math.sqrt(1 - e2 * s * s), R1 = a * (1 - e2) / Math.pow(1 - e2 * s * s, 1.5);
    const D = (x - FE) / (N1 * k0);
    const lat = p1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
      + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
    const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / c;
    return [lon * 180 / Math.PI, lat * 180 / Math.PI];
  }
  // Si el GeoJSON viene en metros (EPSG:9377), lo pasa a grados en el mismo objeto.
  function asegurarGrados(data) {
    let first = null;
    const find = (c) => { if (first) return; if (typeof c[0] === "number") first = c; else c.forEach(find); };
    data.features.forEach((f) => f.geometry && find(f.geometry.coordinates));
    if (!first || (Math.abs(first[0]) <= 180 && Math.abs(first[1]) <= 90)) return data;   // ya está en grados
    const crs = JSON.stringify(data.crs || "");
    if (crs !== '""' && !crs.includes("9377")) console.warn("GeoJSON proyectado en un CRS distinto de EPSG:9377; se asume 9377:", crs);
    const conv = (c) => (typeof c[0] === "number" ? tm9377ToLonLat(c[0], c[1]) : c.map(conv));
    data.features.forEach((f) => { if (f.geometry) f.geometry.coordinates = conv(f.geometry.coordinates); });
    delete data.crs;
    return data;
  }
  function haloStyle(c, op) {
    return Object.assign({}, c.halo, { opacity: c.halo.opacity * op });
  }
  function cvStyle(c, op) {
    const s = Object.assign({}, c.style);
    s.opacity = op; s.fillOpacity = (c.style.fillOpacity || 0) * op;
    return s;
  }
  async function loadCV() {
    await Promise.all(CV_LAYERS.map(async (c) => {
      const row = document.querySelector(`.layer[data-cv="${c.id}"]`);
      try {
        let data = null;
        for (const f of c.files) {
          const r = await fetch(f);
          if (r.ok) { data = await r.json(); break; }
        }
        if (!data) throw new Error("no encontrado");
        asegurarGrados(data);
        // el halo se crea primero para que quede debajo de la línea de color
        const halo = c.halo ? L.geoJSON(data, { pane: "cvPane", interactive: false, style: haloStyle(c, 1) }) : null;
        const main = L.geoJSON(data, { pane: "cvPane", interactive: false, style: cvStyle(c, 1) });
        const layer = L.featureGroup(halo ? [halo, main] : [main]);
        S.cv[c.id] = { layer, data, main, halo };
        if (c.on) layer.addTo(map);
      } catch (err) {
        if (row) row.hidden = true;   // archivo ausente: se oculta la fila
      }
    }));
    if (!Object.keys(S.cv).length) $("#cv-group").hidden = true;
  }

  // ------------------------------------------------------------------ índices por vereda
  function buildIndex() {
    const nV = S.meta.veredas.length + 1;
    const counts = new Int32Array(nV);
    for (let i = 0; i < S.N; i++) counts[S.ver[i]]++;
    const off = new Int32Array(nV + 1);
    for (let k = 0; k < nV; k++) off[k + 1] = off[k] + counts[k];
    const pos = off.slice(0, nV);
    const idx = new Int32Array(S.N);
    for (let i = 0; i < S.N; i++) idx[pos[S.ver[i]]++] = i;
    S.verIdx = idx; S.verOff = off;

    const g = S.meta.grid;
    S.rowHa = new Float64Array(S.H);
    for (let y = 0; y < S.H; y++) {
      const ym = g.y0 - (y + 0.5) * g.res;
      const lat = Math.atan(Math.sinh(ym / R_EARTH));
      const side = g.res * Math.cos(lat);
      S.rowHa[y] = side * side / 1e4;
    }
  }

  // ------------------------------------------------------------------ estadísticos
  function describe(arr, n) {
    if (!n) return { mediana: null, sd: null, min: null, max: null, media: null, n: 0 };
    const v = arr.subarray(0, n).slice().sort();
    let s = 0; for (let i = 0; i < n; i++) s += v[i];
    const m = s / n;
    let q = 0; for (let i = 0; i < n; i++) q += (v[i] - m) ** 2;
    const med = n % 2 ? v[(n - 1) >> 1] : (v[n / 2 - 1] + v[n / 2]) / 2;
    return { mediana: med, sd: n > 1 ? Math.sqrt(q / (n - 1)) : null, min: v[0], max: v[n - 1], media: m, n };
  }

  // Calcula todo para una vereda. Devuelve un objeto con estadísticos por ráster,
  // histograma, área por cobertura y mediana por cobertura.
  function veredaStats(vid, opts = {}) {
    const filter = $("#filter-cob").checked;
    const key = `${vid}|${filter}|${S.thr}|${S.cobActive.join("")}|${opts.lite ? 1 : 0}`;
    if (S.cache[key]) return S.cache[key];
    const a = S.verOff[vid], b = S.verOff[vid + 1], idx = S.verIdx;
    const W = S.W, rowHa = S.rowHa, cob = S.cob;
    const nCob = S.meta.coberturas.length + 1;
    const t = Math.round(S.thr * SCALE) + 1;
    const caz = S.data.caz2;

    let areaHa = 0, corrHa = 0, cazHa = 0;
    const cobHa = new Float64Array(nCob);
    const buf = new Float32Array(b - a);
    const out = { vid, rasters: {}, cobHa, filter };

    for (let k = a; k < b; k++) {
      const i = idx[k], h = rowHa[(i / W) | 0];
      areaHa += h; cobHa[cob[i]] += h;
      if (filter && !S.cobActive[cob[i]]) continue;
      const v = caz[i];
      if (v) { cazHa += h; if (v >= t) corrHa += h; }
    }
    out.areaHa = areaHa; out.corrHa = corrHa; out.cazHa = cazHa;

    for (const r of S.meta.rasters) {
      const d = S.data[r.id];
      let n = 0;
      const hist = new Float64Array(20);
      const perCob = opts.lite ? null : Array.from({ length: nCob }, () => []);
      for (let k = a; k < b; k++) {
        const i = idx[k], v = d[i];
        if (!v) continue;
        if (filter && !S.cobActive[cob[i]]) continue;
        const x = (v - 1) / SCALE;
        buf[n++] = x;
        hist[Math.min(19, (x * 20) | 0)] += rowHa[(i / W) | 0];
        if (perCob) perCob[cob[i]].push(x);
      }
      const st = describe(buf, n);
      st.hist = hist;
      if (perCob) st.cobMed = perCob.map((list) => list.length ? describe(Float32Array.from(list), list.length).mediana : null);
      out.rasters[r.id] = st;
    }
    S.cache[key] = out;
    return out;
  }

  // ------------------------------------------------------------------ gráficas
  function chartColors() {
    const cs = getComputedStyle(document.documentElement);
    return { ink: cs.getPropertyValue("--ink").trim(), muted: cs.getPropertyValue("--muted").trim(), line: cs.getPropertyValue("--line").trim(), corridor: cs.getPropertyValue("--corridor").trim(), accent: cs.getPropertyValue("--accent").trim() };
  }
  function setChart(name, canvasId, config) {
    if (S.charts[name]) S.charts[name].destroy();
    const c = chartColors();
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 11.5;
    Chart.defaults.locale = "es-CO";
    Chart.defaults.color = c.muted;
    Chart.defaults.borderColor = c.line;
    // etiquetas largas recortadas en ejes de categorías
    const cut = (t) => (typeof t === "string" && t.length > 24 ? t.slice(0, 22) + "…" : t);
    if (config.options && config.options.indexAxis === "y") {
      config.options.scales = config.options.scales || {};
      const y = (config.options.scales.y = config.options.scales.y || {});
      y.ticks = Object.assign({ callback: function (v) { return cut(this.getLabelForValue(v)); } }, y.ticks || {});
    }
    config.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } } }, config.options || {});
    S.charts[name] = new Chart(document.getElementById(canvasId), config);
  }

  // ------------------------------------------------------------------ panel vereda
  function rasterById(id) { return S.meta.rasters.find((r) => r.id === id); }

  function renderVereda() {
    const vid = S.selVer;
    if (!vid) { $("#ver-empty").hidden = false; $("#ver-detail").hidden = true; return; }
    $("#ver-empty").hidden = true; $("#ver-detail").hidden = false;
    const v = S.meta.veredas.find((x) => x.vid === vid);
    if (!v.conDato) {
      $("#ver-empty").hidden = false; $("#ver-detail").hidden = true;
      $("#ver-empty").innerHTML = `<p><strong>${v.nombre}</strong> queda fuera del área de los rásters, así que no tiene valores que analizar. Elige otra vereda.</p>`;
      return;
    }
    const st = veredaStats(vid);
    $("#ver-name").textContent = v.nombre;
    $("#ver-sub").textContent = `${v.municipio}, código ${v.codigo}`;
    $("#kpi-area").textContent = fmtHa(st.cazHa);
    $("#kpi-area-lbl").textContent = `con dato CAZ2` + (st.filter ? " en coberturas activas" : "") + `, de ${fmtHa(st.areaHa)} de la vereda`;
    $("#kpi-corr").textContent = fmtHa(st.corrHa);
    const pct = st.cazHa ? 100 * st.corrHa / st.cazHa : 0;
    $("#kpi-corr-lbl").textContent = `en corredor (≥ ${fmt(S.thr, 2)}), ${fmt(pct, 1)} % del área con dato`;

    // tabla
    const head = "<thead><tr><th>Ráster</th><th>Mediana</th><th>SD</th><th>Mín</th><th>Máx</th><th>Píxeles</th></tr></thead>";
    const body = S.meta.rasters.map((r) => {
      const s = st.rasters[r.id];
      return `<tr class="${r.id === S.selRaster ? "sel" : ""}"><td>${r.corto}</td><td><strong>${fmt(s.mediana)}</strong></td><td>${fmt(s.sd)}</td><td>${fmt(s.min)}</td><td>${fmt(s.max)}</td><td>${s.n.toLocaleString("es-CO")}</td></tr>`;
    }).join("");
    $("#ver-table").innerHTML = head + "<tbody>" + body + "</tbody>";

    const s = st.rasters[S.selRaster];
    const r = rasterById(S.selRaster);
    // histograma coloreado con turbo
    setChart("hist", "ch-hist", {
      type: "bar",
      data: {
        labels: Array.from({ length: 20 }, (_, k) => fmt(k / 20, 2)),
        datasets: [{ data: Array.from(s.hist), backgroundColor: Array.from({ length: 20 }, (_, k) => turboCss((k + 0.5) / 20)), barPercentage: 1, categoryPercentage: 1 }],
      },
      options: {
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: (it) => `${r.nombre}: ${it[0].label} a ${fmt((it[0].dataIndex + 1) / 20, 2)}`, label: (it) => fmtHa(it.raw) } } },
        scales: { x: { title: { display: true, text: "Valor de prioridad" }, ticks: { maxTicksLimit: 6 } }, y: { title: { display: true, text: "Hectáreas" } } },
      },
    });

    // área por cobertura
    const cobs = S.meta.coberturas.filter((c) => st.cobHa[c.code] > 0).sort((a, b) => st.cobHa[b.code] - st.cobHa[a.code]);
    $("#box-cobarea").style.height = Math.max(120, 28 * cobs.length + 40) + "px";
    setChart("cobarea", "ch-cobarea", {
      type: "bar",
      data: { labels: cobs.map((c) => c.nombre), datasets: [{ data: cobs.map((c) => st.cobHa[c.code]), backgroundColor: cobs.map((c) => S.cobActive[c.code] ? c.color : c.color + "40") }] },
      options: { indexAxis: "y", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (it) => `${fmtHa(it.raw)} (${fmt(100 * it.raw / st.areaHa, 1)} %)` } } }, scales: { x: { title: { display: true, text: "Hectáreas" } } } },
    });

    // mediana por cobertura
    const cm = S.meta.coberturas.filter((c) => s.cobMed[c.code] != null && (!st.filter || S.cobActive[c.code]));
    $("#box-cobmed").style.height = Math.max(120, 28 * cm.length + 40) + "px";
    setChart("cobmed", "ch-cobmed", {
      type: "bar",
      data: { labels: cm.map((c) => c.nombre), datasets: [{ data: cm.map((c) => s.cobMed[c.code]), backgroundColor: cm.map((c) => turboCss(s.cobMed[c.code])), borderColor: cm.map((c) => c.color), borderWidth: { left: 6 } }] },
      options: { indexAxis: "y", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (it) => `Mediana ${r.nombre}: ${fmt(it.raw)}` } } }, scales: { x: { min: 0, max: 1, title: { display: true, text: `Mediana de ${r.nombre}` } } } },
    });
  }

  function selectVereda(vid, zoom) {
    S.selVer = vid || null;
    $("#ver-select").value = vid || "";
    if (selOutline) { map.removeLayer(selOutline); selOutline = null; }
    if (vid) {
      verLayer.eachLayer((l) => {
        if (l.feature.properties.vid === vid) {
          selOutline = L.geoJSON(l.feature, { pane: "verPane", interactive: false, style: { color: "#ffd84d", weight: 3.5, fill: false } }).addTo(map);
          if (zoom) map.fitBounds(l.getBounds(), { padding: [30, 30] });
        }
      });
    }
    renderVereda();
  }

  // ------------------------------------------------------------------ comparación
  function cmpMetrics() {
    const list = [{ id: "corr_pct", nombre: "% en corredor (sobre el área con dato)" }, { id: "corr_ha", nombre: "Hectáreas en corredor" }];
    S.meta.rasters.forEach((r) => list.push({ id: "med_" + r.id, nombre: `Mediana de ${r.nombre}` }));
    return list;
  }
  function allStats() { return S.meta.veredas.filter((v) => v.conDato).map((v) => ({ v, st: veredaStats(v.vid, { lite: true }) })); }

  function renderCompare() {
    const m = $("#cmp-metric").value;
    const rows = allStats().map(({ v, st }) => {
      let y;
      if (m === "corr_pct") y = st.cazHa ? 100 * st.corrHa / st.cazHa : null;
      else if (m === "corr_ha") y = st.corrHa;
      else y = st.rasters[m.slice(4)].mediana;
      return { v, y };
    }).filter((d) => d.y != null).sort((a, b) => b.y - a.y);
    $("#box-cmp").style.height = Math.max(160, 19 * rows.length + 50) + "px";
    const c = chartColors();
    const isMed = m.startsWith("med_");
    setChart("cmp", "ch-cmp", {
      type: "bar",
      data: { labels: rows.map((d) => d.v.nombre), datasets: [{ data: rows.map((d) => d.y), backgroundColor: rows.map((d) => d.v.vid === S.selVer ? "#ffb703" : (isMed ? turboCss(d.y) : c.corridor)) }] },
      options: {
        indexAxis: "y",
        onClick: (_, els) => { if (els.length) selectVereda(rows[els[0].index].v.vid, true); },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (it) => m === "corr_ha" ? fmtHa(it.raw) : m === "corr_pct" ? fmt(it.raw, 1) + " %" : fmt(it.raw) } } },
        scales: { y: { ticks: { autoSkip: false, font: { size: 10.5 } } }, x: isMed ? { min: 0, max: 1 } : {} },
      },
    });
  }

  function downloadCsv() {
    const cols = ["vereda", "municipio", "codigo", "area_vereda_ha", "area_con_dato_caz2_ha", "umbral", "corredor_ha", "corredor_pct", "solo_coberturas_activas"];
    S.meta.rasters.forEach((r) => ["mediana", "sd", "min", "max", "media", "n_pix"].forEach((k) => cols.push(`${r.archivo.replace(".tif", "")}_${k}`)));
    const lines = [cols.join(",")];
    allStats().forEach(({ v, st }) => {
      const row = [`"${v.nombre}"`, `"${v.municipio}"`, v.codigo, st.areaHa.toFixed(2), st.cazHa.toFixed(2), S.thr, st.corrHa.toFixed(2), (st.cazHa ? 100 * st.corrHa / st.cazHa : 0).toFixed(2), st.filter ? "si" : "no"];
      S.meta.rasters.forEach((r) => { const s = st.rasters[r.id]; [s.mediana, s.sd, s.min, s.max, s.media].forEach((x) => row.push(x == null ? "" : x.toFixed(6))); row.push(s.n); });
      lines.push(row.join(","));
    });
    const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `veredas_cachicamo_umbral_${S.thr.toFixed(2)}${$("#filter-cob").checked ? "_coberturas_activas" : ""}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ------------------------------------------------------------------ panel coberturas (tabla del GPKG)
  function renderCobTab() {
    const r = rasterById(S.cobRaster), p = r.archivo.replace(".tif", "");
    const head = "<thead><tr><th>Cobertura</th><th>Mediana</th><th>SD</th><th>Mín</th><th>Máx</th><th>Píx.</th></tr></thead>";
    const body = S.meta.coberturas.map((c) => {
      const s = c.stats, g = (k) => s[`${p}_${k}`];
      return `<tr><td><span class="dot" style="background:${c.color}"></span>${c.nombre}<small>${fmtHa(s.area_ha)}</small></td><td><strong>${fmt(g("mediana"))}</strong></td><td>${fmt(g("sd"))}</td><td>${fmt(g("min"))}</td><td>${fmt(g("max"))}</td><td>${g("n_pix") == null ? "—" : g("n_pix").toLocaleString("es-CO")}</td></tr>`;
    }).join("");
    $("#cob-table").innerHTML = head + "<tbody>" + body + "</tbody>";

    const cobs = S.meta.coberturas;
    $("#box-cobglob").style.height = Math.max(200, 34 * cobs.length + 70) + "px";
    const palette = ["#0d5c6b", "#e07a1f", "#7b4fa0"];
    setChart("cobglob", "ch-cobglob", {
      type: "bar",
      data: {
        labels: cobs.map((c) => c.nombre),
        datasets: S.meta.rasters.map((rr, k) => ({ label: rr.corto, data: cobs.map((c) => c.stats[`${rr.archivo.replace(".tif", "")}_mediana`]), backgroundColor: palette[k % 3] })),
      },
      options: { indexAxis: "y", plugins: { legend: { display: true, position: "top", labels: { boxWidth: 12 } } }, scales: { x: { min: 0, max: 1 } } },
    });
  }

  // ------------------------------------------------------------------ coberturas dentro de los corredores
  // GeoJSON de polígonos de cobertura recortados a los corredores. Cada polígono se rasteriza
  // en la malla de 30 m (centro de píxel dentro del polígono) y se calcula la mediana del
  // modelo elegido. Los polígonos más pequeños que un píxel toman el valor del píxel de su centro.
  const CC_FILES = ["data/coberturas_corredores.geojson", "coberturas_corredores.geojson"];
  const CC_COLS = { cob_agrup_: "Cobertura agrupada", Cob_restau: "Restauración" };
  const CC_RAMP = ["#fff3b0", "#fecc5c", "#fd8d3c", "#e31a1c", "#9e0016"];
  const CC = {
    status: "idle", data: null, feats: [], layer: null, renderer: null,
    model: null, col: "cob_agrup_", active: {}, topN: null, op: 0.85, shown: [], meds: {}, minArea: 1,
  };

  function rampColor(t) {
    t = Math.min(1, Math.max(0, t)) * (CC_RAMP.length - 1);
    const i = Math.min(CC_RAMP.length - 2, Math.floor(t)), f = t - i;
    const a = parseInt(CC_RAMP[i].slice(1), 16), b = parseInt(CC_RAMP[i + 1].slice(1), 16);
    const ch = (sh) => Math.round(((a >> sh) & 255) * (1 - f) + ((b >> sh) & 255) * f);
    return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
  }

  // lon/lat -> coordenadas de píxel (fraccionarias) en la malla EPSG:3857
  function lonLatToPx(lon, lat) {
    const g = S.meta.grid;
    const x = R_EARTH * lon * Math.PI / 180;
    const y = R_EARTH * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
    return [(x - g.x0) / g.res, (g.y0 - y) / g.res];
  }

  // Rasteriza un Polygon/MultiPolygon: índices de los píxeles cuyo centro cae dentro (regla par-impar).
  function rasterizeGeom(geom) {
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
    const rings = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    polys.forEach((p) => p.forEach((ring) => {
      const r = ring.map(([lon, lat]) => lonLatToPx(lon, lat));
      r.forEach(([x, y]) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; });
      rings.push(r);
    }));
    const out = [];
    const rStart = Math.max(0, Math.floor(y0)), rEnd = Math.min(S.H - 1, Math.ceil(y1));
    const xs = [];
    for (let row = rStart; row <= rEnd; row++) {
      const yc = row + 0.5;
      xs.length = 0;
      for (const r of rings) {
        for (let k = 0, m = r.length - 1; k < r.length; m = k++) {
          const [xa, ya] = r[m], [xb, yb] = r[k];
          if ((ya <= yc) !== (yb <= yc)) xs.push(xa + (yc - ya) * (xb - xa) / (yb - ya));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil(xs[k] - 0.5)), c1 = Math.min(S.W - 1, Math.floor(xs[k + 1] - 0.5));
        for (let c = c0; c <= c1; c++) out.push(row * S.W + c);
      }
    }
    let fallback = false;
    if (!out.length && isFinite(x0)) {          // polígono más pequeño que un píxel: píxel del centro
      const c = Math.floor((x0 + x1) / 2), rr = Math.floor((y0 + y1) / 2);
      if (c >= 0 && rr >= 0 && c < S.W && rr < S.H) { out.push(rr * S.W + c); fallback = true; }
    }
    return { pix: Int32Array.from(out), fallback };
  }

  function ccMedians(model) {
    if (CC.meds[model]) return CC.meds[model];
    const d = S.data[model];
    const res = CC.feats.map((ft) => {
      const vals = [];
      for (const i of ft.pix) { const v = d[i]; if (v) vals.push((v - 1) / SCALE); }
      return vals.length ? describe(Float32Array.from(vals), vals.length) : null;
    });
    CC.meds[model] = res;
    return res;
  }

  function ccClassesOf(col) {
    const m = new Map();
    CC.feats.forEach((ft) => { const k = ft.props[col] ?? "(sin dato)"; m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), "es", { numeric: true }));
  }
  function ccColorOf(col, k) {
    if (col !== "cob_agrup_") return null;
    const c = S.meta.coberturas.find((x) => x.nombre === k);
    return c ? c.color : null;
  }

  async function ccLoad() {
    if (CC.status !== "idle") return;
    CC.status = "loading";
    try {
      let data = null;
      for (const f of CC_FILES) {
        const r = await fetch(f);
        if (r.ok) { data = await r.json(); break; }
      }
      if (!data) throw new Error("no se encontró data/coberturas_corredores.geojson");
      asegurarGrados(data);
      CC.data = data;
      CC.feats = data.features.filter((f) => f.geometry).map((f, k) => {
        const { pix, fallback } = rasterizeGeom(f.geometry);
        const p = f.properties || {};
        return { k, f, props: p, pix, fallback, area: p.area_ha ?? p.area_ha_1 ?? null, layer: null };
      });
      const byFeat = new Map(CC.feats.map((ft) => [ft.f, ft]));
      CC.renderer = L.canvas({ pane: "ccPane", padding: 0.3 });
      CC.layer = L.geoJSON({ type: "FeatureCollection", features: CC.feats.map((ft) => ft.f) }, {
        renderer: CC.renderer, pane: "ccPane", interactive: false,
        style: { weight: 0.6, color: "#5b0010", fillOpacity: 0.85, fillColor: "#fff3b0" },
        onEachFeature: (f, l) => { const ft = byFeat.get(f); if (ft) ft.layer = l; },
      });
      CC.model = S.meta.rasters[0].id;
      CC.status = "ready";
      ccInitUI();
      ccSetCol(CC.col);
      if ($("#cc-on").checked) CC.layer.addTo(map);
      $("#cc-loading").hidden = true; $("#cc-ui").hidden = false;
    } catch (err) {
      console.error(err);
      CC.status = "error";
      $("#cc-loading").innerHTML = `<p>No se pudieron cargar las coberturas de los corredores: ${err.message}.</p>`;
    }
  }

  function ccInitUI() {
    const seg = $("#cc-model");
    seg.innerHTML = S.meta.rasters.map((r) => `<button type="button" role="radio" aria-checked="${r.id === CC.model}" data-id="${r.id}">${r.nombre}</button>`).join("");
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-id]"); if (!b) return;
      seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", x === b));
      CC.model = b.dataset.id; CC.topN = null; ccRender();
    });
    const cs = $("#cc-col");
    cs.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-col]"); if (!b) return;
      cs.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", x === b));
      ccSetCol(b.dataset.col);
    });
    $("#cc-classes").addEventListener("change", (e) => {
      if (e.target.dataset.k == null) return;
      CC.active[e.target.dataset.k] = e.target.checked; CC.topN = null; ccRender();
    });
    const setAll = (on) => { Object.keys(CC.active).forEach((k) => { CC.active[k] = on; }); $("#cc-classes").querySelectorAll("input").forEach((i) => { i.checked = on; }); CC.topN = null; ccRender(); };
    $("#cc-all").addEventListener("click", () => setAll(true));
    $("#cc-none").addEventListener("click", () => setAll(false));
    $("#cc-top").addEventListener("input", (e) => { CC.topN = +e.target.value; ccPaint(); ccSummary(); });
    $("#cc-on").addEventListener("change", (e) => { if (e.target.checked) CC.layer.addTo(map); else map.removeLayer(CC.layer); });
    $("#cc-op").addEventListener("input", (e) => { CC.op = +e.target.value; ccPaint(); });
    $("#cc-rank").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-k]"); if (!tr) return;
      const ft = CC.feats[+tr.dataset.k];
      if (ft && ft.layer) {
        if (!map.hasLayer(CC.layer)) { $("#cc-on").checked = true; CC.layer.addTo(map); }
        map.fitBounds(ft.layer.getBounds(), { padding: [60, 60], maxZoom: 15 });
        const fl = L.geoJSON(ft.f, { pane: "verPane", interactive: false, style: { color: "#00e5ff", weight: 4, fill: false } }).addTo(map);
        setTimeout(() => map.removeLayer(fl), 2500);
      }
    });
    $("#cc-csv").addEventListener("click", ccCsv);
    $("#cc-minarea").addEventListener("change", (e) => { CC.minArea = +e.target.value; CC.topN = null; ccRender(); });
  }

  function ccSetCol(col) {
    CC.col = col; CC.active = {}; CC.topN = null;
    const list = ccClassesOf(col);
    list.forEach(([k]) => { CC.active[k] = true; });
    $("#cc-classes").innerHTML = list.map(([k, n]) => {
      const c = ccColorOf(col, k);
      return `<li><label><input type="checkbox" data-k="${k}" checked>${c ? `<span class="sw" style="background:${c}"></span>` : ""}${k}<span class="n">${n}</span></label></li>`;
    }).join("");
    ccRender();
  }

  const ccAreaOk = (ft) => !CC.minArea || (ft.area != null ? ft.area : ft.pix.length * 0.09) >= CC.minArea;
  // Polígonos filtrados (tipo y área mínima) y con dato, ordenados de mayor a menor mediana
  function ccFiltered() {
    const meds = ccMedians(CC.model);
    return CC.feats.filter((ft) => CC.active[ft.props[CC.col] ?? "(sin dato)"] && meds[ft.k] && ccAreaOk(ft))
      .map((ft) => ({ ft, st: meds[ft.k] }))
      .sort((a, b) => (b.st.mediana - a.st.mediana) || ((b.ft.area || 0) - (a.ft.area || 0)));   // empate: el más grande primero
  }

  function ccRender() {
    if (CC.status !== "ready") return;
    CC.shown = ccFiltered();
    const n = CC.shown.length, top = $("#cc-top");
    top.max = Math.max(1, n);
    if (CC.topN == null || CC.topN > n) CC.topN = Math.max(1, Math.round(n * 0.1));
    top.value = CC.topN;
    top.disabled = !n;
    ccPaint(); ccSummary();
  }

  // Colores: los N con mayor mediana en rampa amarillo-rojo (más rojo = mayor);
  // el resto de los filtrados en gris claro; los no filtrados se ocultan.
  function ccPaint() {
    if (CC.status !== "ready") return;
    const rank = new Map();
    CC.shown.forEach((d, i) => rank.set(d.ft.k, i));
    const N = Math.min(CC.topN || 0, CC.shown.length), op = CC.op;
    const hi = N ? CC.shown[0].st.mediana : 0, lo = N ? CC.shown[N - 1].st.mediana : 0;
    CC.feats.forEach((ft) => {
      if (!ft.layer) return;
      const i = rank.get(ft.k);
      if (i == null) { ft.layer.setStyle({ opacity: 0, fillOpacity: 0 }); return; }
      if (i < N) {
        const m = CC.shown[i].st.mediana, t = hi > lo ? (m - lo) / (hi - lo) : 1;
        ft.layer.setStyle({ fillColor: rampColor(0.25 + 0.75 * t), color: "#5b0010", weight: 0.8, opacity: op, fillOpacity: 0.9 * op });
      } else {
        ft.layer.setStyle({ fillColor: "#e9ecea", color: "#8a948f", weight: 0.4, opacity: 0.7 * op, fillOpacity: 0.8 * op });
      }
    });
    $("#cc-top-lbl").textContent = N ? `${N.toLocaleString("es-CO")} de ${CC.shown.length.toLocaleString("es-CO")}` : "—";
    $("#cc-leg-min").textContent = N ? `${fmt(lo)} (menor del grupo)` : "menor mediana";
    $("#cc-leg-max").textContent = N ? `${fmt(hi)} (mayor)` : "mayor mediana";
  }

  function ccSummary() {
    const shown = CC.shown, N = Math.min(CC.topN || 0, shown.length);
    const sumA = (arr) => arr.reduce((s, d) => s + (d.ft.area || 0), 0);
    const r = rasterById(CC.model);
    $("#cc-kpi-n").textContent = shown.length.toLocaleString("es-CO");
    $("#cc-kpi-n-lbl").textContent = `polígonos filtrados con dato de ${r.corto}, ${fmtHa(sumA(shown))}`;
    $("#cc-kpi-top").textContent = N.toLocaleString("es-CO");
    $("#cc-kpi-top-lbl").textContent = `en rojo, con mediana ≥ ${N ? fmt(shown[N - 1].st.mediana) : "—"}, ${fmtHa(sumA(shown.slice(0, N)))}`;

    // resumen por tipo: mediana con todos los píxeles del tipo
    const d = S.data[CC.model], groups = new Map();
    shown.forEach((x, i) => {
      const k = x.ft.props[CC.col] ?? "(sin dato)";
      if (!groups.has(k)) groups.set(k, { n: 0, top: 0, area: 0, vals: [] });
      const gr = groups.get(k);
      gr.n++; if (i < N) gr.top++; gr.area += x.ft.area || 0;
      for (const p of x.ft.pix) { const v = d[p]; if (v) gr.vals.push((v - 1) / SCALE); }
    });
    const rows = [...groups.entries()].map(([k, gr]) => ({ k, ...gr, st: describe(Float32Array.from(gr.vals), gr.vals.length) }))
      .sort((a, b) => b.st.mediana - a.st.mediana);
    $("#cc-sum").innerHTML = "<thead><tr><th>Tipo</th><th>Polígonos</th><th>En rojo</th><th>Área</th><th>Mediana</th><th>Máx</th></tr></thead><tbody>" +
      rows.map((x) => {
        const c = ccColorOf(CC.col, x.k);
        return `<tr><td>${c ? `<span class="dot" style="background:${c}"></span>` : ""}${x.k}</td><td>${x.n.toLocaleString("es-CO")}</td><td>${x.top.toLocaleString("es-CO")}</td><td>${fmtHa(x.area)}</td><td><strong>${fmt(x.st.mediana)}</strong></td><td>${fmt(x.st.max)}</td></tr>`;
      }).join("") + "</tbody>";

    const otro = CC.col === "cob_agrup_" ? "Cob_restau" : "cob_agrup_";
    $("#cc-rank").innerHTML = `<thead><tr><th>#</th><th>${CC_COLS[CC.col]}</th><th>${CC_COLS[otro]}</th><th>Mediana</th><th>Área</th></tr></thead><tbody>` +
      shown.slice(0, 20).map((x, i) => `<tr data-k="${x.ft.k}"><td>${i + 1}</td><td><span class="sq" style="background:${i < N ? rampColor(0.25 + 0.75 * (N > 1 ? (x.st.mediana - shown[N - 1].st.mediana) / ((shown[0].st.mediana - shown[N - 1].st.mediana) || 1) : 1)) : "#e9ecea"}"></span>${x.ft.props[CC.col] ?? "—"}</td><td>${x.ft.props[otro] ?? "—"}</td><td><strong>${fmt(x.st.mediana)}</strong></td><td>${fmtHa(x.ft.area)}</td></tr>`).join("") + "</tbody>";

    const nFb = shown.filter((x) => x.ft.fallback).length;
    const nTipo = CC.feats.filter((ft) => CC.active[ft.props[CC.col] ?? "(sin dato)"]);
    const nPeq = nTipo.filter((ft) => !ccAreaOk(ft)).length;
    const nSin = nTipo.filter((ft) => ccAreaOk(ft) && !ccMedians(CC.model)[ft.k]).length;
    const partes = [];
    if (nPeq) partes.push(`${nPeq.toLocaleString("es-CO")} polígonos de los tipos elegidos quedan fuera por ser menores al área mínima.`);
    if (nSin) partes.push(`${nSin.toLocaleString("es-CO")} no tienen dato de ${r.corto} (fuera de lo que prioriza ese modelo) y no se cuentan.`);
    if (nFb) partes.push(`${nFb.toLocaleString("es-CO")} son más pequeños que un píxel de 30 m y toman el valor del píxel de su centro.`);
    $("#cc-note").textContent = partes.join(" ");
  }

  function ccCsv() {
    const models = S.meta.rasters;
    const cols = ["fid", "cob_agrup_", "Cob_restau", "cobertura_", "area_ha", "n_pix", "menor_que_pixel"];
    models.forEach((m) => ["mediana", "sd", "min", "max"].forEach((k) => cols.push(`${m.archivo.replace(".tif", "")}_${k}`)));
    cols.push(`rango_${rasterById(CC.model).archivo.replace(".tif", "")}`);
    const all = Object.fromEntries(models.map((m) => [m.id, ccMedians(m.id)]));
    const q = (v) => (v == null ? "" : `"${String(v).replace(/"/g, '""')}"`);
    const lines = [cols.join(",")];
    CC.shown.forEach((x, i) => {
      const p = x.ft.props;
      const row = [p.fid ?? x.ft.k, q(p.cob_agrup_), q(p.Cob_restau), q(p.cobertura_), x.ft.area == null ? "" : x.ft.area.toFixed(4), x.ft.pix.length, x.ft.fallback ? "si" : "no"];
      models.forEach((m) => { const s = all[m.id][x.ft.k]; [s && s.mediana, s && s.sd, s && s.min, s && s.max].forEach((v) => row.push(v == null ? "" : v.toFixed(6))); });
      row.push(i + 1);
      lines.push(row.join(","));
    });
    const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `coberturas_corredores_${CC.model}_${CC.col}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Para el popup del clic en el mapa
  function ccAt(latlng) {
    if (CC.status !== "ready" || !map.hasLayer(CC.layer)) return "";
    const rank = new Map(); CC.shown.forEach((d, i) => rank.set(d.ft.k, i));
    const hit = CC.feats.find((ft) => rank.has(ft.k) && ft.layer && ft.layer.getBounds().contains(latlng) && pointInGeom(latlng.lng, latlng.lat, ft.f.geometry));
    if (!hit) return "";
    const st = ccMedians(CC.model)[hit.k], p = hit.props, i = rank.get(hit.k);
    return `<h5>Cobertura en corredor</h5><table>
      <tr><td>Cobertura agrupada</td><td>${p.cob_agrup_ ?? "—"}</td></tr>
      <tr><td>Restauración</td><td>${p.Cob_restau ?? "—"}</td></tr>
      <tr><td>Cobertura</td><td>${p.cobertura_ ?? "—"}</td></tr>
      <tr><td>Mediana ${rasterById(CC.model).corto}</td><td>${st ? fmt(st.mediana) : "—"}</td></tr>
      <tr><td>Puesto</td><td>${(i + 1).toLocaleString("es-CO")} de ${CC.shown.length.toLocaleString("es-CO")}</td></tr>
      <tr><td>Área</td><td>${fmtHa(hit.area)}</td></tr></table>`;
  }

  // ------------------------------------------------------------------ UI
  function showTab(name) {
    document.querySelectorAll(".tab").forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle("is-active", on); t.setAttribute("aria-selected", on); });
    document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("is-active", p.id === "tab-" + name));
    if (name === "veredas") { renderVereda(); renderCompare(); }
    if (name === "coberturas") renderCobTab();
    if (name === "corredores") ccLoad();
  }

  function segmented(container, current, onPick) {
    const el = $(container);
    el.innerHTML = S.meta.rasters.map((r) => `<button type="button" role="radio" aria-checked="${r.id === current}" data-id="${r.id}">${r.nombre}</button>`).join("");
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-id]"); if (!b) return;
      el.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", x === b));
      onPick(b.dataset.id);
    });
  }

  let rafThr = 0, verTimer = 0;
  function setThreshold(v, fromNum) {
    v = Math.min(1, Math.max(0, +v || 0));
    S.thr = Math.round(v * 100) / 100;
    if (fromNum) $("#corr-thr").value = S.thr; else $("#corr-thr-num").value = S.thr.toFixed(2);
    cancelAnimationFrame(rafThr);
    rafThr = requestAnimationFrame(paintCorridor);
    clearTimeout(verTimer);
    verTimer = setTimeout(() => { if ($("#tab-veredas").classList.contains("is-active")) { renderVereda(); renderCompare(); } }, 250);
  }

  function initUI() {
    // pestañas
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

    // leyenda turbo
    $("#turbo-bar").style.background = `linear-gradient(90deg, ${Array.from({ length: 11 }, (_, k) => turboCss(k / 10)).join(",")})`;

    // corredores de vida
    $("#cv-list").innerHTML = CV_LAYERS.map((c) => `
      <div class="layer" data-cv="${c.id}">
        <label class="layer-head"><input type="checkbox" data-cv="${c.id}" ${c.on ? "checked" : ""}>
          <span class="sw sw--cv" aria-hidden="true" style="border-color:${c.style.color};background:${c.style.fillOpacity ? c.style.fillColor + "66" : (c.style.color === "#ffffff" ? "#55625b" : "transparent")}${c.style.dashArray ? ";border-style:dashed" : ""}"></span>
          <span class="layer-name">${c.nombre}</span></label>
        <div class="opacity"><label>Opacidad <input type="range" class="op-cv" data-cv="${c.id}" min="0" max="1" step="0.05" value="1"></label></div>
      </div>`).join("");
    $("#cv-list").addEventListener("change", (e) => {
      const id = e.target.dataset.cv, L_ = S.cv[id];
      if (!id || !L_ || e.target.type !== "checkbox") return;
      if (e.target.checked) L_.layer.addTo(map); else map.removeLayer(L_.layer);
    });
    $("#cv-list").addEventListener("input", (e) => {
      if (!e.target.classList.contains("op-cv")) return;
      const c = CV_LAYERS.find((x) => x.id === e.target.dataset.cv), L_ = S.cv[c.id];
      if (!L_) return;
      L_.main.setStyle(cvStyle(c, +e.target.value));
      if (L_.halo) L_.halo.setStyle(haloStyle(c, +e.target.value));
    });

    // lista de rásters
    $("#raster-list").innerHTML = S.meta.rasters.map((r, k) => `
      <div class="layer">
        <label class="layer-head"><input type="checkbox" data-raster="${r.id}" ${k === 0 ? "checked" : ""}>
          <span class="sw sw--turbo" aria-hidden="true"></span><span class="layer-name">${r.nombre}</span></label>
        <span class="layer-file">${r.archivo}</span>
        <div class="opacity"><label>Opacidad <input type="range" class="op" data-layer="${r.id}" min="0" max="1" step="0.05" value="0.85"></label></div>
      </div>`).join("");
    $("#raster-list").addEventListener("change", (e) => { if (e.target.dataset.raster) toggleLayer(e.target.dataset.raster, e.target.checked); });
    toggleLayer(S.meta.rasters[0].id, true);

    // opacidades
    document.addEventListener("input", (e) => { if (e.target.classList.contains("op")) S.layers[e.target.dataset.layer].layer.setOpacity(+e.target.value); });

    // corredor
    $("#corr-on").addEventListener("change", (e) => toggleLayer("corridor", e.target.checked));
    $("#corr-thr").addEventListener("input", (e) => setThreshold(e.target.value, false));
    $("#corr-thr-num").addEventListener("change", (e) => setThreshold(e.target.value, true));

    // coberturas
    const cl = $("#cob-list");
    cl.innerHTML = S.meta.coberturas.map((c) => `<li data-code="${c.code}"><label><input type="checkbox" data-code="${c.code}" checked><span class="sw" style="background:${c.color}"></span>${c.nombre}</label></li>`).join("");
    const cobChanged = () => {
      cl.querySelectorAll("li").forEach((li) => li.classList.toggle("off", !S.cobActive[+li.dataset.code]));
      paintCob();
      if ($("#tab-veredas").classList.contains("is-active")) { renderVereda(); renderCompare(); }
    };
    cl.addEventListener("change", (e) => { const c = +e.target.dataset.code; if (c) { S.cobActive[c] = e.target.checked; cobChanged(); } });
    const setAll = (on) => { S.meta.coberturas.forEach((c) => { S.cobActive[c.code] = on; }); cl.querySelectorAll("input").forEach((i) => { i.checked = on; }); cobChanged(); };
    $("#cob-all").addEventListener("click", () => setAll(true));
    $("#cob-none").addEventListener("click", () => setAll(false));
    $("#cob-on").addEventListener("change", (e) => toggleLayer("cob", e.target.checked));

    // veredas
    $("#ver-on").addEventListener("change", (e) => { if (e.target.checked) verLayer.addTo(map); else map.removeLayer(verLayer); });
    document.querySelectorAll('input[name="base"]').forEach((r) => r.addEventListener("change", (e) => setBase(e.target.value)));
    const sel = $("#ver-select");
    S.meta.veredas.slice().sort((a, b) => a.nombre.localeCompare(b.nombre, "es")).forEach((v) => {
      const o = document.createElement("option"); o.value = v.vid; o.textContent = `${v.nombre} (${v.municipio})` + (v.conDato ? "" : ", sin datos"); sel.appendChild(o);
    });
    sel.addEventListener("change", () => selectVereda(+sel.value || null, true));
    segmented("#raster-seg", S.selRaster, (id) => { S.selRaster = id; renderVereda(); });
    $("#filter-cob").addEventListener("change", () => { renderVereda(); renderCompare(); });
    const cm = $("#cmp-metric");
    cmpMetrics().forEach((m) => { const o = document.createElement("option"); o.value = m.id; o.textContent = m.nombre; cm.appendChild(o); });
    cm.addEventListener("change", renderCompare);
    $("#csv-btn").addEventListener("click", downloadCsv);

    // coberturas (tabla)
    segmented("#cob-seg", S.cobRaster, (id) => { S.cobRaster = id; renderCobTab(); });
  }

  // ------------------------------------------------------------------ arranque
  async function start() {
    try {
      const meta = await (await fetch("data/meta.json")).json();
      S.meta = meta; S.W = meta.grid.width; S.H = meta.grid.height; S.N = S.W * S.H;
      S.selRaster = S.cobRaster = meta.rasters[0].id;
      meta.coberturas.forEach((c) => { S.cobActive[c.code] = true; });
      S.cobActive[0] = false;
      toLoad = meta.rasters.length + 3;
      progress("Cargando rásters…");

      const jobs = meta.rasters.map((r) => loadBin(r.file, Uint16Array).then((a) => { S.data[r.id] = a; progress(`Cargado: ${r.nombre}`); }));
      jobs.push(loadBin("data/coberturas.u8.gz", Uint8Array).then((a) => { S.cob = a; progress(); }));
      jobs.push(loadBin("data/veredas.u8.gz", Uint8Array).then((a) => { S.ver = a; progress(); }));
      let geo;
      jobs.push(fetch("data/veredas.geojson").then((r) => r.json()).then((g) => { geo = g; progress(); }));
      await Promise.all(jobs);

      buildIndex();
      S.meta.veredas.forEach((v) => { let n = 0; for (let k = S.verOff[v.vid]; k < S.verOff[v.vid + 1] && !n; k++) if (S.data.caz2[S.verIdx[k]]) n = 1; v.conDato = !!n; });
      initMap();
      paintCob();
      verLayer = L.geoJSON(geo, {
        pane: "verPane",
        style: { color: "#ffffff", weight: 1.3, opacity: 0.9, fill: true, fillOpacity: 0 },
        onEachFeature: (f, l) => l.bindTooltip(f.properties.nombre, { sticky: true, className: "ver-tip" }),
      }).addTo(map);
      initUI();
      await loadCV();
      $("#loader").hidden = true;
    } catch (err) {
      console.error(err);
      $("#loader-msg").textContent = location.protocol === "file:"
        ? "Abre el sitio desde un servidor (GitHub Pages o «python -m http.server»), no como archivo local."
        : "No se pudieron cargar los datos: " + err.message;
    }
  }
  start();
})();

/* Botón "Otros": ventana con escenarios, gráficas e infografías */
(function () {
  if (window.__cachicamoOtros) return;
  window.__cachicamoOtros = true;
  const otros = document.getElementById("otros");
  if (!otros) return;
  document.getElementById("btn-otros").addEventListener("click", () => otros.showModal());
  document.getElementById("otros-close").addEventListener("click", () => otros.close());
  otros.addEventListener("click", (e) => { if (e.target === otros) otros.close(); });

  // cambiar de escenario
  const seg = document.getElementById("esc-seg");
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-esc]");
    if (!b) return;
    seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", x === b));
    otros.querySelectorAll("article.esc").forEach((a) => { a.hidden = a.dataset.esc !== b.dataset.esc; });
    otros.querySelector(".otros-body").scrollTop = 0;
    otros.scrollTop = 0;
  });

  // ampliar figuras
  const dlg = document.createElement("dialog");
  dlg.className = "lightbox";
  dlg.innerHTML = '<img alt="">';
  document.body.appendChild(dlg);
  const big = dlg.querySelector("img");
  dlg.addEventListener("click", () => dlg.close());
  otros.addEventListener("click", (e) => {
    const a = e.target.closest("a.zoom");
    if (!a) return;
    e.preventDefault();
    big.src = a.getAttribute("href");
    big.alt = (a.querySelector("img") || {}).alt || "";
    dlg.showModal();
  });

  // ocultar figuras que aún no estén en el repositorio
  otros.querySelectorAll("a.zoom img").forEach((img) => {
    img.addEventListener("error", () => { img.closest("a.zoom").hidden = true; });
  });
})();
