// Context compression — the token-saving half of OmniRoute's idea, baked in.
//
// OmniRoute stacks a dozen composable "compression engines" in front of the
// model. We take the engines that are safe on a CHAT TRANSCRIPT and skip the
// ones this pond already rejected on the evidence: notes/COMPACTION.md ruled
// out caveman-style grammar stripping (telegraphic output garbles multi-turn
// dialogue and the model imitates the broken register) and LLMLingua (needs its
// own resident model, and we have one 16GB card). What survived:
//
//   1. protect      — code, URLs, JSON, paths and numbers are lifted out before
//                     ANY lossy pass and restored byte-for-byte after. Nothing
//                     below can corrupt a command, a path or a digit.
//   2. tool-output  — RTK's actual win: ANSI strips, progress-bar redraws,
//                     repeated lines, installer noise, head/tail windows. Tool
//                     output is where the tokens really go, and none of it is
//                     prose anyone needs verbatim.
//   3. session dedup— the same file/tree/output pasted turn after turn is kept
//                     once; later identical copies become a one-line pointer.
//   4. boilerplate  — assistant filler ("Certainly! Here's...", "Let me know if
//                     you'd like me to expand") removed from OLD turns only.
//                     Phrase-level, never grammar-level: this is the safe
//                     subset of caveman, not caveman.
//   5. headroom     — a hard ceiling. Whatever is still over budget after the
//                     lossless passes gets trimmed oldest-first, by relevance
//                     to the live question, before the LLM compactor is asked
//                     to do the expensive thing.
//
// Everything is on by default and needs no configuration ('auto'). Engines 1-3
// are lossless-or-near; 4 and 5 only touch messages older than the protected
// recent window, and never touch a user's own words.
// Deliberately dependency-free: this is pure text in, pure text out, so it can
// be unit-tested and reasoned about without booting SQLite or a provider. That
// costs one duplicated five-line estimator (kept identical to
// providers.estimateTokens on purpose — the two must agree or the pressure
// numbers in the UI and the numbers here would drift).

/** chars/4 prompt-token estimate. Mirrors providers.estimateTokens exactly. */
export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages ?? []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) if (typeof part?.text === 'string') chars += part.text.length;
    }
    if (Array.isArray(m.tool_calls)) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4);
}

// Never compress the live end of the conversation: the model needs the last
// few turns exactly as they happened.
export const KEEP_VERBATIM = 6;
// Start the lossy passes once the prompt crosses this fraction of the window.
export const HEADROOM_AT = 0.6;

// ---------- 1. protected spans ----------

// ONE pass with an alternation, deliberately — not a loop of separate regexes.
// A sequential loop would re-scan the sentinels it just inserted, and since the
// sentinel carries a digit index the number pattern would match inside it and
// nest, corrupting the restore. Leftmost-alternation also gives the priority we
// want for free: a fence swallows everything inside it before the narrower
// patterns ever see it.
const PROTECT_RE = new RegExp([
  '```[\\s\\S]*?```',                      // fenced code
  '~~~[\\s\\S]*?~~~',                      // alt fenced code
  '`[^`\\n]+`',                            // inline code
  'https?://[^\\s<>()"\']+',               // URLs
  '\\b[\\w.-]+/[\\w./-]+\\.\\w{1,8}\\b',   // paths like src/routes/chat.js
  '\\b[0-9a-f]{7,40}\\b',                  // hashes / hex ids
  '\\b\\d[\\d,._]*\\b',                    // any number, including versions
].join('|'), 'g');

// NUL wrapper: no model emits it, and nothing downstream can match across it.
const SENTINEL = "\u0000";
const RESTORE_RE = new RegExp(SENTINEL + "(\\d+)" + SENTINEL, "g");

/** Lift protected spans out of `text`, returning [masked, spans]. */
export function protectSpans(text) {
  const spans = [];
  const out = String(text ?? '').replace(PROTECT_RE, (m) => {
    spans.push(m);
    return `${SENTINEL}${spans.length - 1}${SENTINEL}`;
  });
  return [out, spans];
}

/** Put the protected spans back, byte for byte. */
export function restoreSpans(text, spans) {
  return String(text ?? '').replace(RESTORE_RE, (m, i) => spans[Number(i)] ?? m);
}

// ---------- 2. tool output (the RTK engine) ----------

const ANSI_RE = /\[[0-9;?]*[A-Za-z]/g;
const SPINNER_RE = /[⠁-⣿⣾⣽⣻⢿⡿⣟⣯⣷|/\\-]\s*$/;
// Lines that are pure machine noise: progress bars, download tickers, the
// hundreds of "Collecting x" / "added 1 package" lines an install emits.
const NOISE_LINE_RES = [
  /^\s*[█░▒▓■-◿=#.\->\s]{8,}\s*\d*%?\s*$/,   // bar-only lines
  /^\s*\d{1,3}%\s*[|▕▏│].*$/,                              // "42% ▕███"
  /^\s*(Collecting|Downloading|Using cached|Requirement already satisfied|Installing collected packages|Successfully installed|Preparing metadata|Building wheel|Created wheel|Stored in directory)\b.*$/,
  /^\s*npm (WARN|notice|info)\b.*$/,
  /^\s*(added|removed|changed|audited) \d+ packages?\b.*$/,
  /^\s*[0-9a-f]{12}: (Already exists|Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete)\b.*$/,
  /^\s*(warning|note): .*is deprecated.*$/i,
  /^\s*\[\s*\d+\/\d+\s*\][^\n]{0,40}$/,                                   // "[ 12/340 ]"
];

/**
 * Compress one tool/command result.
 * Near-lossless: every removed line is either a redraw of a line we keep, an
 * exact duplicate, or pure progress noise. Signal (errors, paths, output) is
 * untouched, and the head/tail window keeps both the command's start and its
 * verdict — which is where the answer almost always is.
 */
export function compressToolOutput(text, { maxChars = 4000 } = {}) {
  const raw = String(text ?? '');
  if (!raw) return { text: raw, saved: 0 };

  let s = raw.replace(ANSI_RE, '');
  // Carriage-return redraws: only the final state of each line survives.
  s = s.split('\n').map((ln) => (ln.includes('\r') ? ln.slice(ln.lastIndexOf('\r') + 1) : ln)).join('\n');

  const kept = [];
  let dropped = 0;
  let runLine = null;
  let runCount = 0;
  const flushRun = () => {
    if (runLine === null) return;
    kept.push(runCount > 1 ? `${runLine}   … ×${runCount}` : runLine);
    if (runCount > 1) dropped += runCount - 1;
    runLine = null;
    runCount = 0;
  };

  for (const line of s.split('\n')) {
    const trimmed = line.trimEnd();
    if (NOISE_LINE_RES.some((re) => re.test(trimmed)) || (trimmed && SPINNER_RE.test(trimmed) && trimmed.length < 4)) {
      dropped += 1;
      continue;
    }
    if (trimmed === runLine) { runCount += 1; continue; }
    flushRun();
    runLine = trimmed;
    runCount = 1;
  }
  flushRun();

  // Collapse 3+ blank lines to one blank line.
  let out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // Still huge → head + tail window. Errors cluster at the end, context at the
  // start; the middle of a 50k-line log has never answered a question.
  if (out.length > maxChars) {
    const head = out.slice(0, Math.floor(maxChars * 0.4));
    const tail = out.slice(-Math.floor(maxChars * 0.6));
    const cutChars = out.length - head.length - tail.length;
    out = `${head}\n\n… [${cutChars.toLocaleString()} characters of middle output trimmed] …\n\n${tail}`;
  }
  return { text: out, saved: Math.max(0, raw.length - out.length), droppedLines: dropped };
}

// ---------- 3. session dedup ----------

const dedupKey = (s) => {
  // Whitespace-insensitive identity: a re-listed tree that only changed
  // indentation is still the same tree.
  let h = 5381;
  const t = String(s).replace(/\s+/g, ' ').trim();
  for (let i = 0; i < t.length; i += 1) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return `${h}:${t.length}`;
};

/**
 * Replace re-sent identical blocks with a pointer to the first copy.
 * The classic case: a 600-line file read, or `list_files`, repeated at every
 * step of an agent run. The model already has it; the second copy buys nothing.
 */
export function dedupeSession(messages, { minChars = 240, keepLast = KEEP_VERBATIM } = {}) {
  const cut = Math.max(0, messages.length - keepLast);
  const seen = new Map();
  let saved = 0;
  let hits = 0;

  const out = messages.map((m, i) => {
    if (i >= cut || typeof m.content !== 'string' || m.content.length < minChars) return m;
    if (m.role === 'system') return m;
    const key = dedupKey(m.content);
    const first = seen.get(key);
    if (first === undefined) { seen.set(key, i); return m; }
    // Only a tool result or a re-pasted block is safe to stub — never a user's
    // own message, even a repeated one (repetition there is usually the point).
    if (m.role === 'user') return m;
    const lines = m.content.split('\n').length;
    const stub = `[identical to the ${lines}-line block already shown above — unchanged]`;
    saved += m.content.length - stub.length;
    hits += 1;
    return { ...m, content: stub };
  });
  return { messages: out, saved: Math.max(0, saved), hits };
}

// ---------- 4. boilerplate (the safe subset of caveman) ----------

// Phrase-level only. No article stripping, no connective removal — that is the
// thing that garbles dialogue, and the register survives phrase deletion.
const FILLER_RES = [
  [/^(certainly|sure|of course|absolutely|great question|excellent question)[!,.]?\s*/gim, ''],
  [/\b(I hope this helps|Let me know if you (would like|want|need)[^.!?]*|Feel free to ask[^.!?]*|Would you like me to[^.?]*\?|Do you want me to[^.?]*\?)[.!?]?\s*/gi, ''],
  [/\b(it('s| is) (important|worth) (to note|noting) that|please note that|as you can see|as we can see|it should be noted that)\s*/gi, ''],
  [/\bin order to\b/gi, 'to'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bfor the purpose of\b/gi, 'for'],
  [/\ba (large )?number of\b/gi, 'many'],
  [/\bin the event that\b/gi, 'if'],
  [/\bis able to\b/gi, 'can'],
  [/\bhas the ability to\b/gi, 'can'],
  [/\b(basically|essentially|actually|simply|just|really|very|quite|rather) \b/gi, ''],
  [/^#{1,6}\s*(summary|conclusion|recap)\s*$/gim, ''],
];

/**
 * Strip assistant boilerplate from an OLD turn. Protected spans are lifted out
 * first, so no code, path, URL or number can be touched.
 */
export function compressProse(text) {
  const raw = String(text ?? '');
  if (raw.length < 200) return { text: raw, saved: 0 };
  const [masked, spans] = protectSpans(raw);
  let s = masked;
  for (const [re, rep] of FILLER_RES) s = s.replace(re, rep);
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  // Deleting a clause head ("Certainly! It is important to note that in order
  // to run…") leaves the next word lowercase mid-nowhere. Re-capitalise sentence
  // starts so the register still reads as prose rather than as damage.
  s = s.replace(/(^|[.!?]\s+|\n)([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
  const out = restoreSpans(s, spans);
  // A rule that fired badly and ate the message is a bug, not a saving. This
  // only catches catastrophe: filler-dense prose legitimately halves, and
  // refusing that would throw away the engine's best case.
  if (out.length < raw.length * 0.3) return { text: raw, saved: 0 };
  return { text: out, saved: Math.max(0, raw.length - out.length) };
}

// ---------- 5. headroom ----------

const STOP = new Set(('the a an and or but if then of to in on for with is are was were be been it this that i you we they what how why when '
  + 'do does did can could should would will not no yes at as by from about into over after').split(' '));

const terms = (s) => new Set(String(s ?? '').toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g)?.filter((w) => !STOP.has(w)) ?? []);

/**
 * Last resort before the LLM compactor: drop the least relevant old messages
 * until the prompt fits. Relevance = term overlap with the live question, aged
 * by position — an old message about the thing being asked about right now
 * outranks a newer one about something else.
 */
export function trimToHeadroom(messages, budgetTokens, { keepLast = KEEP_VERBATIM } = {}) {
  if (estimateTokens(messages) <= budgetTokens) return { messages, saved: 0, dropped: 0 };
  const cut = Math.max(0, messages.length - keepLast);
  const q = terms(messages[messages.length - 1]?.content);

  const scored = [];
  for (let i = 0; i < cut; i += 1) {
    const m = messages[i];
    if (m.role === 'system') continue;                       // system is never dropped
    const t = terms(typeof m.content === 'string' ? m.content : '');
    let overlap = 0;
    for (const w of t) if (q.has(w)) overlap += 1;
    const relevance = overlap / Math.max(4, q.size);
    scored.push({ i, score: relevance + (i / Math.max(1, cut)) * 0.5 });
  }
  scored.sort((a, b) => a.score - b.score);                  // least useful first

  const drop = new Set();
  let used = estimateTokens(messages);
  let saved = 0;
  for (const { i } of scored) {
    if (used <= budgetTokens) break;
    const len = String(messages[i].content ?? '').length;
    if (len < 80) continue;                                  // not worth a hole in the thread
    drop.add(i);
    used -= Math.ceil(len / 4);
    saved += len;
  }
  if (!drop.size) return { messages, saved: 0, dropped: 0 };

  const out = messages.filter((m, i) => !drop.has(i));
  // Leave a visible seam — a silent hole makes the model hallucinate continuity.
  // It goes into the LEADING system message, never as a mid-thread system turn:
  // buildPrompt hoists all system content into one message precisely because
  // qwen-style chat templates reject a system role in the middle of a thread.
  const seam = `[${drop.size} older message(s) unrelated to the current question were dropped to fit the context window. Say so and ask the user if you need something from earlier in the conversation.]`;
  if (out[0]?.role === 'system' && typeof out[0].content === 'string') {
    out[0] = { ...out[0], content: `${out[0].content}\n\n${seam}` };
  } else {
    out.unshift({ role: 'system', content: seam });
  }
  return { messages: out, saved, dropped: drop.size };
}

// ---------- orchestrator ----------

/**
 * Run the engine stack over a prompt.
 *
 * `level`:
 *   'off'        — nothing (escape hatch)
 *   'auto'       — DEFAULT. Lossless engines always; lossy ones only once the
 *                  prompt crosses HEADROOM_AT of the window.
 *   'aggressive' — lossy engines from the first token.
 *
 * Returns the rewritten messages plus a report the UI can show, so the saving
 * is never silent.
 */
export function saveContext(messages, { ctxSize = 32_768, level = 'auto', keepLast = KEEP_VERBATIM } = {}) {
  const before = estimateTokens(messages);
  const report = { before, after: before, engines: {}, level };
  if (level === 'off' || !Array.isArray(messages) || messages.length < 2) {
    return { messages, report, saved: 0 };
  }

  let msgs = messages;
  const cut = Math.max(0, msgs.length - keepLast);
  let charsSaved = 0;

  // --- always on: tool output ---
  let toolSaved = 0;
  msgs = msgs.map((m, i) => {
    if (m.role !== 'tool' || typeof m.content !== 'string') return m;
    // Recent tool results get a generous window, old ones a tight one.
    const r = compressToolOutput(m.content, { maxChars: i >= cut ? 6000 : 2000 });
    if (!r.saved) return m;
    toolSaved += r.saved;
    return { ...m, content: r.text };
  });
  if (toolSaved) report.engines.tool_output = toolSaved;
  charsSaved += toolSaved;

  // --- always on: session dedup ---
  const dd = dedupeSession(msgs, { keepLast });
  msgs = dd.messages;
  if (dd.saved) report.engines.dedup = dd.saved;
  charsSaved += dd.saved;

  // --- pressure-gated: prose boilerplate ---
  const budget = Number(ctxSize) > 0 ? Number(ctxSize) : 128_000;
  const pressured = level === 'aggressive' || estimateTokens(msgs) > budget * HEADROOM_AT;
  if (pressured) {
    let proseSaved = 0;
    msgs = msgs.map((m, i) => {
      if (i >= cut || m.role !== 'assistant' || typeof m.content !== 'string') return m;
      const r = compressProse(m.content);
      if (!r.saved) return m;
      proseSaved += r.saved;
      return { ...m, content: r.text };
    });
    if (proseSaved) report.engines.boilerplate = proseSaved;
    charsSaved += proseSaved;

    // --- last resort: headroom trim ---
    const th = trimToHeadroom(msgs, Math.floor(budget * 0.75), { keepLast });
    msgs = th.messages;
    if (th.saved) { report.engines.headroom = th.saved; report.dropped = th.dropped; }
    charsSaved += th.saved;
  }

  report.after = estimateTokens(msgs);
  report.savedTokens = Math.max(0, report.before - report.after);
  report.pct = report.before > 0 ? Math.round((report.savedTokens / report.before) * 100) : 0;
  return { messages: msgs, report, saved: charsSaved };
}

/** One-line human summary for the toast / ledger, or null if nothing fired. */
export function saverSummary(report) {
  if (!report?.savedTokens || report.savedTokens < 200) return null;
  const names = { tool_output: 'tool output', dedup: 'repeats', boilerplate: 'filler', headroom: 'off-topic history' };
  const parts = Object.keys(report.engines ?? {}).map((k) => names[k] ?? k);
  return `Context saver: −${report.savedTokens.toLocaleString()} tokens (${report.pct}%)${parts.length ? ` · ${parts.join(', ')}` : ''}`;
}
