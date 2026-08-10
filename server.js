const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'geocode-cache.json');

// Se puede apuntar a instancias propias para uso intensivo.
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';
const USER_AGENT = process.env.GEOCODER_USER_AGENT || 'RuteadorVicenteLopez/1.3 (uso local)';
const GEOCODE_CACHE_VERSION = 'boundary-red-v3';

const START_ADDRESS = 'Juan Bautista Alberdi 1150, Olivos, Vicente López, Buenos Aires, Argentina';

// Área operativa corregida a partir del trazado marcado por el usuario (v1.3):
// - límite noroeste/norte: Av. Márquez y sector Hipódromo hasta la traza indicada;
// - límite oeste/suroeste: vías del Ferrocarril Belgrano Norte;
// - límite sur: Av. General Paz;
// - límite este: costa del Río de la Plata.
//
// A diferencia de las versiones anteriores, este polígono NO usa la diagonal
// Lomas de San Isidro -> Florida ni se extiende mar adentro. Los puntos del
// lado terrestre fueron ajustados sobre la referencia roja enviada por el usuario.
const SERVICE_POLYGON = [
  [-58.51538, -34.47309], // extremo norte, junto al sector Acassuso / Hipódromo
  [-58.55586, -34.49578], // Av. Márquez hacia Boulogne
  [-58.56810, -34.50775], // enlace con la traza del Belgrano Norte
  [-58.54287, -34.52811], // Belgrano Norte: Villa Adelina / Munro
  [-58.49297, -34.54878], // Belgrano Norte / llegada a General Paz
  [-58.47460, -34.54490], // General Paz hacia el este
  [-58.45418, -34.53494], // General Paz / sector ribereño

  // Costa del Río de la Plata, de sur a norte.
  [-58.45889, -34.53059],
  [-58.46416, -34.52593],
  [-58.46868, -34.52204],
  [-58.47244, -34.51816],
  [-58.47583, -34.51350],
  [-58.47847, -34.50728],
  [-58.47998, -34.50106],
  [-58.48035, -34.49485],
  [-58.48092, -34.48863],
  [-58.48205, -34.48241],
  [-58.48431, -34.47698],
  [-58.48676, -34.47231],

  // Cierre del límite norte hasta el extremo marcado en rojo.
  [-58.51538, -34.47309]
];

const MAP_BOUNDS = {
  // Margen pequeño alrededor del área real. También se usa como viewbox del geocodificador.
  south: -34.554,
  west: -58.574,
  north: -34.468,
  east: -58.449
};

fs.mkdirSync(DATA_DIR, { recursive: true });
let geocodeCache = {};
try {
  geocodeCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch (_) {}

let lastNominatimAt = 0;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function normalizeAddress(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[-•*\d.)\s]+/, '')
    .trim();
}

function keyForAddress(address) {
  return `${GEOCODE_CACHE_VERSION}:${normalizeAddress(address).toLocaleLowerCase('es-AR')}`;
}

function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-AR');
}

const LOCALITY_HINTS = [
  'martinez', 'olivos', 'vicente lopez', 'la lucila', 'florida', 'munro',
  'villa martelli', 'carapachay', 'villa adelina', 'acassuso', 'san isidro', 'beccar'
];

function localityMatchScore(input, displayName) {
  const a = fold(input);
  const b = fold(displayName);
  let score = 0;
  for (const locality of LOCALITY_HINTS) {
    if (a.includes(locality) && b.includes(locality)) score += 120;
    else if (a.includes(locality) && !b.includes(locality)) score -= 60;
  }
  return score;
}

function geocodeQuery(address) {
  const f = fold(address);
  if (f.includes('argentina')) return address;
  // Si el usuario ya indicó una localidad del corredor, la respetamos tal cual.
  // Esto evita consultas contradictorias como "Martínez, Vicente López".
  const hasLocality = LOCALITY_HINTS.some(locality => f.includes(locality));
  if (hasLocality) return `${address}, Provincia de Buenos Aires, Argentina`;
  // Para direcciones sin localidad, el viewbox acotado decide entre coincidencias.
  return `${address}, Buenos Aires, Argentina`;
}

function saveCache() {
  const tmp = CACHE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(geocodeCache, null, 2));
  fs.renameSync(tmp, CACHE_FILE);
}

function pointInPolygon(lon, lat, polygon = SERVICE_POLYGON) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function haversine(a, b) {
  const R = 6371000;
  const rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const lat1 = rad(a.lat);
  const lat2 = rad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function nominatimSearch(q) {
  const elapsed = Date.now() - lastNominatimAt;
  if (elapsed < 1100) await sleep(1100 - elapsed);

  const u = new URL('/search', NOMINATIM_URL);
  u.searchParams.set('q', q);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('limit', '10');
  u.searchParams.set('countrycodes', 'ar');
  // viewbox: izquierda,arriba,derecha,abajo. Con bounded=1 funciona como filtro real.
  u.searchParams.set('viewbox', `${MAP_BOUNDS.west},${MAP_BOUNDS.north},${MAP_BOUNDS.east},${MAP_BOUNDS.south}`);
  u.searchParams.set('bounded', '1');
  u.searchParams.set('addressdetails', '1');

  lastNominatimAt = Date.now();
  const response = await fetch(u, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'es-AR,es;q=0.9'
    }
  });
  if (!response.ok) throw new Error(`Geocodificación HTTP ${response.status}`);
  return response.json();
}

async function geocodeOne(address) {
  const normalized = normalizeAddress(address);
  const cacheKey = keyForAddress(normalized);
  if (geocodeCache[cacheKey]) return { ...geocodeCache[cacheKey], cached: true };

  // Primera búsqueda: conserva Martínez/Olivos/etc. si el usuario lo escribió,
  // pero nunca agrega Vicente López de forma forzada.
  let rows = await nominatimSearch(geocodeQuery(normalized));

  // Fallback útil para domicilios escritos sólo como "calle número".
  // Se ejecuta únicamente si la consulta regional no encontró nada.
  if (!rows.length) rows = await nominatimSearch(normalized);
  if (!rows.length) return null;

  const inputNumber = (normalized.match(/\b\d{1,6}\b/) || [])[0];
  const ranked = rows
    .map(row => {
      const lat = Number(row.lat);
      const lon = Number(row.lon);
      const inside = pointInPolygon(lon, lat);
      const displayName = row.display_name || '';
      const houseNumber = row.address?.house_number ? String(row.address.house_number) : '';
      let score = inside ? 1000 : 0;
      score += localityMatchScore(normalized, displayName);
      if (inputNumber && houseNumber === inputNumber) score += 80;
      if (row.type === 'house' || row.type === 'building') score += 20;
      return {
        address: normalized,
        displayName,
        lat,
        lon,
        type: row.type,
        inside,
        score
      };
    })
    .sort((a, b) => b.score - a.score);

  const result = ranked[0];
  delete result.score;
  geocodeCache[cacheKey] = result;
  saveCache();
  return { ...result, cached: false };
}

async function geocodeMany(addresses, onProgress) {
  const out = [];
  for (let i = 0; i < addresses.length; i++) {
    let result = null;
    let error = null;
    try {
      result = await geocodeOne(addresses[i]);
    } catch (err) {
      error = err.message;
    }
    out.push({ input: addresses[i], result, error });
    if (onProgress) onProgress(i + 1, addresses.length);
  }
  return out;
}

function nearestNeighbor(points, startIndex = 0, distanceFn) {
  const remaining = new Set(points.map((_, i) => i));
  remaining.delete(startIndex);
  const route = [startIndex];
  let current = startIndex;
  while (remaining.size) {
    let best = null;
    let bestD = Infinity;
    for (const idx of remaining) {
      const d = distanceFn(current, idx);
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    }
    route.push(best);
    remaining.delete(best);
    current = best;
  }
  route.push(startIndex);
  return route;
}

function routeCost(route, distanceFn) {
  let total = 0;
  for (let i = 1; i < route.length; i++) total += distanceFn(route[i - 1], route[i]);
  return total;
}

function twoOpt(route, distanceFn, maxPasses = 5) {
  let best = route.slice();
  let improved = true;
  let pass = 0;
  while (improved && pass++ < maxPasses) {
    improved = false;
    for (let i = 1; i < best.length - 2; i++) {
      for (let k = i + 1; k < best.length - 1; k++) {
        const a = best[i - 1], b = best[i], c = best[k], d = best[k + 1];
        const oldCost = distanceFn(a, b) + distanceFn(c, d);
        const newCost = distanceFn(a, c) + distanceFn(b, d);
        if (newCost + 0.01 < oldCost) {
          best = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
          improved = true;
        }
      }
    }
  }
  return best;
}

async function osrmTable(points) {
  const coords = points.map(p => `${p.lon},${p.lat}`).join(';');
  const u = new URL(`/table/v1/driving/${coords}`, OSRM_URL);
  u.searchParams.set('annotations', 'duration,distance');
  const response = await fetch(u);
  if (!response.ok) throw new Error(`OSRM Table HTTP ${response.status}`);
  const json = await response.json();
  if (json.code !== 'Ok') throw new Error(json.message || 'OSRM Table no pudo calcular la matriz');
  return json;
}

async function optimizeOrder(points) {
  // point[0] siempre es la base. Para conjuntos medianos usamos tiempos reales de calle.
  if (points.length <= 70) {
    try {
      const table = await osrmTable(points);
      const duration = (i, j) => Number.isFinite(table.durations?.[i]?.[j])
        ? table.durations[i][j]
        : haversine(points[i], points[j]);
      let route = nearestNeighbor(points, 0, duration);
      route = twoOpt(route, duration, 8);
      return { order: route, method: 'matriz vial OSRM + vecino más cercano + 2-opt' };
    } catch (err) {
      console.warn('Fallo matriz OSRM; usando heurística geográfica:', err.message);
    }
  }

  const distance = (i, j) => haversine(points[i], points[j]);
  let route = nearestNeighbor(points, 0, distance);
  const passes = points.length > 500 ? 1 : points.length > 200 ? 2 : 5;
  route = twoOpt(route, distance, passes);
  return { order: route, method: 'heurística geográfica escalable + 2-opt' };
}

async function routeChunk(points) {
  const coords = points.map(p => `${p.lon},${p.lat}`).join(';');
  const u = new URL(`/route/v1/driving/${coords}`, OSRM_URL);
  u.searchParams.set('overview', 'full');
  u.searchParams.set('geometries', 'geojson');
  u.searchParams.set('steps', 'false');
  u.searchParams.set('continue_straight', 'false');
  const response = await fetch(u);
  if (!response.ok) throw new Error(`OSRM Route HTTP ${response.status}`);
  const json = await response.json();
  if (json.code !== 'Ok' || !json.routes?.length) throw new Error(json.message || 'No se pudo calcular la ruta vial');
  return json.routes[0];
}

async function buildRoadRoute(orderedPoints) {
  // Divide para evitar URLs gigantes y límites de waypoint del servidor demo.
  const MAX_POINTS_PER_REQUEST = 40;
  const coordinates = [];
  let distance = 0;
  let duration = 0;
  let segmentCount = 0;

  for (let start = 0; start < orderedPoints.length - 1; start += MAX_POINTS_PER_REQUEST - 1) {
    const end = Math.min(orderedPoints.length, start + MAX_POINTS_PER_REQUEST);
    const chunk = orderedPoints.slice(start, end);
    if (chunk.length < 2) break;
    const route = await routeChunk(chunk);
    segmentCount++;
    distance += route.distance || 0;
    duration += route.duration || 0;
    const coords = route.geometry?.coordinates || [];
    if (coordinates.length && coords.length) coords.shift();
    coordinates.push(...coords);
  }

  return {
    geometry: { type: 'LineString', coordinates },
    distance,
    duration,
    segmentCount
  };
}

function routeGeometryInsideRatio(geometry) {
  const coords = geometry?.coordinates || [];
  if (!coords.length) return 1;
  // Muestreo para no gastar CPU con geometrías extensas.
  const step = Math.max(1, Math.floor(coords.length / 1500));
  let inside = 0;
  let total = 0;
  for (let i = 0; i < coords.length; i += step) {
    total++;
    if (pointInPolygon(coords[i][0], coords[i][1])) inside++;
  }
  return total ? inside / total : 1;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      // No es un límite de domicilios, sino protección contra cuerpos absurdamente grandes.
      if (body.length > 20 * 1024 * 1024) {
        reject(new Error('La carga supera 20 MB. Dividí el archivo en partes más pequeñas.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (_) { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/config') {
    return json(res, 200, {
      startAddress: START_ADDRESS,
      polygon: SERVICE_POLYGON,
      bounds: MAP_BOUNDS,
      providers: { nominatim: NOMINATIM_URL, osrm: OSRM_URL }
    });
  }

  if (req.method === 'POST' && pathname === '/api/geocode') {
    try {
      const body = await readJson(req);
      const raw = Array.isArray(body.addresses) ? body.addresses : [];
      const addresses = [];
      const seen = new Set();
      for (const item of raw) {
        const address = normalizeAddress(item);
        const key = keyForAddress(address);
        if (address && !seen.has(key)) {
          seen.add(key);
          addresses.push(address);
        }
      }
      const results = await geocodeMany(addresses);
      return json(res, 200, { results });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/optimize') {
    try {
      const body = await readJson(req);
      const raw = Array.isArray(body.addresses) ? body.addresses : [];
      const addresses = [];
      const seen = new Set();
      for (const item of raw) {
        const address = normalizeAddress(item);
        const key = keyForAddress(address);
        if (address && !seen.has(key) && key !== keyForAddress(START_ADDRESS)) {
          seen.add(key);
          addresses.push(address);
        }
      }
      if (!addresses.length) return json(res, 400, { error: 'Ingresá al menos una dirección.' });

      const base = await geocodeOne(START_ADDRESS);
      if (!base) throw new Error('No se pudo ubicar el punto de salida fijo.');

      const geocoded = await geocodeMany(addresses);
      const notFound = geocoded.filter(x => !x.result).map(x => ({ input: x.input, error: x.error || 'No encontrada' }));
      const outside = geocoded.filter(x => x.result && !x.result.inside).map(x => ({ input: x.input, ...x.result }));
      const valid = geocoded.filter(x => x.result && x.result.inside).map(x => x.result);

      if (!valid.length) {
        return json(res, 422, {
          error: 'Ninguna dirección válida quedó dentro del área operativa.',
          notFound,
          outside
        });
      }

      const points = [{ ...base, address: START_ADDRESS, isBase: true }, ...valid];
      const optimized = await optimizeOrder(points);
      const orderedPoints = optimized.order.map(i => points[i]);
      const road = await buildRoadRoute(orderedPoints);
      const insideRatio = routeGeometryInsideRatio(road.geometry);

      const stops = orderedPoints.map((p, index) => ({
        order: index,
        address: p.address,
        displayName: p.displayName,
        lat: p.lat,
        lon: p.lon,
        isBase: Boolean(p.isBase)
      }));

      return json(res, 200, {
        startAddress: START_ADDRESS,
        inputCount: addresses.length,
        validCount: valid.length,
        notFound,
        outside,
        method: optimized.method,
        stops,
        route: road,
        routeInsideRatio: insideRatio
      });
    } catch (err) {
      console.error(err);
      return json(res, 500, { error: err.message || 'Error interno' });
    }
  }

  return false;
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel).replace(/\\/g, '/');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    const handled = await handleApi(req, res, url.pathname);
    if (handled === false) json(res, 404, { error: 'API no encontrada' });
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Ruteador Vicente López: http://${HOST}:${PORT}`);
});
