// In-chat widgets: the model calls a tool, we fetch from a free/no-key API and
// return a typed widget object. The route streams it live (SSE) and bakes it into
// the message as a ```duckwidget``` block so it persists. See notes/WIDGETS-AND-RESEARCH-PLAN.md.
//
// Data sources (all free, no API key):
//   - Open-Meteo geocoding + forecast (weather)
//   - Nominatim / OpenStreetMap (map geocoding + reverse geocoding)

import { randomUUID } from 'node:crypto';

const UA = 'DuckPond/1.0 (self-hosted assistant)';
const timeout = (ms) => AbortSignal.timeout(ms);

async function getJson(url, ms = 10_000) {
  const res = await fetch(url, { signal: timeout(ms), headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
  return res.json();
}

// ---------- geocoding ----------

// City/place name → coords (Open-Meteo geocoder, tuned for weather lookups).
export async function geocodePlace(name) {
  const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
  const d = await getJson(u);
  const r = d.results?.[0];
  if (!r) throw new Error(`couldn't find "${name}"`);
  const label = [r.name, r.admin1, r.country].filter(Boolean).join(', ');
  return { lat: r.latitude, lon: r.longitude, label, tz: r.timezone };
}

// Free-form query (address, business, landmark) → coords + display name (Nominatim).
export async function geocodeAddress(query) {
  const u = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`;
  const d = await getJson(u);
  const r = Array.isArray(d) ? d[0] : null;
  if (!r) throw new Error(`couldn't find "${query}" on the map`);
  return {
    lat: Number(r.lat), lon: Number(r.lon),
    label: (r.display_name || query).split(',').slice(0, 2).join(',').trim(),
    address: r.display_name || '',
  };
}

// Coords → a human label (reverse geocode). Best-effort; falls back to lat/lon.
export async function reverseGeocode(lat, lon) {
  try {
    const u = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=14`;
    const d = await getJson(u);
    const a = d.address ?? {};
    const label = [a.city || a.town || a.village || a.suburb || a.county, a.state, a.country]
      .filter(Boolean).join(', ');
    return label || d.display_name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  } catch { return `${Number(lat).toFixed(3)}, ${Number(lon).toFixed(3)}`; }
}

// ---------- weather ----------

// Fetch current conditions + a few days of forecast from Open-Meteo.
export async function fetchWeather(lat, lon, units = 'metric') {
  const tempUnit = units === 'imperial' ? 'fahrenheit' : 'celsius';
  const windUnit = units === 'imperial' ? 'mph' : 'kmh';
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + `&forecast_days=5&timezone=auto&temperature_unit=${tempUnit}&wind_speed_unit=${windUnit}`;
  const d = await getJson(u);
  const c = d.current ?? {};
  const daily = (d.daily?.time ?? []).map((date, i) => ({
    date,
    code: d.daily.weather_code[i],
    max: Math.round(d.daily.temperature_2m_max[i]),
    min: Math.round(d.daily.temperature_2m_min[i]),
    precip: d.daily.precipitation_probability_max?.[i] ?? null,
  }));
  return {
    current: {
      temp: Math.round(c.temperature_2m),
      feelsLike: Math.round(c.apparent_temperature),
      humidity: c.relative_humidity_2m,
      wind: Math.round(c.wind_speed_10m),
      code: c.weather_code,
      isDay: c.is_day === 1,
    },
    daily,
    units: { temp: units === 'imperial' ? '°F' : '°C', wind: units === 'imperial' ? 'mph' : 'km/h' },
  };
}

// ---------- widget builders (return the object streamed + persisted) ----------

const widget = (type, data) => ({ type, id: `w_${randomUUID().slice(0, 8)}`, v: 1, data });

export async function makeWeatherWidget({ place, lat, lon, units = 'metric', label }) {
  let coords = { lat, lon, label };
  if (place) coords = await geocodePlace(place);
  else if (lat == null || lon == null) throw new Error('need a place or coordinates for weather');
  else if (!label) coords.label = await reverseGeocode(lat, lon);
  const w = await fetchWeather(coords.lat, coords.lon, units);
  return widget('weather', { place: coords.label, ...w });
}

export async function makeMapWidget({ query, lat, lon, label, zoom = 14 }) {
  let loc;
  if (query) loc = await geocodeAddress(query);
  else if (lat != null && lon != null) loc = { lat, lon, label: label || await reverseGeocode(lat, lon), address: '' };
  else throw new Error('need a query or coordinates for the map');
  return widget('map', {
    lat: loc.lat, lon: loc.lon, zoom,
    label: label || loc.label, address: loc.address,
  });
}
