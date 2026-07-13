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

// CSS gradient per theme (card background). White text sits on all of them.
export const WEATHER_BG = {
  clear: 'linear-gradient(160deg, #4a9fe0 0%, #2f6fb0 55%, #285f9c 100%)',
  'clear-night': 'linear-gradient(160deg, #29304f 0%, #1c2138 60%, #141829 100%)',
  partly: 'linear-gradient(160deg, #6aa8db 0%, #497fb4 60%, #3b6a9b 100%)',
  'partly-night': 'linear-gradient(160deg, #313a5a 0%, #232a45 60%, #1a1f33 100%)',
  cloud: 'linear-gradient(160deg, #6f7f92 0%, #55647a 60%, #47566a 100%)',
  fog: 'linear-gradient(160deg, #8892a0 0%, #6d7684 60%, #5c6572 100%)',
  rain: 'linear-gradient(160deg, #4a6076 0%, #37485c 60%, #2c3a4b 100%)',
  snow: 'linear-gradient(160deg, #7f93ab 0%, #63768e 60%, #556678 100%)',
  thunder: 'linear-gradient(160deg, #4a4361 0%, #322c47 60%, #241f36 100%)',
};

export function dayName(iso) {
  return new Date(iso + 'T00:00').toLocaleDateString(undefined, { weekday: 'short' });
}
