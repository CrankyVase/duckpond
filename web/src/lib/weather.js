// WMO weather-code → label + visual theme. Themes drive the card background and
// which icon is drawn. Kept tiny and shared so backend stays lean (it only sends
// the code + isDay).
export function wmo(code, isDay = true) {
  const night = !isDay;
  const T = (label, theme, icon) => ({ label, theme: night && (theme === 'clear' || theme === 'partly') ? theme + '-night' : theme, icon });
  switch (code) {
    case 0: return T(night ? 'Clear' : 'Sunny', 'clear', night ? 'moon' : 'sun');
    case 1: return T('Mainly clear', 'partly', night ? 'moon' : 'sun');
    case 2: return T('Partly cloudy', 'partly', 'partly');
    case 3: return T('Overcast', 'cloud', 'cloud');
    case 45: case 48: return T('Fog', 'fog', 'fog');
    case 51: case 53: case 55: return T('Drizzle', 'rain', 'drizzle');
    case 56: case 57: return T('Freezing drizzle', 'rain', 'drizzle');
    case 61: case 63: case 65: return T('Rain', 'rain', 'rain');
    case 66: case 67: return T('Freezing rain', 'rain', 'rain');
    case 71: case 73: case 75: return T('Snow', 'snow', 'snow');
    case 77: return T('Snow grains', 'snow', 'snow');
    case 80: case 81: case 82: return T('Rain showers', 'rain', 'rain');
    case 85: case 86: return T('Snow showers', 'snow', 'snow');
    case 95: return T('Thunderstorm', 'thunder', 'thunder');
    case 96: case 99: return T('Thunderstorm, hail', 'thunder', 'thunder');
    default: return T('—', 'cloud', 'cloud');
  }
}

// Flat card colors by condition. White text remains legible on each.
export const WEATHER_BG = {
  clear: '#285f9c',
  'clear-night': '#1c2138',
  partly: '#3b6a9b',
  'partly-night': '#232a45',
  cloud: '#47566a',
  fog: '#5c6572',
  rain: '#2c3a4b',
  snow: '#556678',
  thunder: '#241f36',
};

export function dayName(iso) {
  return new Date(iso + 'T00:00').toLocaleDateString(undefined, { weekday: 'short' });
}
