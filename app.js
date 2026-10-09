/* Focalización Cachicamo: visor y estadísticas en el navegador.
   Los rásters llegan como uint16 (0 = sin dato; valor = (v-1)/65534) en malla EPSG:3857.
   Coberturas y veredas llegan como uint8 en la misma malla. */
(function () {
  "use strict";

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
    charts: {},
    cache: {},
  };
  const SCALE = 65534;
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

    const panes = [["rasterPane", 402], ["cobPane", 403], ["corrPane", 405], ["verPane", 450]];
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
    const html = `<div class="pop"><h4>${ver ? "Vereda " + ver.nombre : "Fuera de las veredas"}</h4>
      <table>${rows}</table>
      ${ver ? `<button type="button" data-vid="${ver.vid}">Ver estadísticas de la vereda</button>` : ""}</div>`;
    const pop = L.popup().setLatLng(e.latlng).setContent(html).openOn(map);
    const btn = pop.getElement().querySelector("button[data-vid]");
    if (btn) btn.addEventListener("click", () => { selectVereda(+btn.dataset.vid, true); showTab("veredas"); map.closePopup(); });
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

  // ------------------------------------------------------------------ UI
  function showTab(name) {
    document.querySelectorAll(".tab").forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle("is-active", on); t.setAttribute("aria-selected", on); });
    document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("is-active", p.id === "tab-" + name));
    if (name === "veredas") { renderVereda(); renderCompare(); }
    if (name === "coberturas") renderCobTab();
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

/* Escenarios: ampliar figuras y ocultar las que no existan */
(function () {
  const dlg = document.createElement("dialog");
  dlg.className = "lightbox";
  dlg.innerHTML = '<img alt="">';
  document.body.appendChild(dlg);
  const big = dlg.querySelector("img");
  dlg.addEventListener("click", () => dlg.close());
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a.zoom");
    if (!a) return;
    e.preventDefault();
    big.src = a.getAttribute("href");
    big.alt = (a.querySelector("img") || {}).alt || "";
    dlg.showModal();
  });
  document.querySelectorAll("a.zoom img").forEach((img) => {
    img.addEventListener("error", () => { img.closest("a.zoom").hidden = true; });
  });
})();
