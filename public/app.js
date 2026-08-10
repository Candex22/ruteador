let map;
let config;
let serviceLayer;
let routeLayer;
let markerLayer;
let lastResult = null;

const $ = id => document.getElementById(id);
const addressesEl = $('addresses');
const optimizeBtn = $('optimizeBtn');
const statusEl = $('status');
const summaryEl = $('summary');
const routeListSection = $('routeListSection');
const googleMapsSection = $('googleMapsSection');
const issuesSection = $('issuesSection');

function linesFromText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(x => x.replace(/^\s*["']|["']\s*$/g, '').trim())
    .filter(Boolean);
}

function uniqueLines(text) {
  const seen = new Set();
  return linesFromText(text).filter(line => {
    const key = line.toLocaleLowerCase('es-AR').replace(/\s+/g, ' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function updateCount() {
  $('countBadge').textContent = uniqueLines(addressesEl.value).length;
}

function setStatus(message, type = 'info') {
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = '';
    statusEl.className = 'status';
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.className = `status${type === 'error' ? ' error' : ''}`;
}

function setLoading(loading) {
  optimizeBtn.disabled = loading;
  optimizeBtn.classList.toggle('loading', loading);
  optimizeBtn.querySelector('.btn-label').textContent = loading ? 'Calculando…' : 'Calcular ruta óptima';
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '—';
  return `${(meters / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 })} km`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const mins = Math.round(seconds / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}

function initMap() {
  const b = config.bounds;
  const bounds = L.latLngBounds([b.south, b.west], [b.north, b.east]);
  map = L.map('map', {
    zoomControl: true,
    maxBounds: bounds.pad(0.02),
    maxBoundsViscosity: 1.0,
    minZoom: 12,
    maxZoom: 19
  });

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(map);

  map.fitBounds(bounds, { padding: [14, 14] });

  const latLngs = config.polygon.map(([lon, lat]) => [lat, lon]);
  serviceLayer = L.polygon(latLngs, {
    color: '#e61b1b',
    weight: 3,
    fillColor: '#e61b1b',
    fillOpacity: 0.035
  }).addTo(map);

  // Máscara visual exterior, para que la zona de trabajo quede clara.
  const outer = [
    [b.south - .3, b.west - .3], [b.north + .3, b.west - .3],
    [b.north + .3, b.east + .3], [b.south - .3, b.east + .3]
  ];
  L.polygon([outer, latLngs.slice().reverse()], {
    stroke: false,
    fillColor: '#76818a',
    fillOpacity: .15,
    fillRule: 'evenodd',
    interactive: false
  }).addTo(map);
}

function markerIcon(label, isBase = false) {
  return L.divIcon({
    className: `route-marker${isBase ? ' base' : ''}`,
    html: `<span>${label}</span>`,
    iconSize: isBase ? [31, 31] : [26, 26],
    iconAnchor: isBase ? [15, 15] : [13, 13]
  });
}

function renderRoute(result) {
  if (routeLayer) routeLayer.remove();
  if (markerLayer) markerLayer.remove();
  markerLayer = L.layerGroup().addTo(map);

  const geo = result.route.geometry;
  routeLayer = L.geoJSON(geo, {
    style: { color: '#165dff', weight: 5, opacity: .86 }
  }).addTo(map);

  const stops = result.stops;
  stops.forEach((stop, idx) => {
    // La base aparece dos veces (inicio y fin); dibujamos un único marcador de base.
    if (stop.isBase && idx === stops.length - 1) return;
    const label = stop.isBase ? '↻' : String(idx);
    const marker = L.marker([stop.lat, stop.lon], { icon: markerIcon(label, stop.isBase) }).addTo(markerLayer);
    marker.bindTooltip(stop.isBase ? 'Base: salida y regreso' : `${idx}. ${stop.address}`, { direction: 'top' });
  });

  const routeBounds = routeLayer.getBounds();
  if (routeBounds.isValid()) map.fitBounds(routeBounds, { padding: [45, 45], maxZoom: 15 });
}

function renderSummary(result) {
  summaryEl.hidden = false;
  $('distanceValue').textContent = formatDistance(result.route.distance);
  $('durationValue').textContent = formatDuration(result.route.duration);
  $('stopsValue').textContent = String(result.validCount);

  const pct = Math.round((result.routeInsideRatio || 0) * 100);
  $('methodText').textContent = `${result.method}. Ruta calculada en ${result.route.segmentCount} tramo(s). ${pct}% de la geometría muestreada quedó dentro del polígono operativo.`;
}

function googleMapsUrl(segment) {
  const first = segment[0];
  const last = segment[segment.length - 1];
  const params = new URLSearchParams({
    api: '1',
    origin: `${first.lat},${first.lon}`,
    destination: `${last.lat},${last.lon}`,
    travelmode: 'driving'
  });
  if (segment.length > 2) {
    params.set('waypoints', segment.slice(1, -1).map(p => `${p.lat},${p.lon}`).join('|'));
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function stopShortLabel(stop, index, total) {
  if (stop.isBase) return index === 0 ? 'Salida' : 'Regreso';
  return `Parada ${index}`;
}

function buildGoogleMapsSegments(stops) {
  // Google Maps permite 10 ubicaciones en una ruta: 1 origen + hasta
  // 9 paradas, contando el destino final. Por eso cada enlace contiene
  // como máximo 10 puntos totales (origen + 8 intermedios + destino).
  const MAX_POINTS_PER_LINK = 10;
  const segments = [];
  let start = 0;
  while (start < stops.length - 1) {
    const end = Math.min(stops.length - 1, start + MAX_POINTS_PER_LINK - 1);
    const points = stops.slice(start, end + 1);
    segments.push({
      start,
      end,
      points,
      url: googleMapsUrl(points)
    });
    start = end;
  }
  return segments;
}

function renderGoogleMaps(result) {
  const segments = buildGoogleMapsSegments(result.stops || []);
  if (!segments.length) {
    googleMapsSection.hidden = true;
    return;
  }

  googleMapsSection.hidden = false;
  $('googleMapsBadge').textContent = String(segments.length);
  $('googleMapsHelp').textContent = segments.length === 1
    ? 'Este enlace abre el recorrido completo con las paradas en el orden calculado.'
    : `Google Maps limita los puntos por enlace. Se generaron ${segments.length} tramos consecutivos; abrilos en orden y no se pierde ninguna parada.`;

  $('googleMapsLinks').innerHTML = segments.map((seg, i) => {
    const from = stopShortLabel(result.stops[seg.start], seg.start, result.stops.length);
    const to = stopShortLabel(result.stops[seg.end], seg.end, result.stops.length);
    const label = segments.length === 1 ? 'Abrir ruta completa' : `Abrir tramo ${i + 1}`;
    return `<a class="google-maps-btn" href="${escapeHtml(seg.url)}" target="_blank" rel="noopener noreferrer"><strong>${label}</strong><small>${escapeHtml(from)} → ${escapeHtml(to)}</small></a>`;
  }).join('');
}

function renderStops(result) {
  routeListSection.hidden = false;
  const list = $('routeList');
  list.innerHTML = '';

  result.stops.forEach((stop, index) => {
    const li = document.createElement('li');
    li.className = stop.isBase ? 'base' : '';
    const num = stop.isBase ? (index === 0 ? 'S' : 'R') : String(index);
    li.innerHTML = `<span class="num">${num}</span><strong>${escapeHtml(stop.isBase ? (index === 0 ? 'Salida' : 'Regreso') : stop.address)}</strong>${stop.displayName ? `<small>${escapeHtml(stop.displayName)}</small>` : ''}`;
    list.appendChild(li);
  });
}

function renderIssues(result) {
  const issues = [];
  for (const item of result.outside || []) {
    issues.push({ type: 'warning', text: `${item.input}: fue ubicada fuera del área permitida.` });
  }
  for (const item of result.notFound || []) {
    issues.push({ type: 'error', text: `${item.input}: no se pudo ubicar${item.error ? ` (${item.error})` : ''}.` });
  }
  if (!issues.length) {
    issuesSection.hidden = true;
    $('issuesList').innerHTML = '';
    return;
  }
  issuesSection.hidden = false;
  $('issuesList').innerHTML = issues.map(x => `<div class="issue-card${x.type === 'error' ? ' error' : ''}">${escapeHtml(x.text)}</div>`).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}

async function optimize() {
  const addresses = uniqueLines(addressesEl.value);
  if (!addresses.length) {
    setStatus('Ingresá al menos una dirección, una por línea.', 'error');
    addressesEl.focus();
    return;
  }

  setLoading(true);
  setStatus(`Procesando ${addresses.length} dirección${addresses.length === 1 ? '' : 'es'}…`);
  summaryEl.hidden = true;
  routeListSection.hidden = true;
  googleMapsSection.hidden = true;
  issuesSection.hidden = true;

  try {
    const response = await fetch('/api/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses })
    });
    const json = await response.json();
    if (!response.ok) {
      renderIssues(json);
      throw new Error(json.error || 'No se pudo calcular la ruta.');
    }

    lastResult = json;
    renderRoute(json);
    renderSummary(json);
    renderGoogleMaps(json);
    renderStops(json);
    renderIssues(json);

    const omitted = (json.outside?.length || 0) + (json.notFound?.length || 0);
    setStatus(omitted
      ? `Ruta lista. Se usaron ${json.validCount} paradas y quedaron ${omitted} para revisar.`
      : `Ruta lista con ${json.validCount} paradas. Salida y regreso: ${json.startAddress}.`);
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function importFile(file) {
  const text = await file.text();
  let lines = [];
  if (/\.csv$/i.test(file.name)) {
    // Acepta CSV simple: toma la primera columna no vacía de cada fila.
    lines = text.split(/\r?\n/).map(row => {
      const cells = row.split(/[;,\t]/).map(x => x.trim().replace(/^"|"$/g, ''));
      return cells.find(Boolean) || '';
    }).filter(Boolean);
    if (lines.length && /direcci|address/i.test(lines[0])) lines.shift();
  } else {
    lines = linesFromText(text);
  }
  const current = uniqueLines(addressesEl.value);
  addressesEl.value = [...current, ...lines].join('\n');
  updateCount();
}

$('fileInput').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  try { await importFile(file); }
  catch (err) { setStatus(`No se pudo leer el archivo: ${err.message}`, 'error'); }
  e.target.value = '';
});

$('clearBtn').addEventListener('click', () => {
  addressesEl.value = '';
  updateCount();
  setStatus('');
  summaryEl.hidden = true;
  routeListSection.hidden = true;
  googleMapsSection.hidden = true;
  issuesSection.hidden = true;
});

$('copyBtn').addEventListener('click', async () => {
  if (!lastResult) return;
  const text = lastResult.stops.map((s, i) => {
    if (s.isBase) return `${i === 0 ? 'SALIDA' : 'REGRESO'} — ${lastResult.startAddress}`;
    return `${i}. ${s.address}`;
  }).join('\n');
  await navigator.clipboard.writeText(text);
  $('copyBtn').textContent = 'Copiado';
  setTimeout(() => $('copyBtn').textContent = 'Copiar', 1200);
});

addressesEl.addEventListener('input', updateCount);
optimizeBtn.addEventListener('click', optimize);

(async function bootstrap() {
  try {
    const response = await fetch('/api/config');
    config = await response.json();
    $('baseAddress').textContent = config.startAddress.replace(', Vicente López, Buenos Aires, Argentina', '');
    initMap();
    updateCount();
  } catch (err) {
    setStatus(`No se pudo iniciar el mapa: ${err.message}`, 'error');
  }
})();
