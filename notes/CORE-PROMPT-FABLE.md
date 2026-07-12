# Core system prompt rewrite — handoff for FABLE

The user wants the core prompt to be **insanely good** — deeply detailed about
how the model should behave, and actively making the (small, local) models
*better*: sharper reasoning, better judgment, better answers. This is a
prompt-engineering craft task, routed to Fable on purpose.

## Where it lives / how it's used
- `server/src/settings.js` → `DEFAULT_CORE_PROMPT` (the current one) and
  `corePrompt()`. It's owner-editable (stored in `app_settings.core_prompt`,
  task #15) and **prepended to EVERY chat's system message, for every user and
  every model** (see `buildPrompt` in routes/chat.js — it's `sysParts[0]`).
- So it must be model-agnostic and always-on. It sits ABOVE per-model system
  prompts and the tool policies (project/image/search) that chat.js appends.

## Hard constraints (don't break these)
- **Small local models** (Gemma/Qwen/Nemotron 2B–35B, quantized). They follow
  short, concrete, imperative rules far better than long prose or abstract
  principles. Every added sentence competes for limited attention and context —
  earn each one. "Insanely good" here means *dense and well-ordered*, not long.
- It's **general** — fronts coding, chat, image/search/project tool use,
  diffusion turns. Don't over-fit to coding.
- Keep it Markdown with clear headers (the current one uses `## Honesty`, `## How
  to talk`, etc.) — models anchor on that structure.
- Budget: aim to stay roughly within the current size (~40 lines). If you go
  bigger, justify each section by the behavior change it buys.

## What "make the model better" should target (design the prompt around these)
- **Reasoning discipline**: think before answering hard questions; check its own
  work; catch and correct its own mistakes mid-answer; distinguish what it knows
  from what it's guessing.
- **Calibrated honesty**: say "I don't know / I'm not sure" instead of
  confabulating; never invent APIs/facts/numbers; surface uncertainty.
- **Judgment on effort**: match depth to the question; ask ONE clarifying
  question when genuinely ambiguous rather than guessing long.
- **Anti-sycophancy**: no flattery, no filler, no restating the prompt; disagree
  when the user is wrong and show why.
- **Persona**: this app's assistant is "Duck" — warm, direct, a little
  personality, never saccharine. The user likes character (see the duck mascot)
  but not at the cost of substance. Decide how much persona belongs in the CORE
  prompt vs. left to per-model prompts.
- **Tool-awareness (light touch)**: the concrete tool instructions are appended
  per-turn by chat.js (project/image/search policies), so the core prompt
  shouldn't duplicate them — but a line about using available tools/verifying
  rather than guessing helps.
- **Formatting**: Markdown, fenced code with language tags, lists/tables only
  when they help.

## Suggested process
1. Read the current `DEFAULT_CORE_PROMPT` — it's a solid, terse baseline; keep
   what works, sharpen the rest.
2. Consider testing variants against a couple of the small resident models
   (gemma-4-12b, qwen3-6-27b) on a fixed set of prompts (a hard reasoning Q, an
   ambiguous request, a "user is wrong" case, a coding ask) and compare — the
   whole point is measurable behavior improvement, not vibes.
3. Ship by updating `DEFAULT_CORE_PROMPT` (and/or set `app_settings.core_prompt`
   for the live instance). The Settings UI already lets the owner edit it, so the
   user can tweak after.

## Note
Techniques that help big models (elaborate multi-step meta-reasoning scaffolds)
can *hurt* small ones (they'll over-narrate or get lost). Calibrate to this
model class specifically. That calibration is the hard part — why it's Fable's.
