const productButtons = document.getElementById("productButtons");
const statusBox = document.getElementById("statusBox");
const legendTitle = document.getElementById("legendTitle");
const legendBar = document.querySelector(".legend-bar");
const legendTicks = document.getElementById("legendTicks");
const legendLabels = document.querySelector(".legend-labels");
const legendMin = document.getElementById("legendMin");
const legendMax = document.getElementById("legendMax");
const opacitySlider = document.getElementById("opacitySlider");
const opacityValue = document.getElementById("opacityValue");
const forecastSlider = document.getElementById("forecastSlider");
const forecastLabel = document.getElementById("forecastLabel");
const runSelect = document.getElementById("runSelect");

const MAX_PALETTE_STOPS = 12;

let map;
let reflectivityLayer;
let mapReadyPromise;
let appConfig;
let loadSequence = 0;
let frameHistory = [];
let hoverPopup;
let currentProductId = "";
let currentFrameSourceUrl = "";
let currentOpacity = 0.82;
let shouldFitBoundsOnNextLoad = true;
// keyAutoAdvance uses requestAnimationFrame for smoother, faster stepping
let keyAutoAdvance = { rafId: null, direction: 0, lastTs: 0, intervalMs: 30 };
// In-memory cache for fetched datasets keyed by sourceUrl
const datasetCache = new Map(); // sourceUrl -> { metadata, textureBytes, smoothed: { [window]: Uint8Array } }
// Temporal smoothing settings (odd window size preferred)
const SMOOTH_WINDOW = 3;
const SMOOTHING_ENABLED = true;

// Helper to stop pointer/touch events from being captured by the map
const stopCapture = (ev) => {
  try { ev.preventDefault(); } catch (e) {}
  try { ev.stopPropagation(); } catch (e) {}
  try { if (ev.stopImmediatePropagation) ev.stopImmediatePropagation(); } catch (e) {}
};

function isTypingTarget(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable
  );
}

function currentSourceUrl() {
  return currentFrameSourceUrl || appConfig?.defaultSourceUrl || "";
}

function currentProduct() {
  return appConfig?.products?.find((product) => product.id === currentProductId) || appConfig?.products?.[0] || null;
}

function updateOpacityLabel(opacity) {
  if (opacityValue) {
    opacityValue.textContent = `${Math.round(opacity * 100)}%`;
  }
}

function setLayerOpacity(opacity) {
  currentOpacity = opacity;
  updateOpacityLabel(opacity);
  if (reflectivityLayer) {
    reflectivityLayer.setOpacity(opacity);
  }
}

function initOpacityControl() {
  if (!opacitySlider) {
    return;
  }

  updateOpacityLabel(currentOpacity);
  opacitySlider.value = String(Math.round(currentOpacity * 100));
  opacitySlider.addEventListener("input", () => {
    const nextOpacity = Number(opacitySlider.value) / 100;
    setLayerOpacity(Number.isFinite(nextOpacity) ? nextOpacity : currentOpacity);
  });
}

function renderProductButtons() {
  if (!productButtons || !appConfig?.products?.length) {
    return;
  }

  productButtons.innerHTML = appConfig.products
    .map((product) => {
      const activeClass = product.id === currentProductId ? " is-active" : "";
      return `<button type="button" class="product-button${activeClass}" data-product-id="${product.id}">${product.label}</button>`;
    })
    .join("");

  for (const button of productButtons.querySelectorAll(".product-button")) {
    button.addEventListener("click", () => {
      const nextProductId = button.getAttribute("data-product-id") || "";
      if (!nextProductId || nextProductId === currentProductId) {
        return;
      }

      currentProductId = nextProductId;
      currentFrameSourceUrl = currentProduct()?.sourceUrl || "";
      renderProductButtons();
      void refreshLatestFrame();
    });
  }
}

// temperature button removed from UI

function renderForecastSlider() {
  if (!forecastSlider || !forecastLabel) return;
  const count = frameHistory.length || 0;
  forecastSlider.min = 0;
  forecastSlider.max = Math.max(0, count - 1);
  const idx = currentForecastIndex();
  const value = idx === -1 ? 0 : idx;
  forecastSlider.value = String(value);
  forecastLabel.textContent = (frameHistory[value]?.label) || "f000";
}

async function fetchRuns(sourceUrl) {
  try {
    const resp = await fetch(`/api/reflectivity/runs?source=${encodeURIComponent(sourceUrl)}`);
    const payload = await resp.json();
    if (!resp.ok) throw new Error(payload.error || 'Failed to fetch runs');
    return payload.runs || [];
  } catch (err) {
    return [];
  }
}

async function renderRunSelector() {
  if (!runSelect) return;
  const productSource = currentProduct()?.sourceUrl || appConfig.defaultSourceUrl;
  const runs = await fetchRuns(productSource);
  // Build options, marking unavailable runs as disabled
  runSelect.innerHTML = runs
    .map((r) => {
      const label = r.available ? r.label : `${r.label} (unavailable)`;
      // allow selection even if the backend couldn't probe availability;
      // we'll attempt to load the selected run on demand
      return `<option value="${r.sourceUrl}">${label}</option>`;
    })
    .join("");

  // Auto-select first available run if present, otherwise keep first
  let defaultIndex = 0;
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].available) { defaultIndex = i; break; }
  }
  if (runs.length) {
    runSelect.value = runs[defaultIndex].sourceUrl;
    // Prefer the first available run as the current source for subsequent loads
    if (runs[defaultIndex]?.available) {
      currentFrameSourceUrl = runs[defaultIndex].sourceUrl;
    }
  }

  runSelect.onchange = async () => {
    const selectedUrl = runSelect.value;
    const run = runs.find((r) => r.sourceUrl === selectedUrl) || null;
    if (!run) return;
    // use the run's sourceUrl as the seed for frames and attempt to load it.
    // Do NOT force 'latest' product URL; let refreshFrameHistory use the
    // selected run URL (currentFrameSourceUrl) so the frame list is built
    // from the chosen run and dynamic fNNN URLs are generated correctly.
    currentFrameSourceUrl = run.sourceUrl;
    // preserve current map zoom/center when switching runs
    shouldFitBoundsOnNextLoad = false;
    setStatus(`Loading run ${run.label}...`);
    try {
      await refreshFrameHistory();
      await loadDataset();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };
}

if (forecastSlider) {
  forecastSlider.addEventListener("input", () => {
    const idx = Number(forecastSlider.value);
    shouldFitBoundsOnNextLoad = false;
    selectForecastByIndex(Number.isFinite(idx) ? idx : 0);
  });
  // prevent map from capturing pointer events while dragging the slider
  const stopPropagationOnly = (ev) => { try { ev.stopPropagation(); } catch (e) {} };
  // stop propagation so the map doesn't also handle the events, but don't call preventDefault()
  forecastSlider.addEventListener("pointerdown", stopPropagationOnly, { capture: true });
  forecastSlider.addEventListener("pointermove", stopPropagationOnly, { capture: true });
  forecastSlider.addEventListener("mousedown", stopPropagationOnly, { capture: true });
  forecastSlider.addEventListener("touchstart", stopPropagationOnly, { capture: true });
}

function setLegendPalette(palette) {
  if (!legendBar || !legendTitle || !palette) {
    return;
  }

  legendTitle.textContent = palette.label || "Scale";
  legendBar.style.background = `linear-gradient(90deg, ${palette.colors.join(", ")})`;
}

function paletteStops(palette) {
  return Array.isArray(palette?.values) ? palette.values : [];
}

function paddedPaletteStops(palette) {
  const stops = paletteStops(palette).slice(0, MAX_PALETTE_STOPS);
  if (!stops.length) {
    return new Float32Array(MAX_PALETTE_STOPS);
  }

  const padded = [...stops];
  while (padded.length < MAX_PALETTE_STOPS) {
    padded.push(stops[stops.length - 1]);
  }

  return new Float32Array(padded);
}

function paddedPaletteColors(palette) {
  const colors = Array.isArray(palette?.colors) ? palette.colors.slice(0, MAX_PALETTE_STOPS) : [];
  if (!colors.length) {
    // default to white if no colors
    const out = new Float32Array(MAX_PALETTE_STOPS * 3);
    for (let i = 0; i < MAX_PALETTE_STOPS; i++) {
      out[i * 3 + 0] = 1.0;
      out[i * 3 + 1] = 1.0;
      out[i * 3 + 2] = 1.0;
    }
    return out;
  }

  const padded = colors.slice();
  while (padded.length < MAX_PALETTE_STOPS) padded.push(padded[padded.length - 1]);

  const out = new Float32Array(MAX_PALETTE_STOPS * 3);
  for (let i = 0; i < MAX_PALETTE_STOPS; i++) {
    const hex = padded[i] || "#ffffff";
    const r = parseInt(hex.slice(1, 3), 16) / 255.0;
    const g = parseInt(hex.slice(3, 5), 16) / 255.0;
    const b = parseInt(hex.slice(5, 7), 16) / 255.0;
    out[i * 3 + 0] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}

function renderLegendTicks(palette) {
  if (!legendTicks) {
    return;
  }

  const stops = paletteStops(palette);
  if (!palette?.discrete || !stops.length) {
    legendTicks.innerHTML = "";
    legendTicks.hidden = true;
    return;
  }

  const labels = Array.isArray(palette.labels) && palette.labels.length === stops.length
    ? palette.labels
    : stops.map((value) => String(value));

  legendTicks.innerHTML = labels
    .map(
      (label, index) =>
        `<span class="legend-tick" style="--legend-tick-color: ${palette.colors[index] || "var(--accent)"}">${label}</span>`,
    )
    .join("");
  legendTicks.hidden = false;
}

function formatValue(value, units) {
  if (units === "ID") {
    return String(Math.round(value));
  }

  if (units === "in") {
    return value.toFixed(value < 1 ? 2 : 1);
  }

  return value.toFixed(1);
}

async function refreshLatestFrame() {
  try {
    await refreshFrameHistory({ forceLatest: true });
    await loadDataset();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

async function fetchFrameHistory(sourceUrl) {
  const response = await fetch(`/api/reflectivity/history?source=${encodeURIComponent(sourceUrl)}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "History request failed.");
  }

  return payload.frames || [];
}

async function refreshFrameHistory({ forceLatest = false } = {}) {
  const productSourceUrl = currentProduct()?.sourceUrl || appConfig.defaultSourceUrl;
  const seedSourceUrl = forceLatest ? productSourceUrl : currentSourceUrl() || productSourceUrl;
  frameHistory = await fetchFrameHistory(seedSourceUrl);

  // If server returned no explicit history, synthesize a full f000..f384 list
  if (!Array.isArray(frameHistory) || frameHistory.length === 0) {
    const fallbackSource = forceLatest ? productSourceUrl : seedSourceUrl;
    // Try to construct entries for f000..f384 in 6-hour steps
    const makeUrlForHour = (hour) => {
      try {
        const u = new URL(fallbackSource);
        const padded = `f${String(hour).padStart(3, "0")}`;
        const fileParam = u.searchParams.get("file");
        if (fileParam) {
          const newFile = fileParam.replace(/f\d{3}/, padded);
          const copy = new URL(u.toString());
          copy.searchParams.set("file", newFile);
          return copy.toString();
        }

        if (/f\d{3}/.test(u.pathname)) {
          const copy = new URL(u.toString());
          copy.pathname = copy.pathname.replace(/f\d{3}/, padded);
          return copy.toString();
        }

        return fallbackSource;
      } catch (e) {
        return fallbackSource;
      }
    };

    const synthesized = [];
    for (let h = 0; h <= 384; h += 6) {
      synthesized.push({ label: `f${String(h).padStart(3, "0")}`, sourceUrl: makeUrlForHour(h) });
    }

    frameHistory = synthesized;
    currentFrameSourceUrl = frameHistory[0]?.sourceUrl || fallbackSource;
    renderForecastSlider();
    return;
  }

  const fallbackSource = forceLatest ? productSourceUrl : seedSourceUrl;
  currentFrameSourceUrl = frameHistory.some((entry) => entry.sourceUrl === fallbackSource)
    ? fallbackSource
    : (frameHistory[0]?.sourceUrl || fallbackSource);
  renderForecastSlider();
}

function currentForecastIndex() {
  return frameHistory.findIndex((entry) => entry.sourceUrl === currentSourceUrl());
}

function selectForecastByIndex(index) {
  if (!frameHistory.length) return;
  if (index < 0) index = 0;
  if (index >= frameHistory.length) index = frameHistory.length - 1;
  const entry = frameHistory[index];
  if (!entry) return;
  currentFrameSourceUrl = entry.sourceUrl;
  // update UI slider/label immediately
  if (forecastSlider) {
    forecastSlider.value = String(index);
  }
  if (forecastLabel) {
    forecastLabel.textContent = entry.label || forecastLabel.textContent;
  }
  // Don't refit bounds when stepping frames interactively
  shouldFitBoundsOnNextLoad = false;
  void loadDataset();

  // Kick off a background prefetch for the next frame (if any)
  const next = frameHistory[index + 1];
  if (next?.sourceUrl) {
    fetch(`/api/reflectivity/prefetch?source=${encodeURIComponent(next.sourceUrl)}`).catch(() => {});
  }
}

function selectNextForecast(delta) {
  const idx = currentForecastIndex();
  if (idx === -1) return selectForecastByIndex(0);
  const nextIndex = idx + delta;
  if (nextIndex < frameHistory.length) {
    selectForecastByIndex(nextIndex);
    return;
  }

  // If we've advanced past known history, try to synthesize the next
  // frame URL by incrementing the forecast hour in the current source URL
  // (handles both CGI `file=` param and path-based URLs). Limit to f384.
  const curr = currentSourceUrl();
  const stepHours = 6 * delta;
  const nextUrl = incrementForecastInSourceUrl(curr, stepHours);
  if (nextUrl && nextUrl !== curr) {
    // set as current and attempt to load (this will trigger download)
    currentFrameSourceUrl = nextUrl;
    // reflect in UI immediately
    renderForecastSlider();
    // When advancing with keys, avoid refitting the map
    shouldFitBoundsOnNextLoad = false;
    void loadDataset().then(() => {
      // after successful load, refresh frame history so slider/list catches up
      void refreshFrameHistory();
    }).catch(() => {});
  }
}

function incrementForecastInSourceUrl(sourceUrl, deltaHours) {
  try {
    const u = new URL(sourceUrl);
    // prefer updating the `file` query param when present (CGI filter)
    const fileParam = u.searchParams.get("file");
    if (fileParam) {
      const newFile = fileParam.replace(/f(\d{3})/, (_, p1) => {
        const cur = Number(p1);
        let next = cur + Math.round(deltaHours / 6) * 6; // deltaHours is multiple of 6
        // deltaHours may be negative
        const step = Math.round(deltaHours / 6) * 6;
        next = cur + step;
        if (next < 0) next = 0;
        if (next > 384) next = 384;
        return `f${String(next).padStart(3, "0")}`;
      });
      const copy = new URL(u.toString());
      copy.searchParams.set("file", newFile);
      return copy.toString();
    }

    // else, try replacing in the pathname
    if (/f\d{3}/.test(u.pathname)) {
      const newPath = u.pathname.replace(/f(\d{3})/, (_, p1) => {
        const cur = Number(p1);
        const step = Math.round(deltaHours / 6) * 6;
        let next = cur + step;
        if (next < 0) next = 0;
        if (next > 384) next = 384;
        return `f${String(next).padStart(3, "0")}`;
      });
      const copy = new URL(u.toString());
      copy.pathname = newPath;
      return copy.toString();
    }

    return sourceUrl;
  } catch (e) {
    return sourceUrl;
  }
}

// Keyboard navigation: left/right arrow to move frames. Support holding keys
// to continuously advance frames using an interval timer.
window.addEventListener("keydown", (ev) => {
  if (isTypingTarget(ev.target)) return;
  if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
  ev.preventDefault();
  ev.stopPropagation();
  if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();

  const dir = ev.key === "ArrowRight" ? 1 : -1;
  // If no active auto-advance, start RAF loop and advance immediately
  if (!keyAutoAdvance.rafId) {
    keyAutoAdvance.direction = dir;
    shouldFitBoundsOnNextLoad = false;
    selectNextForecast(dir);
    keyAutoAdvance.lastTs = performance.now();
    const loop = (ts) => {
      const elapsed = ts - keyAutoAdvance.lastTs;
      if (elapsed >= keyAutoAdvance.intervalMs) {
        keyAutoAdvance.lastTs = ts;
        selectNextForecast(keyAutoAdvance.direction);
      }
      keyAutoAdvance.rafId = requestAnimationFrame(loop);
    };
    keyAutoAdvance.rafId = requestAnimationFrame(loop);
  } else {
    // update direction while holding
    keyAutoAdvance.direction = dir;
  }
}, true);

window.addEventListener("keyup", (ev) => {
  if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
  ev.preventDefault();
  ev.stopPropagation();
  if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
  // stop auto-advance when arrow released
  if (keyAutoAdvance.rafId) {
    cancelAnimationFrame(keyAutoAdvance.rafId);
    keyAutoAdvance.rafId = null;
    keyAutoAdvance.direction = 0;
    keyAutoAdvance.lastTs = 0;
  }
}, true);

async function fetchDataset(sourceUrl) {
  const metadataResponse = await fetch(`/api/reflectivity?source=${encodeURIComponent(sourceUrl)}`);
  let metadata;
  if (!metadataResponse.ok) {
    // Attempt to extract JSON error, otherwise fall back to plain text
    try {
      const payload = await metadataResponse.json();
      throw new Error(payload.error || metadataResponse.statusText || "Metadata request failed.");
    } catch (e) {
      try {
        const txt = await metadataResponse.text();
        throw new Error(txt || metadataResponse.statusText || "Metadata request failed.");
      } catch (e2) {
        throw new Error(metadataResponse.statusText || "Metadata request failed.");
      }
    }
  }

  metadata = await metadataResponse.json();

  const textureResponse = await fetch(metadata.textureUrl);
  if (!textureResponse.ok) {
    throw new Error("Texture request failed.");
  }

  const textureBytes = new Uint8Array(await textureResponse.arrayBuffer());
  return { metadata, textureBytes };
}

// Load and cache raw dataset (no smoothing)
async function loadAndCacheDataset(sourceUrl) {
  if (datasetCache.has(sourceUrl)) {
    return datasetCache.get(sourceUrl);
  }

  const { metadata, textureBytes } = await fetchDataset(sourceUrl);
  const entry = { metadata, textureBytes, smoothed: {} };
  datasetCache.set(sourceUrl, entry);
  return entry;
}

// Compute a temporally-smoothed texture for the given frame index using neighboring frames.
async function getSmoothedTextureForIndex(index, windowSize) {
  const half = Math.floor(windowSize / 2);
  const indices = [];
  for (let i = index - half; i <= index + half; i++) {
    if (i >= 0 && i < frameHistory.length) indices.push(i);
  }

  if (!indices.length) {
    const entry = await loadAndCacheDataset(currentSourceUrl());
    return { metadata: entry.metadata, textureBytes: entry.textureBytes };
  }

  const urls = indices.map((i) => frameHistory[i].sourceUrl);
  // Ensure datasets are cached
  const entries = await Promise.all(urls.map((u) => loadAndCacheDataset(u)));

  const base = entries[Math.floor(entries.length / 2)];
  const width = base.metadata.width;
  const height = base.metadata.height;
  const expected = width * height;

  const smoothed = new Uint8Array(expected);

  for (let px = 0; px < expected; px++) {
    let sum = 0;
    let count = 0;
    for (const e of entries) {
      if (!e || !e.textureBytes) continue;
      // skip mismatched sizes
      if (e.textureBytes.length !== expected) continue;
      const v = e.textureBytes[px];
      if (v !== 0) {
        sum += v;
        count += 1;
      }
    }
    smoothed[px] = count ? Math.round(sum / count) : 0;
  }

  // Cache smoothed under the central frame's sourceUrl keyed by window size
  const centerUrl = frameHistory[index].sourceUrl;
  const centerEntry = datasetCache.get(centerUrl) || (await loadAndCacheDataset(centerUrl));
  centerEntry.smoothed = centerEntry.smoothed || {};
  centerEntry.smoothed[windowSize] = smoothed;

  return { metadata: base.metadata, textureBytes: smoothed };
}

async function loadConfig() {
  if (appConfig) {
    return appConfig;
  }

  const response = await fetch("/api/config");
  appConfig = await response.json();
  if (!response.ok) {
    throw new Error("Failed to load app config.");
  }

  frameHistory = appConfig.history || [];
  currentProductId = appConfig.defaultProductId;
  currentFrameSourceUrl = appConfig.defaultSourceUrl;
    renderProductButtons();
  renderForecastSlider();
  void renderRunSelector();
  return appConfig;
}

function setStatus(message) {
  if (statusBox) {
    statusBox.textContent = message;
  }
}

function setMetadata(metadata) {
  setLegendPalette(metadata.palette);
  renderLegendTicks(metadata.palette);

  const stops = paletteStops(metadata.palette);
  const legendMinValue = stops.length ? stops[0] : metadata.encoding.valueRange.displayMin;
  const legendMaxValue = stops.length ? stops[stops.length - 1] : metadata.encoding.valueRange.displayMax;
  if (legendLabels) {
    legendLabels.hidden = Boolean(metadata.palette?.discrete);
  }
  legendMin.textContent = formatValue(legendMinValue, metadata.units);
  legendMax.textContent = formatValue(legendMaxValue, metadata.units);
}

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "Shader compilation failed.");
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "Program link failed.");
  }
  return program;
}

class ReflectivityLayer {
  constructor(id) {
    this.id = id;
    this.type = "custom";
    this.renderingMode = "2d";
    this.map = null;
    this.gl = null;
    this.program = null;
    this.buffer = null;
    this.texture = null;
    this.vertexCount = 0;
    this.pendingTexture = null;
    this.pendingMetadata = null;
  }

  normalizeLongitude(lng, west, east) {
    let normalizedLng = lng;

    while (normalizedLng < west) {
      normalizedLng += 360;
    }

    while (normalizedLng > east) {
      normalizedLng -= 360;
    }

    return normalizedLng;
  }

  getValueAtLngLat(lng, lat) {
    if (!this.pendingMetadata || !this.pendingTexture) {
      return null;
    }

    const { bounds, width, height, encoding, units } = this.pendingMetadata;
    const normalizedLng = this.normalizeLongitude(lng, bounds.west, bounds.east);
    const lonSpan = bounds.east - bounds.west;
    const latSpan = bounds.north - bounds.south;

    if (
      normalizedLng < bounds.west ||
      normalizedLng > bounds.east ||
      lat < bounds.south ||
      lat > bounds.north ||
      lonSpan <= 0 ||
      latSpan <= 0
    ) {
      return null;
    }

    const u = Math.min(Math.max((normalizedLng - bounds.west) / lonSpan, 0), 1);
    const v = Math.min(Math.max((lat - bounds.south) / latSpan, 0), 1);
    const x = Math.min(width - 1, Math.floor(u * width));
    const y = Math.min(height - 1, Math.floor(v * height));
    const encoded = this.pendingTexture[(y * width) + x];

    if (!encoded) {
      return null;
    }

    const { dataMin, dataMax } = encoding.valueRange;
    const value = dataMin + ((encoded - 1) / 254) * (dataMax - dataMin);

    return {
      value,
      units,
      lng: normalizedLng,
      lat,
    };
  }

  onAdd(mapInstance, gl) {
    this.map = mapInstance;
    this.gl = gl;
    this.program = createProgram(
      gl,
      `
      precision highp float;
      uniform mat4 uMatrix;
      attribute vec2 aPosition;
      varying vec2 vMercatorCoord;

      void main() {
        vMercatorCoord = aPosition;
        gl_Position = uMatrix * vec4(aPosition, 0.0, 1.0);
      }
      `,
      `
      precision highp float;
      uniform sampler2D uTexture;
      uniform int uPaletteMode;
      uniform int uPaletteStopCount;
      uniform float uOpacity;
      uniform float uDataMin;
      uniform float uDataMax;
      uniform float uPaletteStops[12];
      uniform vec3 uPaletteColors[12];
      uniform float uWest;
      uniform float uEast;
      uniform float uSouth;
      uniform float uNorth;
      varying vec2 vMercatorCoord;

      const float PI = 3.141592653589793;
      const int PALETTE_SIZE = 12;

      vec3 reflectivityPalette(float t) {
        // Typical radar reflectivity palette: blue -> green -> yellow -> red -> magenta
        vec3 c0 = vec3(0.678, 0.847, 0.902); // light sky blue
        vec3 c1 = vec3(0.000, 0.749, 0.831); // turquoise
        vec3 c2 = vec3(0.000, 0.502, 0.000); // green
        vec3 c3 = vec3(1.000, 0.843, 0.000); // gold
        vec3 c4 = vec3(1.000, 0.647, 0.000); // orange
        vec3 c5 = vec3(1.000, 0.412, 0.412); // light red
        vec3 c6 = vec3(0.863, 0.078, 0.235); // deep red
        vec3 c7 = vec3(0.627, 0.125, 0.941); // magenta
        vec3 c8 = vec3(0.780, 0.388, 0.886); // violet
        vec3 c9 = vec3(0.933, 0.510, 0.933); // pink
        vec3 c10 = vec3(0.980, 0.878, 0.690); // warm highlight
        vec3 c11 = vec3(1.000, 1.000, 1.000); // white

        if (t < 0.0909) {
          return mix(c0, c1, t / 0.0909);
        }
        if (t < 0.1818) {
          return mix(c1, c2, (t - 0.0909) / 0.0909);
        }
        if (t < 0.2727) {
          return mix(c2, c3, (t - 0.1818) / 0.0909);
        }
        if (t < 0.3636) {
          return mix(c3, c4, (t - 0.2727) / 0.0909);
        }
        if (t < 0.4545) {
          return mix(c4, c5, (t - 0.3636) / 0.0909);
        }
        if (t < 0.5454) {
          return mix(c5, c6, (t - 0.4545) / 0.0909);
        }
        if (t < 0.6363) {
          return mix(c6, c7, (t - 0.5454) / 0.0909);
        }
        if (t < 0.7272) {
          return mix(c7, c8, (t - 0.6363) / 0.0909);
        }
        if (t < 0.8181) {
          return mix(c8, c9, (t - 0.7272) / 0.0909);
        }
        if (t < 0.9090) {
          return mix(c9, c10, (t - 0.8181) / 0.0909);
        }
        return mix(c10, c11, (t - 0.9090) / 0.0910);
      }

      vec3 qpePalette(float t) {
        vec3 c0 = vec3(0.969, 0.984, 1.000);
        vec3 c1 = vec3(0.871, 0.922, 0.969);
        vec3 c2 = vec3(0.776, 0.859, 0.937);
        vec3 c3 = vec3(0.620, 0.792, 0.882);
        vec3 c4 = vec3(0.420, 0.682, 0.839);
        vec3 c5 = vec3(0.259, 0.573, 0.776);
        vec3 c6 = vec3(0.129, 0.443, 0.710);
        vec3 c7 = vec3(0.031, 0.318, 0.612);
        vec3 c8 = vec3(1.000, 1.000, 0.698);
        vec3 c9 = vec3(0.996, 0.800, 0.361);
        vec3 c10 = vec3(0.992, 0.553, 0.235);
        vec3 c11 = vec3(0.890, 0.102, 0.110);

        if (t < 0.0909) {
          return mix(c0, c1, t / 0.0909);
        }
        if (t < 0.1818) {
          return mix(c1, c2, (t - 0.0909) / 0.0909);
        }
        if (t < 0.2727) {
          return mix(c2, c3, (t - 0.1818) / 0.0909);
        }
        if (t < 0.3636) {
          return mix(c3, c4, (t - 0.2727) / 0.0909);
        }
        if (t < 0.4545) {
          return mix(c4, c5, (t - 0.3636) / 0.0909);
        }
        if (t < 0.5454) {
          return mix(c5, c6, (t - 0.4545) / 0.0909);
        }
        if (t < 0.6363) {
          return mix(c6, c7, (t - 0.5454) / 0.0909);
        }
        if (t < 0.7272) {
          return mix(c7, c8, (t - 0.6363) / 0.0909);
        }
        if (t < 0.8181) {
          return mix(c8, c9, (t - 0.7272) / 0.0909);
        }
        if (t < 0.9090) {
          return mix(c9, c10, (t - 0.8181) / 0.0909);
        }
        return mix(c10, c11, (t - 0.9090) / 0.0910);
      }

      vec3 lightningPalette(float t) {
        vec3 c0 = vec3(0.078, 0.043, 0.204);
        vec3 c1 = vec3(0.165, 0.114, 0.447);
        vec3 c2 = vec3(0.122, 0.302, 0.722);
        vec3 c3 = vec3(0.082, 0.557, 0.910);
        vec3 c4 = vec3(0.067, 0.773, 0.961);
        vec3 c5 = vec3(0.275, 0.941, 0.776);
        vec3 c6 = vec3(0.561, 1.000, 0.478);
        vec3 c7 = vec3(0.949, 1.000, 0.357);
        vec3 c8 = vec3(1.000, 0.749, 0.220);
        vec3 c9 = vec3(1.000, 0.482, 0.133);
        vec3 c10 = vec3(1.000, 0.239, 0.180);
        vec3 c11 = vec3(1.000, 0.953, 0.941);

        if (t < 0.0909) {
          return mix(c0, c1, t / 0.0909);
        }
        if (t < 0.1818) {
          return mix(c1, c2, (t - 0.0909) / 0.0909);
        }
        if (t < 0.2727) {
          return mix(c2, c3, (t - 0.1818) / 0.0909);
        }
        if (t < 0.3636) {
          return mix(c3, c4, (t - 0.2727) / 0.0909);
        }
        if (t < 0.4545) {
          return mix(c4, c5, (t - 0.3636) / 0.0909);
        }
        if (t < 0.5454) {
          return mix(c5, c6, (t - 0.4545) / 0.0909);
        }
        if (t < 0.6363) {
          return mix(c6, c7, (t - 0.5454) / 0.0909);
        }
        if (t < 0.7272) {
          return mix(c7, c8, (t - 0.6363) / 0.0909);
        }
        if (t < 0.8181) {
          return mix(c8, c9, (t - 0.7272) / 0.0909);
        }
        if (t < 0.9090) {
          return mix(c9, c10, (t - 0.8181) / 0.0909);
        }
        return mix(c10, c11, (t - 0.9090) / 0.0910);
      }

      vec3 temperaturePalette(float t) {
        vec3 c0 = vec3(0.227, 0.110, 0.443);
        vec3 c1 = vec3(0.129, 0.333, 0.773);
        vec3 c2 = vec3(0.184, 0.525, 1.000);
        vec3 c3 = vec3(0.412, 0.776, 1.000);
        vec3 c4 = vec3(0.718, 0.953, 1.000);
        vec3 c5 = vec3(0.957, 0.969, 0.824);
        vec3 c6 = vec3(1.000, 0.878, 0.541);
        vec3 c7 = vec3(1.000, 0.702, 0.302);
        vec3 c8 = vec3(1.000, 0.482, 0.227);
        vec3 c9 = vec3(0.937, 0.302, 0.235);
        vec3 c10 = vec3(0.788, 0.176, 0.294);
        vec3 c11 = vec3(0.420, 0.114, 0.227);

        if (t < 0.0909) {
          return mix(c0, c1, t / 0.0909);
        }
        if (t < 0.1818) {
          return mix(c1, c2, (t - 0.0909) / 0.0909);
        }
        if (t < 0.2727) {
          return mix(c2, c3, (t - 0.1818) / 0.0909);
        }
        if (t < 0.3636) {
          return mix(c3, c4, (t - 0.2727) / 0.0909);
        }
        if (t < 0.4545) {
          return mix(c4, c5, (t - 0.3636) / 0.0909);
        }
        if (t < 0.5454) {
          return mix(c5, c6, (t - 0.4545) / 0.0909);
        }
        if (t < 0.6363) {
          return mix(c6, c7, (t - 0.5454) / 0.0909);
        }
        if (t < 0.7272) {
          return mix(c7, c8, (t - 0.6363) / 0.0909);
        }
        if (t < 0.8181) {
          return mix(c8, c9, (t - 0.7272) / 0.0909);
        }
        if (t < 0.9090) {
          return mix(c9, c10, (t - 0.8181) / 0.0909);
        }
        return mix(c10, c11, (t - 0.9090) / 0.0910);
      }

      vec3 paletteFromUniform(float t) {
        if (uPaletteStopCount <= 1) return uPaletteColors[0];
        float scaled = t * float(uPaletteStopCount - 1);
        // iterate over palette segments using a compile-time loop index
        for (int j = 0; j < PALETTE_SIZE - 1; j++) {
          if (j >= uPaletteStopCount - 1) break;
          float lower = float(j);
          float upper = float(j + 1);
          if (scaled <= upper) {
            float ft = clamp((scaled - lower) / max(upper - lower, 0.0001), 0.0, 1.0);
            return mix(uPaletteColors[j], uPaletteColors[j + 1], ft);
          }
        }
        // fallback: return last palette color (padded on JS side)
        return uPaletteColors[PALETTE_SIZE - 1];
      }

      vec3 precipIdPalette(float t) {
        float bucket = floor(t * 7.0 + 0.5);

        if (bucket < 0.5) {
          return vec3(0.122, 0.161, 0.216);
        }
        if (bucket < 1.5) {
          return vec3(0.392, 0.455, 0.545);
        }
        if (bucket < 2.5) {
          return vec3(0.133, 0.773, 0.369);
        }
        if (bucket < 3.5) {
          return vec3(0.220, 0.741, 0.973);
        }
        if (bucket < 4.5) {
          return vec3(0.980, 0.800, 0.082);
        }
        if (bucket < 5.5) {
          return vec3(0.984, 0.443, 0.522);
        }
        if (bucket < 6.5) {
          return vec3(0.655, 0.545, 0.980);
        }
        return vec3(0.976, 0.451, 0.086);
      }

      vec3 palette(float t) {
        if (uPaletteMode == 1) {
          return qpePalette(t);
        }

        if (uPaletteMode == 2) {
          return lightningPalette(t);
        }

        if (uPaletteMode == 3) {
          return temperaturePalette(t);
        }

        if (uPaletteMode == 5) {
          return paletteFromUniform(t);
        }

        if (uPaletteMode == 4) {
          return precipIdPalette(t);
        }

        return reflectivityPalette(t);
      }

      float valueToPaletteT(float value) {
        if (uPaletteStopCount <= 1) {
          return 0.0;
        }

        if (value <= uPaletteStops[0]) {
          return 0.0;
        }

        for (int i = 0; i < PALETTE_SIZE - 1; i += 1) {
          if (i >= uPaletteStopCount - 1) {
            break;
          }

          float lower = uPaletteStops[i];
          float upper = uPaletteStops[i + 1];
          if (value <= upper) {
            float segmentT = (value - lower) / max(upper - lower, 0.0001);
            return (float(i) + segmentT) / max(float(uPaletteStopCount - 1), 1.0);
          }
        }

        return 1.0;
      }

      float mercatorYToLatitude(float y) {
        float mercator = PI * (1.0 - 2.0 * y);
        float sinhMercator = 0.5 * (exp(mercator) - exp(-mercator));
        return degrees(atan(sinhMercator));
      }

      void main() {
        float lng = vMercatorCoord.x * 360.0 - 180.0;
        float lat = mercatorYToLatitude(vMercatorCoord.y);
        float u = (lng - uWest) / max(uEast - uWest, 0.000001);
        float v = (lat - uSouth) / max(uNorth - uSouth, 0.000001);
        vec2 uv = vec2(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0));
        vec4 texel = texture2D(uTexture, uv);
        float encoded = floor(texel.r * 255.0 + 0.5);
        if (encoded < 0.5) {
          discard;
        }

        float value = mix(uDataMin, uDataMax, (encoded - 1.0) / 254.0);
        float t = valueToPaletteT(value);
        float alpha = (uPaletteMode == 4 ? 1.0 : smoothstep(0.02, 0.12, t)) * uOpacity;
        gl_FragColor = vec4(palette(t), alpha);
      }
      `,
    );

    this.buffer = gl.createBuffer();
    this.texture = gl.createTexture();

    if (this.pendingMetadata && this.pendingTexture) {
      this.applyDataset(this.pendingMetadata, this.pendingTexture);
    }
  }

  setDataset(metadata, textureBytes) {
    this.pendingMetadata = metadata;
    this.pendingTexture = textureBytes;

    if (this.gl) {
      this.applyDataset(metadata, textureBytes);
      this.map.triggerRepaint();
    }
  }

  setOpacity(opacity) {
    this.opacity = opacity;
    if (this.map) {
      this.map.triggerRepaint();
    }
  }

  applyDataset(metadata, textureBytes) {
    const gl = this.gl;
    const bounds = metadata.mercatorBounds;
    const expectedBytes = metadata.width * metadata.height;
    if (textureBytes.byteLength !== expectedBytes) {
      throw new Error(
        `Texture byte length mismatch. Expected ${expectedBytes} bytes, received ${textureBytes.byteLength}.`,
      );
    }

    const sw = mapboxgl.MercatorCoordinate.fromLngLat({ lng: bounds.west, lat: bounds.south });
    const nw = mapboxgl.MercatorCoordinate.fromLngLat({ lng: bounds.west, lat: bounds.north });
    const se = mapboxgl.MercatorCoordinate.fromLngLat({ lng: bounds.east, lat: bounds.south });
    const ne = mapboxgl.MercatorCoordinate.fromLngLat({ lng: bounds.east, lat: bounds.north });

    const vertices = new Float32Array([
      sw.x, sw.y, 0, 0,
      nw.x, nw.y, 0, 1,
      se.x, se.y, 1, 0,
      se.x, se.y, 1, 0,
      nw.x, nw.y, 0, 1,
      ne.x, ne.y, 1, 1,
    ]);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    this.vertexCount = 6;

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      metadata.palette?.discrete ? gl.NEAREST : gl.LINEAR,
    );
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MAG_FILTER,
      metadata.palette?.discrete ? gl.NEAREST : gl.LINEAR,
    );
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.LUMINANCE,
      metadata.width,
      metadata.height,
      0,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      textureBytes,
    );
  }

  render(gl, matrix) {
    if (!this.pendingMetadata || !this.texture || this.vertexCount === 0) {
      return;
    }

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);

    const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
    const positionLocation = gl.getAttribLocation(this.program, "aPosition");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, stride, 0);

    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, "uMatrix"), false, matrix);
    gl.uniform1f(gl.getUniformLocation(this.program, "uOpacity"), this.opacity ?? currentOpacity);
    gl.uniform1f(gl.getUniformLocation(this.program, "uDataMin"), this.pendingMetadata.encoding.valueRange.dataMin);
    gl.uniform1f(gl.getUniformLocation(this.program, "uDataMax"), this.pendingMetadata.encoding.valueRange.dataMax);
    const stopCount = Math.min(paletteStops(this.pendingMetadata.palette).length, MAX_PALETTE_STOPS);
    gl.uniform1fv(
      gl.getUniformLocation(this.program, "uPaletteStops"),
      paddedPaletteStops(this.pendingMetadata.palette),
    );
    gl.uniform1i(gl.getUniformLocation(this.program, "uPaletteStopCount"), stopCount);
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uPaletteMode"),
      this.pendingMetadata.palette.kind === "qpe"
        ? 1
        : this.pendingMetadata.palette.kind === "lightning"
          ? 2
          : this.pendingMetadata.palette.kind === "temperature"
            ? 3
            : this.pendingMetadata.palette.kind === "precip_id"
              ? 4
              : this.pendingMetadata.palette.kind === "pressure"
                ? 5
                : 0,
    );
    gl.uniform1f(gl.getUniformLocation(this.program, "uWest"), this.pendingMetadata.bounds.west);
    gl.uniform1f(gl.getUniformLocation(this.program, "uEast"), this.pendingMetadata.bounds.east);
    gl.uniform1f(gl.getUniformLocation(this.program, "uSouth"), this.pendingMetadata.bounds.south);
    gl.uniform1f(gl.getUniformLocation(this.program, "uNorth"), this.pendingMetadata.bounds.north);

    // supply palette colors as vec3 array for shader interpolation
    const paletteColors = paddedPaletteColors(this.pendingMetadata.palette);
    const paletteColorLoc = gl.getUniformLocation(this.program, "uPaletteColors");
    if (paletteColorLoc) {
      gl.uniform3fv(paletteColorLoc, paletteColors);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(gl.getUniformLocation(this.program, "uTexture"), 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
  }
}

function initMap(token) {
  if (mapReadyPromise) {
    return mapReadyPromise;
  }

  mapboxgl.accessToken = token;
  map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/dark-v11",
    center: [-96, 38],
    zoom: 3,
    projection: "mercator",
  });

  map.addControl(new mapboxgl.NavigationControl(), "top-right");
  mapReadyPromise = new Promise((resolve) => {
    map.on("load", () => {
      reflectivityLayer = new ReflectivityLayer("reflectivity-layer");
      reflectivityLayer.setOpacity(currentOpacity);
      map.addLayer(reflectivityLayer);

      hoverPopup = new mapboxgl.Popup({
        closeButton: false,
        closeOnClick: false,
        className: "hover-value-popup",
        offset: 12,
      });

      map.on("mousemove", (event) => {
        const hoverValue = reflectivityLayer.getValueAtLngLat(event.lngLat.lng, event.lngLat.lat);

        if (!hoverValue) {
          map.getCanvas().style.cursor = "";
          hoverPopup.remove();
          return;
        }

        map.getCanvas().style.cursor = "crosshair";
        hoverPopup
          .setLngLat(event.lngLat)
          .setHTML(`<strong>${formatValue(hoverValue.value, hoverValue.units)} ${hoverValue.units}</strong>`)
          .addTo(map);
      });

      map.on("mouseout", () => {
        map.getCanvas().style.cursor = "";
        hoverPopup.remove();
      });

      setStatus("Map ready. Loading the latest HRRR product.");
      resolve();
    });
  });

  return mapReadyPromise;
}

initOpacityControl();

async function loadDataset() {
  await loadConfig();
  const token = (appConfig.defaultMapboxToken || "").trim();
  if (!token) {
    setStatus("No Mapbox token is configured on the backend.");
    return;
  }

  const currentLoad = ++loadSequence;

  if (!map) {
    await initMap(token);
  } else if (mapReadyPromise) {
    await mapReadyPromise;
  }

  const sourceUrl = currentSourceUrl();
  const selectedFrame = frameHistory.find((entry) => entry.sourceUrl === sourceUrl);
  const frameLabel = selectedFrame?.label || "selected";
  const productLabel = currentProduct()?.label || "HRRR product";
  setStatus(`Building ${productLabel} frame ${frameLabel} from GRIB2. This can take a bit on the first request.`);

  // Use cached datasets when available and optionally apply temporal smoothing
  const currentIndex = currentForecastIndex();
  let datasetEntry;
  try {
    if (SMOOTHING_ENABLED && currentIndex !== -1) {
      datasetEntry = await getSmoothedTextureForIndex(currentIndex, SMOOTH_WINDOW);
    } else {
      const raw = await loadAndCacheDataset(sourceUrl);
      datasetEntry = { metadata: raw.metadata, textureBytes: raw.textureBytes };
    }
  } catch (err) {
    // Fallback to direct fetch if caching/smoothing fails
    const raw = await fetchDataset(sourceUrl);
    datasetEntry = { metadata: raw.metadata, textureBytes: raw.textureBytes };
  }

  if (currentLoad !== loadSequence) {
    return;
  }

  setMetadata(datasetEntry.metadata);
  reflectivityLayer.setDataset(datasetEntry.metadata, datasetEntry.textureBytes);

  const bounds = datasetEntry.metadata.mercatorBounds;
  // Only fit bounds when allowed (initial load or explicit run change).
  if (shouldFitBoundsOnNextLoad) {
    map.fitBounds([
      [bounds.west, bounds.south],
      [bounds.east, bounds.north],
    ], { padding: 40, duration: 0 });
    // Reset the flag so subsequent interactive navigation doesn't refit.
    shouldFitBoundsOnNextLoad = false;
  }

  setStatus(`Rendered ${datasetEntry.metadata.productLabel || productLabel} frame ${frameLabel} through the custom WebGL layer.`);
  // Prefetch adjacent frames into the cache to enable quick back/forward navigation
  (async () => {
    try {
      const idx = currentForecastIndex();
      if (idx > 0) {
        void loadAndCacheDataset(frameHistory[idx - 1].sourceUrl).catch(() => {});
      }
      if (idx + 1 < frameHistory.length) {
        void loadAndCacheDataset(frameHistory[idx + 1].sourceUrl).catch(() => {});
      }
    } catch (e) {}
  })();
}

loadConfig()
  .then(() => {
    if ((appConfig.defaultMapboxToken || "").trim()) {
      return initMap(appConfig.defaultMapboxToken.trim());
    }

    setStatus("Configure a Mapbox token in the backend to initialize the map.");
    return null;
  })
  .then(() => refreshFrameHistory({ forceLatest: false }))
  .then(() => refreshLatestFrame())
  .catch((error) => {
    setStatus(error instanceof Error ? error.message : String(error));
  });
