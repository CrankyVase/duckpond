// UI preferences — client-side only, persisted to localStorage.
// Model/generation settings live server-side per model; these are look-and-feel.

const KEY = 'dp_prefs';

const DEFAULTS = {
  fontSize: 'medium',        // small | medium | large
  density: 'comfortable',    // compact | comfortable | spacious
  autoScroll: true,          // follow the stream
  sendOnEnter: true,         // Enter sends, Shift+Enter newline
  autoExpandThinking: false, // open finished thought panels by default
  autoCompact: true,         // summarize old turns automatically at 75% context
  userLoc: null,             // { lat, lon } cached after a silent, one-time browser geolocation ask
  researchMode: 'normal',    // quick | normal | ultra — web-search depth
};

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; }
  catch { return { ...DEFAULTS }; }
}

export const prefs = $state(load());

export function savePrefs() {
  localStorage.setItem(KEY, JSON.stringify(prefs));
}

export function resetPrefs() {
  Object.assign(prefs, DEFAULTS);
  savePrefs();
}

// reflect font size onto <html> so plain CSS can target it
export function applyPrefs() {
  document.documentElement.dataset.fontsize = prefs.fontSize;
  document.documentElement.dataset.density = prefs.density;
}
