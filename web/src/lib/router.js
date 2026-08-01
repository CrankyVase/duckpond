// Client-side path helpers for DuckPond deep links.
//
// URL shape (per-user namespace):
//   /u/{userId}/{chat-slug}+{chatId}   e.g. /u/3/pond-ideas+42
//   /u/{userId}/stats | /speech | /files | /settings | /themes | /providers | /costs
//   /u/{userId}                        home for that user
//   /login                             public
//   /invite/<token>                    public
//
// Auth: App never shows chrome without a session. Ownership: the userId in the
// path must match the logged-in user, and the API already scopes every
// conversation by user_id (404 for anyone else's chat id).

export function slugify(title) {
  const s = String(title ?? 'chat')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'chat';
}

/** /u/3/my-chat-title+42 */
export function chatPath(userId, title, chatId) {
  return `/u/${userId}/${slugify(title)}+${chatId}`;
}

/** /u/3 or /u/3/stats … */
export function userHome(userId) {
  return `/u/${userId}`;
}

export function userSubpath(userId, sub) {
  return `/u/${userId}/${sub}`;
}

/**
 * Parse a pathname into a route object.
 * @returns {{
 *   kind: string,
 *   userId?: number,
 *   id?: number,
 *   slug?: string,
 *   token?: string,
 *   path?: string,
 *   foreign?: boolean
 * }}
 */
export function parsePath(pathname, { selfUserId = null } = {}) {
  const raw = String(pathname || '/');
  const p = raw.replace(/\/+$/, '') || '/';

  if (p === '/') return { kind: 'home' };
  if (p === '/login') return { kind: 'login' };

  const invite = p.match(/^\/invite\/([A-Za-z0-9_-]{10,})$/);
  if (invite) return { kind: 'invite', token: invite[1] };

  // Canonical per-user namespace: /u/{userId}/...
  const u = p.match(/^\/u\/(\d+)(?:\/(.*))?$/);
  if (u) {
    const userId = Number(u[1]);
    const rest = (u[2] || '').replace(/\/+$/, '');
    const foreign = selfUserId != null && userId !== Number(selfUserId);

    if (!rest) return { kind: 'home', userId, foreign };
    if (rest === 'stats') return { kind: 'stats', userId, foreign };
    if (rest === 'speech') return { kind: 'speech', userId, foreign };
    if (rest === 'files' || rest === 'images') return { kind: 'files', userId, foreign };
    if (rest === 'settings') return { kind: 'settings', userId, foreign };
    if (rest === 'themes' || rest === 'theme') return { kind: 'themes', userId, foreign };
    if (rest === 'providers') return { kind: 'providers', userId, foreign };
    if (rest === 'costs') return { kind: 'costs', userId, foreign };

    // slug+chatId  or  +chatId  or  bare chatId
    const chat = rest.match(/^(?:(.+)\+)?(\d+)$/);
    if (chat) {
      return {
        kind: 'chat',
        userId,
        id: Number(chat[2]),
        slug: chat[1] || '',
        foreign,
      };
    }
    return { kind: 'unknown', userId, path: p, foreign };
  }

  // Legacy (pre-user-namespace) URLs — still parse so we can redirect into /u/{me}/...
  if (p === '/stats') return { kind: 'stats', legacy: true };
  if (p === '/speech') return { kind: 'speech', legacy: true };
  if (p === '/files' || p === '/images') return { kind: 'files', legacy: true };
  if (p === '/settings') return { kind: 'settings', legacy: true };
  if (p === '/themes' || p === '/theme') return { kind: 'themes', legacy: true };
  if (p === '/providers') return { kind: 'providers', legacy: true };
  if (p === '/costs') return { kind: 'costs', legacy: true };

  const legacyChat = p.match(/^\/(?:([^/]+)\+)?(\d+)$/);
  if (legacyChat) {
    return {
      kind: 'chat',
      id: Number(legacyChat[2]),
      slug: legacyChat[1] || '',
      legacy: true,
    };
  }

  return { kind: 'unknown', path: p };
}

/** Build the canonical path for the current app UI state. */
export function pathForState({
  user = null,
  view = 'chat',
  conv = null,
  themeStudioOpen = false,
} = {}) {
  const uid = user?.id;
  if (uid == null) return '/login';

  if (themeStudioOpen) return userSubpath(uid, 'themes');
  if (view === 'settings') return userSubpath(uid, 'settings');
  if (view === 'stats') return userSubpath(uid, 'stats');
  if (view === 'speech') return userSubpath(uid, 'speech');
  if (view === 'files') return userSubpath(uid, 'files');
  if (view === 'providers') return userSubpath(uid, 'providers');
  if (view === 'costs') return userSubpath(uid, 'costs');
  if (conv?.id != null) return chatPath(uid, conv.title, conv.id);
  return userHome(uid);
}

/**
 * Update the address bar. Uses push (new history entry) or replace.
 * No-op when the path is already correct.
 */
export function setPath(path, { replace = false } = {}) {
  const next = path || '/';
  if (next === location.pathname) return false;
  if (replace) history.replaceState({ dp: true }, '', next);
  else history.pushState({ dp: true }, '', next);
  return true;
}

const NEXT_KEY = 'dp_login_next';

/** Remember where the user wanted to go before being bounced to login. */
export function rememberNext(path) {
  try {
    const p = path || location.pathname + location.search;
    if (p && p !== '/login' && !p.startsWith('/invite/')) {
      sessionStorage.setItem(NEXT_KEY, p);
    }
  } catch { /* private mode */ }
}

export function takeNext() {
  try {
    const p = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
    return p || null;
  } catch { return null; }
}
