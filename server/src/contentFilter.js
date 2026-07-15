// Content filter focused on IMAGE generation: block nudity / explicit bodies.
// Chat is unrestricted (except a hard floor on sexual content involving minors).
//
// Modes (stored on users.content_filter):
//   off   — no nudity filter on images (CSAM still blocked everywhere)
//   safe  — block nude / explicit body image prompts (default when they turn filter on)
//   strict — same as safe + "sexy / lingerie / topless photoshoot" style image asks
//
// Chat (kind === 'chat'): never keyword-filtered for adult language — only CSAM floor.

import { db } from './db.js';

export const FILTER_MODES = ['off', 'safe', 'strict'];

// Sexual content involving minors — always blocked (chat + images, even when "off")
const CHILD_SEXUAL = [
  /\b(child\s*porn|cp\b|underage\s*sex|minor\s*nude|pedo|paedo|preteen\s*sex)\b/i,
  /\b(loli|shota|shotacon|lolicon)\b/i,
  /\b((?:10|11|12|13|14|15|16|17)\s*year\s*old).{0,40}(nude|naked|sex|porn|erotic)/i,
  /\b(nude|naked|sex|porn|erotic).{0,40}((?:10|11|12|13|14|15|16|17)\s*year\s*old)/i,
];

// Nudity / explicit bodies — IMAGE prompts only
const NUDITY = [
  /\b(nude|nudes|naked|nudity|fully\s*nude|completely\s*naked)\b/i,
  /\b(full\s*frontal|no\s*clothes|without\s*clothes|clothes\s*off|undressed)\b/i,
  /\b(topless|bottomless|shirtless\s*woman|bare\s*breasts?|bare\s*chest)\b/i,
  /\b(see[\s-]*through|transparent\s*(dress|clothing)|nipple(?:s)?\s*(visible|showing|out))\b/i,
  /\b(genital|penis|vagina|pussy|cock|dick|labia|areola)\b/i,
  /\b(boobs|tits|asshole|anus)\b/i,
  // "make me a photo of a naked …"
  /\b(naked|nude)\s+(woman|man|girl|boy|person|people|body|bodies)\b/i,
  /\b(woman|man|girl|boy|person)\s+(who\s+is\s+)?(naked|nude)\b/i,
];

// Explicit pornographic acts — IMAGE only (goes with no-nudity intent)
const EXPLICIT_IMAGE = [
  /\b(porn|porno|pornography|xxx|hentai|rule\s*34|r34)\b/i,
  /\b(blow\s*job|hand\s*job|rim\s*job|deepthroat|cumshot|creampie|gangbang)\b/i,
  /\b(masturbat(e|ion|ing)|orgasm|ejaculat|sex\s*act|intercourse)\b/i,
  /\b(uncensored\s*(nude|naked|nsfw)|nsfw\s*(photo|picture|image|pic))\b/i,
];

// Milder sexualized image asks — strict mode only
const MILD_IMAGE = [
  /\b(sexy|erotic|sensual|seductive)\b.{0,40}\b(photo|picture|image|pic|pose|model|portrait)\b/i,
  /\b(lingerie|bikini\s*shoot|boudoir)\b/i,
  /\bmake\s+(me\s+)?(a\s+)?(sexy|hot|erotic)\b/i,
];

const MSG = {
  image: 'Blocked — image prompts with nudity or explicit bodies aren’t allowed. Describe a clothed scene, or turn the content filter off in Settings.',
  child: 'Blocked — sexual content involving minors is never allowed.',
};

export function getUserFilterMode(userId) {
  try {
    const row = db.prepare('SELECT content_filter FROM users WHERE id = ?').get(userId);
    const m = row?.content_filter;
    return FILTER_MODES.includes(m) ? m : 'off';
  } catch {
    return 'off';
  }
}

function hits(list, text) {
  return list.some((re) => re.test(text));
}

/**
 * @param {string} text
 * @param {{ mode?: string, kind?: 'chat'|'image' }} opts
 * @returns {{ ok: true } | { ok: false, reason: string, code: string }}
 */
export function checkContent(text, { mode = 'safe', kind = 'chat' } = {}) {
  const t = String(text || '').trim();
  if (!t) return { ok: true };

  // Hard floor everywhere
  if (hits(CHILD_SEXUAL, t)) {
    return { ok: false, reason: MSG.child, code: 'child' };
  }

  // Chat: no adult keyword filter — only the CSAM floor above
  if (kind === 'chat') return { ok: true };

  // Images: nudity filter when enabled
  if (!mode || mode === 'off') return { ok: true };

  if (hits(NUDITY, t) || hits(EXPLICIT_IMAGE, t)) {
    return { ok: false, reason: MSG.image, code: 'nudity' };
  }
  if (mode === 'strict' && hits(MILD_IMAGE, t)) {
    return { ok: false, reason: MSG.image, code: 'mild' };
  }
  return { ok: true };
}

/** Convenience: check a user's stored mode. */
export function checkUserContent(userId, text, kind = 'chat') {
  return checkContent(text, { mode: getUserFilterMode(userId), kind });
}
