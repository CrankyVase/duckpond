// Child safety floor for prompts. Adult content and graphic violence are not
// keyword-filtered.

// Nude or sexual depictions involving minors are always blocked.
const CHILD_SEXUAL = [
  /\b(child\s*porn|cp\b|csam|csem|underage\s*sex|minor\s*nude|pedo|paedo|preteen\s*sex)\b/i,
  /\b(loli|shota|shotacon|lolicon)\b/i,
  /\b((?:10|11|12|13|14|15|16|17)\s*year\s*old).{0,40}(nude|naked|sex|porn|erotic)/i,
  /\b(nude|naked|sex|porn|erotic).{0,40}((?:10|11|12|13|14|15|16|17)\s*year\s*old)/i,
];

// Treat ambiguous age language conservatively when the same request asks for
// nudity or sexual content. Text screening cannot determine a subject's age.
const MINOR_CUES = [
  /\b(child(?:ren)?|kid(?:s)?|minor(?:s)?|underage|preteen|tween|teen(?:age|ager|agers)?|adolescent|pubescent|schoolgirl|schoolboy|girl|boy|baby|infant|toddler|juvenile|youth)\b/i,
  /\b(?:[0-9]|1[0-7])\s*(?:-|\s)*year(?:s)?(?:-|\s)*old\b/i,
  /\b(?:[0-9]|1[0-7])\s*(?:yo|yrs?\s*old)\b/i,
];
const MINOR_SEXUAL = /\b(sex(?:ual(?:ly|ized|ization)?)?|sexy|suggestive|provocative|erotic|pornographic|porn|intercourse|sensual|seductive|fetish)\b/i;

// Nudity terms used only to identify requests involving minors.
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

// Sexual act terms used only to identify requests involving minors.
const EXPLICIT_IMAGE = [
  /\b(porn|porno|pornography|xxx|hentai|rule\s*34|r34)\b/i,
  /\b(blow\s*job|hand\s*job|rim\s*job|deepthroat|cumshot|creampie|gangbang)\b/i,
  /\b(masturbat(e|ion|ing)|orgasm|ejaculat|sex\s*act|intercourse)\b/i,
  /\b(uncensored\s*(nude|naked|nsfw)|nsfw\s*(photo|picture|image|pic))\b/i,
];

// Sexualized terms used only to identify requests involving minors.
const MILD_IMAGE = [
  /\b(sexy|erotic|sensual|seductive)\b.{0,40}\b(photo|picture|image|pic|pose|model|portrait)\b/i,
  /\b(sexual(?:ly|ized)?|sex)\s+(?:scene|content|activity|photo|image|act)\b/i,
  /\b(?:scene|content|activity|photo|image)\s+(?:of\s+)?(?:sexual|sex)\b/i,
  /\b(lingerie|bikini\s*shoot|boudoir)\b/i,
  /\bmake\s+(me\s+)?(a\s+)?(sexy|hot|erotic)\b/i,
];

const MSG = { child: 'Blocked — nude or sexual depictions involving minors are never allowed.' };

function hits(list, text) {
  return list.some((re) => re.test(text));
}

/**
 * @param {string} text
 * @returns {{ ok: true } | { ok: false, reason: string, code: string }}
 */
export function checkContent(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: true };

  // Hard floor everywhere
  if (hits(CHILD_SEXUAL, t) || (hits(MINOR_CUES, t) && (hits(NUDITY, t) || hits(EXPLICIT_IMAGE, t) || hits(MILD_IMAGE, t) || MINOR_SEXUAL.test(t)))) {
    return { ok: false, reason: MSG.child, code: 'child' };
  }

  return { ok: true };
}

/** Keep the call shape used by chat and image routes. */
export function checkUserContent(userId, text, kind = 'chat') {
  return checkContent(text);
}
