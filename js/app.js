'use strict';

/* ============================================================
   CONFIGURATION
   ============================================================ */
const CONFIG = {
  LS_API_KEY:       'sv_canopy_api_key',
  LS_PROXY_URL:     'sv_canopy_proxy_url',   // Cloudflare Worker URL for history fetch
  BATCH_SIZE:       5,       // concurrent StreetViewService requests
  BATCH_DELAY_MS:   250,     // ms between batches (avoid rate-limits)
  DEFAULT_CENTER:   { lat: 37.7749, lng: -122.4194 },
  DEFAULT_ZOOM:     11,
  TIMELINE_URL:     'https://maps.googleapis.com/maps/api/js/GeoPhotoService.SingleImageSearch',
  TIMELINE_TIMEOUT: 6000,    // ms before giving up on history fetch
};

/* ============================================================
   APPLICATION STATE
   ============================================================ */
const state = {
  apiKey:       null,
  rawCoords:    [],    // Array of {lat, lng, label}
  results:      [],    // Array of result objects (one per rawCoord)
  selectedIdx:  null,
  processing:   false,
  cancelled:    false,
  history:      null,  // null | 'loading' | Array<panoRecord>

  // Google Maps objects
  map:         null,
  panorama:    null,
  svService:   null,
  markers:     [],     // parallel to results[]
  infoWindow:  null,
};

/* ============================================================
   API KEY MANAGEMENT
   ============================================================ */
function getStoredApiKey() {
  return localStorage.getItem(CONFIG.LS_API_KEY) || '';
}

function storeApiKey(key) {
  localStorage.setItem(CONFIG.LS_API_KEY, key.trim());
}

function clearStoredApiKey() {
  localStorage.removeItem(CONFIG.LS_API_KEY);
}

/* ============================================================
   GOOGLE MAPS DYNAMIC LOADING
   ============================================================ */
function loadGoogleMaps(apiKey) {
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=geometry&callback=_onMapsReady&v=weekly`;
  script.async = true;
  script.onerror = () => {
    showApiKeyError('Failed to load Google Maps. Check that your API key is valid and the Maps JavaScript API is enabled.');
    const submitBtn = document.getElementById('api-key-submit');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Load Tool';
  };
  document.head.appendChild(script);
}

window._onMapsReady = function () {
  initMapAndPanorama();
  setupMapsListeners();   // listeners that require google.maps to exist
  showApp();
};

/* ============================================================
   COORDINATE PARSING
   ============================================================ */

/**
 * Parse a multi-line text block where each line is a coordinate.
 * Supports:  lat,lng  |  lat lng  |  lat,lng,label  | (lat, lng)
 */
function parseCoordinatesFromText(text) {
  const lines = text.split(/[\n\r]+/);
  const coords = [];
  const errors = [];

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return;

    // Strip parentheses/brackets
    const cleaned = line.replace(/[()[\]]/g, '');

    // Extract all decimal numbers (handles negative)
    const nums = cleaned.match(/-?\d+\.?\d*/g);
    if (!nums || nums.length < 2) {
      errors.push(`Line ${i + 1}: "${line}" — could not find two numbers`);
      return;
    }

    const lat = parseFloat(nums[0]);
    const lng = parseFloat(nums[1]);

    if (!isValidLatLng(lat, lng)) {
      errors.push(`Line ${i + 1}: "${line}" — invalid lat/lng values (${lat}, ${lng})`);
      return;
    }

    // Label: any non-numeric text remaining, or auto-generated
    const afterTwo = cleaned
      .replace(nums[0], '')
      .replace(nums[1], '')
      .replace(/^[\s,]+/, '')
      .trim();
    const label = afterTwo || `Point ${coords.length + 1}`;

    coords.push({ lat, lng, label });
  });

  return { coords, errors };
}

/**
 * Parse a CSV file, auto-detecting which columns hold lat/lng.
 */
function parseCSVText(text) {
  const lines = text.split(/[\n\r]+/).filter(l => l.trim());
  if (!lines.length) return { coords: [], errors: [] };

  const sep = detectSeparator(lines[0]);

  // --- Detect header row ---
  const firstRowCells = lines[0].split(sep).map(c => stripQuotes(c).toLowerCase().trim());
  const latIdx = findColIdx(firstRowCells, ['lat', 'latitude', 'y', 'lat_dd', 'ylat', 'latitude_dd', 'decimallatitude']);
  const lngIdx = findColIdx(firstRowCells, ['lon', 'lng', 'long', 'longitude', 'x', 'lng_dd', 'xlng', 'longitude_dd', 'decimallongitude']);
  const labelIdx = findColIdx(firstRowCells, ['label', 'name', 'id', 'tree_id', 'site', 'address', 'point_id', 'feature_id', 'objectid']);

  const hasHeader = latIdx !== -1 && lngIdx !== -1;
  const dataStart = hasHeader ? 1 : 0;

  // Without a recognised header, assume first col = lat, second = lng
  const effLatIdx   = hasHeader ? latIdx   : 0;
  const effLngIdx   = hasHeader ? lngIdx   : 1;
  const effLabelIdx = hasHeader ? labelIdx : -1;

  const coords = [];
  const errors = [];

  for (let i = dataStart; i < lines.length; i++) {
    const cells = lines[i].split(sep).map(c => stripQuotes(c).trim());
    if (cells.length < 2) continue;

    const lat = parseFloat(cells[effLatIdx]);
    const lng = parseFloat(cells[effLngIdx]);

    if (!isValidLatLng(lat, lng)) {
      errors.push(`Row ${i + 1}: invalid lat/lng (${cells[effLatIdx]}, ${cells[effLngIdx]})`);
      continue;
    }

    const label = (effLabelIdx >= 0 && cells[effLabelIdx])
      ? cells[effLabelIdx]
      : `Point ${coords.length + 1}`;

    coords.push({ lat, lng, label });
  }

  return { coords, errors };
}

function detectSeparator(line) {
  if (line.includes('\t')) return '\t';
  if ((line.match(/;/g) || []).length > (line.match(/,/g) || []).length) return ';';
  return ',';
}

function findColIdx(headers, candidates) {
  for (const c of candidates) {
    const i = headers.indexOf(c);
    if (i !== -1) return i;
  }
  // Partial match fallback
  for (const c of candidates) {
    const i = headers.findIndex(h => h.includes(c));
    if (i !== -1) return i;
  }
  return -1;
}

function stripQuotes(s) {
  return s.replace(/^["']|["']$/g, '');
}

function isValidLatLng(lat, lng) {
  return (
    !isNaN(lat) && !isNaN(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180 &&
    !(lat === 0 && lng === 0)    // skip null island
  );
}

/* ============================================================
   STREET VIEW SERVICE WRAPPER
   ============================================================ */
function findNearestPano(lat, lng, radiusM) {
  return new Promise(resolve => {
    state.svService.getPanorama(
      {
        location: { lat, lng },
        radius: radiusM || 100,
        source: google.maps.StreetViewSource.OUTDOOR,
        preference: google.maps.StreetViewPreference.NEAREST,
      },
      (data, status) => {
        if (status === google.maps.StreetViewStatus.OK && data) {
          const panoLatLng = data.location.latLng;
          const inputLatLng = new google.maps.LatLng(lat, lng);
          const distM = google.maps.geometry.spherical.computeDistanceBetween(inputLatLng, panoLatLng);
          resolve({
            found: true,
            panoId:   data.location.pano,
            panoLat:  panoLatLng.lat(),
            panoLng:  panoLatLng.lng(),
            date:     data.imageDate || null,
            distM:    Math.round(distM),
          });
        } else {
          resolve({ found: false });
        }
      }
    );
  });
}

/* ============================================================
   BATCH PROCESSING
   ============================================================ */
async function processAllCoordinates() {
  if (state.processing || state.rawCoords.length === 0) return;

  state.processing = true;
  state.cancelled  = false;

  // Build result stubs for every input coord
  state.results = state.rawCoords.map((c, i) => ({
    idx:      i,
    inputLat: c.lat,
    inputLng: c.lng,
    label:    c.label,
    found:    null,   // null = pending
    panoId:   null,
    panoLat:  null,
    panoLng:  null,
    date:     null,
    distM:    null,
  }));

  clearMarkers();
  renderCoordList();
  showProgress(true);
  hideStatus();

  const radius = parseInt(document.getElementById('search-radius').value, 10);
  const total  = state.rawCoords.length;
  let processed = 0;

  for (let i = 0; i < total; i += CONFIG.BATCH_SIZE) {
    if (state.cancelled) break;

    const slice = state.rawCoords.slice(i, Math.min(i + CONFIG.BATCH_SIZE, total));

    await Promise.all(
      slice.map(async (coord, bIdx) => {
        if (state.cancelled) return;
        const globalIdx = i + bIdx;
        const result = await findNearestPano(coord.lat, coord.lng, radius);

        Object.assign(state.results[globalIdx], result);
        processed++;

        updateProgress(processed, total);
        refreshCoordItem(globalIdx);
        placeOrUpdateMarker(globalIdx);
      })
    );

    if (!state.cancelled && i + CONFIG.BATCH_SIZE < total) {
      await sleep(CONFIG.BATCH_DELAY_MS);
    }
  }

  state.processing = false;
  showProgress(false);

  const found    = state.results.filter(r => r.found === true).length;
  const notFound = state.results.filter(r => r.found === false).length;

  if (state.cancelled) {
    showStatus(`Processing cancelled. ${found} panoramas found so far.`, 'warning');
  } else {
    showStatus(
      `Done: ${found} panorama${found !== 1 ? 's' : ''} found, ${notFound} location${notFound !== 1 ? 's' : ''} with no nearby Street View.`,
      found > 0 ? 'success' : 'error'
    );
  }

  // Fit map bounds to all markers
  fitMapToMarkers();
}

/* ============================================================
   HISTORICAL PANORAMA FETCHING
   ============================================================ */

/**
 * Fetch historical panoramas for a location.
 *
 * Strategy:
 *  1. If the user has configured a Cloudflare Worker proxy URL, route through it.
 *     The Worker adds the Referer header Google requires and returns CORS headers.
 *  2. Otherwise try the endpoint directly (will usually fail with CORS from a browser).
 *  3. On failure return { results: [], corsOk: false } so the UI can show the fallback.
 */
async function fetchHistoricalPanos(lat, lng) {
  const proxyBase = localStorage.getItem(CONFIG.LS_PROXY_URL) || '';

  // Two pb payload variants — lat/lng argument order differs between them.
  // The Python backend tries both; we do the same.
  const pbVariants = [
    `!1m5!1sapiv3!5sen!11m2!1m1!1b0!2m2!1d${lng}!2d${lat}!3m10!2m2!1sen!2sus!9m1!1b1!6m3!1i640!2i640!3i90!4m8!1m2!1d${lng}!2d${lat}!2m2!1d${lat}!2d${lng}!3m2!1i203!2i100!4b1!5m1!1e2`,
    `!1m5!1sapiv3!5sen!11m2!1m1!1b0!2m2!1d${lat}!2d${lng}!3m10!2m2!1sen!2sus!9m1!1b1!6m3!1i640!2i640!3i90!4m8!1m2!1d${lat}!2d${lng}!2m2!1d${lat}!2d${lng}!3m2!1i203!2i100!4b1!5m1!1e2`,
  ];

  for (const pb of pbVariants) {
    try {
      // Route through Cloudflare Worker proxy if configured, else try direct
      const url = proxyBase
        ? `${proxyBase.replace(/\/$/, '')}?pb=${encodeURIComponent(pb)}`
        : `${CONFIG.TIMELINE_URL}?pb=${encodeURIComponent(pb)}`;

      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CONFIG.TIMELINE_TIMEOUT);

      const resp = await fetch(url, { mode: 'cors', signal: ctrl.signal });
      clearTimeout(timer);

      if (!resp.ok) continue;

      const text = await resp.text();
      if (!text || text.length < 40) continue;

      const results = parseTimelineResponse(text);
      if (results.length > 0) {
        return { results, corsOk: true };
      }
    } catch (e) {
      // AbortError (timeout) or CORS-blocked — try next variant then give up
      console.warn('[History] Fetch failed:', e.message);
    }
  }

  return { results: [], corsOk: false };
}

/**
 * Parse the raw text response from GeoPhotoService.SingleImageSearch.
 * The response is a JSON-like protobuf encoding; we extract pano IDs,
 * coordinates, and date tuples using the same regex approach as the
 * Python backend.
 */
function parseTimelineResponse(text) {
  // Strip JSON anti-hijacking prefix if present (e.g.  )]}' )
  const bodyStart = text.search(/[\[{]/);
  const body = bodyStart >= 0 ? text.slice(bodyStart) : text;

  const seen     = new Set();
  const panoRows = [];

  // Primary pattern: [index,"PANO_ID"] ... [[null,null,LAT,LNG]]
  const primary = [...body.matchAll(/\[\d+,"([^"]{10,})"\].+?\[\[null,null,(-?\d+\.\d+),(-?\d+\.\d+)\]/g)];
  // Fallback pattern: "PANO_ID" ... [LAT,LNG]
  const fallback = primary.length === 0
    ? [...body.matchAll(/"([A-Za-z0-9_\-]{10,})".+?\[(-?\d+\.\d+),(-?\d+\.\d+)\]/g)]
    : [];

  const matches = primary.length > 0 ? primary : fallback;

  for (const m of matches) {
    const [, panoId, v1, v2] = m;
    if (seen.has(panoId)) continue;
    seen.add(panoId);
    panoRows.push({ panoId, lat: parseFloat(v1), lng: parseFloat(v2), date: null });
  }

  if (!panoRows.length) return [];

  // Date tuples appear as [YYYY, M] — they map to pano rows in reverse order
  const dateTuples = [...body.matchAll(/\[(20\d{2}),([1-9]|1[0-2])\]/g)].reverse();
  dateTuples.forEach((m, i) => {
    if (i < panoRows.length) {
      const [, year, month] = m;
      panoRows[i].date = `${year}-${String(month).padStart(2, '0')}`;
    }
  });

  // Sort newest first, undated entries last
  panoRows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return panoRows;
}

/* ============================================================
   MAP & PANORAMA INITIALISATION
   ============================================================ */
function initMapAndPanorama() {
  state.map = new google.maps.Map(document.getElementById('map'), {
    center:             CONFIG.DEFAULT_CENTER,
    zoom:               CONFIG.DEFAULT_ZOOM,
    mapTypeControl:     true,
    mapTypeControlOptions: {
      style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
      position: google.maps.ControlPosition.BOTTOM_LEFT,
    },
    streetViewControl:  false,
    fullscreenControl:  true,
  });

  state.svService  = new google.maps.StreetViewService();
  state.infoWindow = new google.maps.InfoWindow();

  state.map.addListener('click', e => {
    handleMapClick(e.latLng.lat(), e.latLng.lng());
  });

  // Panorama viewer (hidden until a pano is selected)
  state.panorama = new google.maps.StreetViewPanorama(
    document.getElementById('viewer'),
    {
      pov:                   { heading: 0, pitch: 0 },
      visible:               false,
      addressControl:        false,
      linksControl:          true,
      panControl:            true,
      fullscreenControl:     true,
      motionTracking:        false,
      motionTrackingControl: false,
      zoomControl:           true,
    }
  );
}

/* ============================================================
   MAP CLICK → QUICK SINGLE-POINT LOOKUP
   ============================================================ */
async function handleMapClick(lat, lng) {
  if (state.processing) return;

  const label = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  const idx   = state.rawCoords.length;

  state.rawCoords.push({ lat, lng, label });
  state.results.push({
    idx,
    inputLat: lat,
    inputLng: lng,
    label,
    found: null,
    panoId: null, panoLat: null, panoLng: null,
    date: null, distM: null,
  });

  renderCoordList();

  const radius = parseInt(document.getElementById('search-radius').value, 10);
  const result = await findNearestPano(lat, lng, radius);
  Object.assign(state.results[idx], result);

  refreshCoordItem(idx);
  placeOrUpdateMarker(idx);

  if (result.found) {
    selectCoordinate(idx);
  }

  // Also fill in the Single Point tab inputs for convenience
  document.getElementById('single-lat').value   = lat.toFixed(6);
  document.getElementById('single-lng').value   = lng.toFixed(6);
  document.getElementById('single-label').value = '';
}

/* ============================================================
   MARKERS
   ============================================================ */
function markerSvg(color, isSelected) {
  const ring = isSelected ? '#fff' : 'rgba(0,0,0,.2)';
  const rw   = isSelected ? 2.5 : 1;
  return `<svg width="24" height="32" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 20 12 20S24 21 24 12C24 5.373 18.627 0 12 0z"
      fill="${color}" stroke="${ring}" stroke-width="${rw}"/>
    <circle cx="12" cy="12" r="4.5" fill="white" opacity="0.75"/>
  </svg>`;
}

function markerColor(result) {
  if (result.found === null) return '#9ca3af';    // pending – grey
  return result.found ? '#16a34a' : '#dc2626';    // found – green | not found – red
}

function placeOrUpdateMarker(idx) {
  const result = state.results[idx];
  if (!result) return;

  if (state.markers[idx]) {
    state.markers[idx].setMap(null);
  }

  const isSelected = state.selectedIdx === idx;
  const color      = markerColor(result);
  const svg        = markerSvg(color, isSelected);
  const dataUri    = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);

  const marker = new google.maps.Marker({
    position:  { lat: result.inputLat, lng: result.inputLng },
    map:       state.map,
    title:     result.label,
    icon: {
      url:         dataUri,
      scaledSize:  new google.maps.Size(24, 32),
      anchor:      new google.maps.Point(12, 32),
    },
    zIndex: isSelected ? 1000 : idx,
  });

  marker.addListener('click', () => selectCoordinate(idx));
  state.markers[idx] = marker;
}

function clearMarkers() {
  state.markers.forEach(m => m && m.setMap(null));
  state.markers = [];
}

function fitMapToMarkers() {
  const valid = state.markers.filter(Boolean);
  if (!valid.length) return;
  const bounds = new google.maps.LatLngBounds();
  valid.forEach(m => bounds.extend(m.getPosition()));
  state.map.fitBounds(bounds, { padding: 60 });
}

/* ============================================================
   COORDINATE SELECTION & VIEWER
   ============================================================ */
async function selectCoordinate(idx) {
  state.selectedIdx = idx;

  // Refresh all marker icons (update selected state visually)
  state.markers.forEach((_, i) => placeOrUpdateMarker(i));

  // Highlight list item
  document.querySelectorAll('.coord-item').forEach((el, i) => {
    el.classList.toggle('selected', i === idx);
  });

  // Scroll into view
  const el = document.querySelector(`.coord-item[data-idx="${idx}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const result = state.results[idx];
  if (!result || !result.found) {
    hidePanorama();
    setHistoryPanel(null, false);
    return;
  }

  openPanorama(result.panoId);
  updateGoogleMapsLink(result.panoLat, result.panoLng, result.panoId);
  await loadAndRenderHistory(result.panoLat, result.panoLng);
}

function openPanorama(panoId) {
  document.getElementById('viewer-placeholder').style.display = 'none';
  document.getElementById('viewer').style.display = '';
  state.panorama.setPano(panoId);
  state.panorama.setPov({ heading: 0, pitch: 0 });
  state.panorama.setVisible(true);
}

function hidePanorama() {
  document.getElementById('viewer-placeholder').style.display = '';
  document.getElementById('viewer').style.display = 'none';
  if (state.panorama) state.panorama.setVisible(false);
}

/* ============================================================
   HISTORICAL TIMELINE LOADING & RENDERING
   ============================================================ */

/**
 * Primary approach: use the Maps JS API's built-in data.time array.
 * getPanorama() already returns all historical panoramas — no proxy needed.
 */
function getHistoricalPanosFromMapsApi(lat, lng) {
  return new Promise(resolve => {
    state.svService.getPanorama(
      {
        location: { lat, lng },
        radius: 200,
        source: google.maps.StreetViewSource.OUTDOOR,
        preference: google.maps.StreetViewPreference.NEAREST,
      },
      (data, status) => {
        if (status !== google.maps.StreetViewStatus.OK || !data || !data.time || !data.time.length) {
          resolve([]);
          return;
        }
        const panoLat = data.location.latLng.lat();
        const panoLng = data.location.latLng.lng();

        // Build initial list — try description first (locale string), then imageDate
        const panos = data.time
          .filter(t => t && t.pano)
          .map(t => ({
            panoId: t.pano,
            date:   t.description || t.imageDate || null,
            lat:    panoLat,
            lng:    panoLng,
          }));

        // If dates are missing (description not populated in this API version),
        // fetch imageDate for each historical pano individually via getPanorama.
        const allMissingDates = panos.every(p => !p.date);
        if (!allMissingDates) {
          resolve(panos);
          return;
        }

        Promise.all(
          panos.map(p => new Promise(res => {
            state.svService.getPanorama({ pano: p.panoId }, (d, s) => {
              res({
                ...p,
                date: (s === google.maps.StreetViewStatus.OK && d && d.imageDate)
                  ? d.imageDate   // "YYYY-MM" format — formatDate() handles this
                  : null,
              });
            });
          }))
        ).then(resolve);
      }
    );
  });
}

async function loadAndRenderHistory(lat, lng) {
  setHistoryPanel('loading', false);
  state.history = 'loading';

  // Step 1: Maps JS API (data.time) — no proxy, no CORS issues
  const apiPanos = await getHistoricalPanosFromMapsApi(lat, lng);

  if (apiPanos.length > 0) {
    state.history = apiPanos;
    renderHistoryTimeline(apiPanos);
    const countEl = document.getElementById('history-count');
    countEl.textContent = apiPanos.length;
    countEl.style.display = '';
    document.getElementById('history-loading').style.display = 'none';
    document.getElementById('history-fallback').style.display = '';
    return;
  }

  // Step 2: Fall back to Cloudflare Worker proxy (legacy)
  const { results, corsOk } = await fetchHistoricalPanos(lat, lng);
  state.history = results;

  if (results.length === 0) {
    setHistoryPanel('empty', true);
  } else {
    renderHistoryTimeline(results);
    const countEl = document.getElementById('history-count');
    countEl.textContent = results.length;
    countEl.style.display = '';
    document.getElementById('history-fallback').style.display = '';
    document.getElementById('history-loading').style.display = 'none';
  }
}

function setHistoryPanel(status, showFallback) {
  const timeline  = document.getElementById('history-timeline');
  const loadingEl = document.getElementById('history-loading');
  const countEl   = document.getElementById('history-count');
  const fallback  = document.getElementById('history-fallback');

  countEl.style.display   = 'none';
  loadingEl.style.display = 'none';
  fallback.style.display  = showFallback ? '' : 'none';

  if (status === 'loading') {
    loadingEl.style.display = '';
    timeline.innerHTML = '<span class="muted">Loading historical imagery…</span>';
  } else if (status === 'empty') {
    timeline.innerHTML = '<span class="muted">No historical imagery found for this location.</span>';
  } else if (status === null) {
    timeline.innerHTML = '<span class="muted">Select a coordinate to load timeline.</span>';
  }
}

function renderHistoryTimeline(panos) {
  const timeline  = document.getElementById('history-timeline');
  const loadingEl = document.getElementById('history-loading');
  loadingEl.style.display = 'none';
  timeline.innerHTML = '';

  // Deduplicate by date (keep one per month)
  const seen = new Set();
  const unique = panos.filter(p => {
    const key = p.date || p.panoId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'history-btn';
    btn.title = `Panorama ID: ${item.panoId}\nDate: ${item.date || 'Unknown'}`;
    btn.innerHTML = `
      <span class="history-date">${formatDate(item.date)}</span>
      <span class="history-id">${item.panoId.slice(0, 8)}…</span>
    `;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.history-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      openPanorama(item.panoId);
      if (item.lat && item.lng) {
        state.map.panTo({ lat: item.lat, lng: item.lng });
      }
    });
    timeline.appendChild(btn);
  });
}

function updateGoogleMapsLink(lat, lng, panoId) {
  const a = document.getElementById('gmaps-link');
  if (a) {
    a.href = `https://www.google.com/maps/@${lat},${lng},3a,75y,0h,90t/data=!3m4!1e1!3m2!1s${panoId}!2e0`;
  }
}

/* ============================================================
   COORDINATE LIST RENDERING
   ============================================================ */
function renderCoordList() {
  const list  = document.getElementById('coord-list');
  const badge = document.getElementById('results-badge');

  badge.textContent = state.results.length;

  if (!state.results.length) {
    list.innerHTML = '<div class="empty-state">No coordinates loaded yet.<br><small>Paste coords, upload a CSV, or click the map.</small></div>';
    return;
  }

  list.innerHTML = '';
  state.results.forEach((r, i) => {
    list.appendChild(buildCoordItem(r, i));
  });
}

function buildCoordItem(result, idx) {
  const div = document.createElement('div');
  div.className = `coord-item ${idx === state.selectedIdx ? 'selected' : ''}`;
  div.dataset.idx = idx;

  let statusClass, statusChar;
  if      (result.found === null)  { statusClass = 'pending';   statusChar = '…'; }
  else if (result.found === true)  { statusClass = 'found';     statusChar = '✓'; }
  else                             { statusClass = 'not-found'; statusChar = '✗'; }

  const dateHtml = result.date
    ? `<div class="coord-date">📅 ${formatDate(result.date)}</div>` : '';
  const distHtml = result.distM !== null
    ? `<div class="coord-dist">${result.distM} m away</div>` : '';

  div.innerHTML = `
    <div class="coord-status ${statusClass}">${statusChar}</div>
    <div class="coord-info">
      <div class="coord-label">${esc(result.label)}</div>
      <div class="coord-latlng">${result.inputLat.toFixed(5)}, ${result.inputLng.toFixed(5)}</div>
      ${dateHtml}${distHtml}
    </div>
    <button class="btn-open-pano" title="Open 360° viewer">▶</button>
  `;

  div.addEventListener('click', () => selectCoordinate(idx));
  div.querySelector('.btn-open-pano').addEventListener('click', e => {
    e.stopPropagation();
    selectCoordinate(idx);
  });

  return div;
}

/** Targeted refresh of a single list item (avoids full re-render during batch) */
function refreshCoordItem(idx) {
  const existing = document.querySelector(`.coord-item[data-idx="${idx}"]`);
  if (!existing) {
    renderCoordList();
    return;
  }
  existing.replaceWith(buildCoordItem(state.results[idx], idx));
  // Update badge count
  document.getElementById('results-badge').textContent = state.results.length;
}

/* ============================================================
   PROGRESS & STATUS UI
   ============================================================ */
function showProgress(show) {
  document.getElementById('progress-area').style.display = show ? '' : 'none';
  document.getElementById('process-btn').disabled = show;
}

function updateProgress(processed, total) {
  const pct = Math.round((processed / total) * 100);
  document.getElementById('progress-bar-fill').style.width = `${pct}%`;
  document.getElementById('progress-text').textContent     = `${processed} / ${total} (${pct}%)`;
}

function showStatus(message, type = 'info') {
  const el = document.getElementById('status-msg');
  el.textContent = message;
  el.className = `status-msg status-${type}`;
  el.style.display = '';
}

function hideStatus() {
  document.getElementById('status-msg').style.display = 'none';
}

/* ============================================================
   APP VISIBILITY
   ============================================================ */
function showApp() {
  document.getElementById('setup-modal').style.display = 'none';
  document.getElementById('app').style.display = '';
  hidePanorama();
}

function showApiKeyError(msg) {
  const el = document.getElementById('api-key-error');
  el.textContent = msg;
  el.style.display = '';
}

/* ============================================================
   CSV EXPORT
   ============================================================ */
function exportResultsCSV() {
  if (!state.results.length) {
    alert('No results to export yet.');
    return;
  }

  const header = ['label', 'input_lat', 'input_lng', 'found', 'pano_id',
                  'pano_lat', 'pano_lng', 'imagery_date', 'distance_m'];
  const rows   = state.results.map(r => [
    r.label,
    r.inputLat,
    r.inputLng,
    r.found === null ? 'pending' : r.found ? 'yes' : 'no',
    r.panoId  || '',
    r.panoLat || '',
    r.panoLng || '',
    r.date    || '',
    r.distM   !== null ? r.distM : '',
  ]);

  const csv = [header, ...rows]
    .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `canopy_streetview_${new Date().toISOString().slice(0, 10)}.csv`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

/* ============================================================
   CLEAR ALL
   ============================================================ */
function clearAll() {
  if (state.processing) return;
  if (!confirm('Clear all coordinates and results?')) return;

  state.rawCoords   = [];
  state.results     = [];
  state.selectedIdx = null;
  state.history     = null;

  clearMarkers();
  renderCoordList();
  hidePanorama();
  setHistoryPanel(null, false);
  hideStatus();

  document.getElementById('coord-textarea').value = '';
  document.getElementById('csv-preview').style.display = 'none';
  document.getElementById('file-input').value = '';
}

/* ============================================================
   EVENT LISTENERS
   ============================================================ */
/**
 * UI listeners that do NOT require google.maps — set up on DOMContentLoaded.
 */
function setupUIListeners() {
  // --- Tab switching ---
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === tab)
      );
      ['paste', 'upload', 'single'].forEach(name => {
        document.getElementById(`tab-${name}`).style.display = name === tab ? '' : 'none';
      });
    });
  });

  // --- Textarea live parse (updates count only, no processing) ---
  document.getElementById('coord-textarea').addEventListener('input', () => {
    const text = document.getElementById('coord-textarea').value.trim();
    if (!text) {
      state.rawCoords = [];
      document.getElementById('results-badge').textContent = '0';
      renderCoordList();
      return;
    }
    const { coords } = parseCoordinatesFromText(text);
    state.rawCoords = coords;
    document.getElementById('results-badge').textContent = coords.length;
    if (coords.length > 0) {
      showStatus(`${coords.length} coordinate${coords.length > 1 ? 's' : ''} ready — click "Find Street Views" to process.`, 'info');
    }
  });

  // --- CSV file upload ---
  const fileInput = document.getElementById('file-input');
  const dropZone  = document.getElementById('drop-zone');

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFileUpload(e.target.files[0]); });
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFileUpload(e.dataTransfer.files[0]);
  });

  // --- Header buttons (no Maps dependency) ---
  document.getElementById('export-btn').addEventListener('click', exportResultsCSV);
  document.getElementById('clear-btn').addEventListener('click', clearAll);
  document.getElementById('settings-btn').addEventListener('click', () => {
    if (confirm('Change API key? The page will reload.')) {
      clearStoredApiKey();
      location.reload();
    }
  });
}

/**
 * Listeners that require google.maps to be loaded — called from _onMapsReady.
 */
function setupMapsListeners() {
  // --- Process button ---
  document.getElementById('process-btn').addEventListener('click', () => {
    const text = document.getElementById('coord-textarea').value.trim();
    if (text && state.rawCoords.length === 0) {
      const { coords, errors } = parseCoordinatesFromText(text);
      if (errors.length && !coords.length) {
        showStatus(`Could not parse any coordinates: ${errors[0]}`, 'error');
        return;
      }
      state.rawCoords = coords;
    }
    processAllCoordinates();
  });

  // --- Cancel button ---
  document.getElementById('cancel-btn').addEventListener('click', () => {
    state.cancelled = true;
  });

  // --- Single point add button ---
  document.getElementById('single-add-btn').addEventListener('click', () => {
    const lat   = parseFloat(document.getElementById('single-lat').value);
    const lng   = parseFloat(document.getElementById('single-lng').value);
    const label = document.getElementById('single-label').value.trim()
                  || `Point ${state.rawCoords.length + 1}`;
    if (!isValidLatLng(lat, lng)) {
      showStatus('Please enter valid latitude and longitude values.', 'error');
      return;
    }
    handleMapClick(lat, lng);
    state.rawCoords[state.rawCoords.length - 1].label = label;
    state.results[state.results.length   - 1].label   = label;
    renderCoordList();
  });
}

/* ============================================================
   FILE UPLOAD HANDLER
   ============================================================ */
async function handleFileUpload(file) {
  const text = await file.text();
  const { coords, errors } = parseCSVText(text);

  if (!coords.length) {
    showStatus(`No valid coordinates found in "${file.name}". Make sure the file has lat/lng columns.`, 'error');
    return;
  }

  state.rawCoords = coords;
  state.results   = [];
  clearMarkers();
  renderCoordList();

  const previewEl = document.getElementById('csv-preview');
  previewEl.style.display = '';
  previewEl.innerHTML = errors.length
    ? `Loaded <strong>${coords.length}</strong> coords from <em>${esc(file.name)}</em> — <span class="warning-text">${errors.length} row${errors.length > 1 ? 's' : ''} skipped</span>`
    : `Loaded <strong>${coords.length}</strong> coordinates from <em>${esc(file.name)}</em>`;

  // Mirror into the textarea for visibility
  document.getElementById('coord-textarea').value =
    coords.map(c => `${c.lat},${c.lng},${c.label}`).join('\n');

  showStatus(
    `${coords.length} coordinates loaded. Click "Find Street Views" to process.`,
    'info'
  );
}

/* ============================================================
   HELPERS
   ============================================================ */
function formatDate(dateStr) {
  if (!dateStr) return 'Unknown';
  const m = /^(\d{4})-(\d{2})/.exec(dateStr);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-01T00:00:00`);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
  }
  return dateStr;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ============================================================
   SETUP MODAL INITIALISATION  (runs immediately on DOM ready)
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  // UI listeners that don't depend on Google Maps load immediately
  setupUIListeners();

  const input     = document.getElementById('api-key-input');
  const proxyInput = document.getElementById('proxy-url-input');
  const submit    = document.getElementById('api-key-submit');

  // Restore saved values
  const storedKey   = getStoredApiKey();
  const storedProxy = localStorage.getItem(CONFIG.LS_PROXY_URL) || '';
  if (storedKey)   input.value      = storedKey;
  if (storedProxy) proxyInput.value = storedProxy;

  // Proxy help toggle
  document.getElementById('proxy-help-toggle').addEventListener('click', e => {
    e.preventDefault();
    const steps = document.getElementById('proxy-help-steps');
    steps.style.display = steps.style.display === 'none' ? '' : 'none';
  });

  const tryLoad = (key) => {
    if (!key || !key.startsWith('AIza')) {
      showApiKeyError('Please enter a valid Google Maps API key (starts with "AIza…").');
      return;
    }
    // Save proxy URL (optional — empty string is fine)
    const proxyVal = proxyInput.value.trim();
    if (proxyVal) {
      localStorage.setItem(CONFIG.LS_PROXY_URL, proxyVal);
    } else {
      localStorage.removeItem(CONFIG.LS_PROXY_URL);
    }

    document.getElementById('api-key-error').style.display = 'none';
    storeApiKey(key);
    state.apiKey = key;
    submit.disabled    = true;
    submit.textContent = 'Loading Google Maps…';
    loadGoogleMaps(key);
  };

  submit.addEventListener('click', () => tryLoad(input.value.trim()));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tryLoad(input.value.trim()); });

  // Auto-load if we already have a key stored
  if (storedKey) {
    submit.disabled    = true;
    submit.textContent = 'Loading Google Maps…';
    state.apiKey = storedKey;
    loadGoogleMaps(storedKey);
  }
});
