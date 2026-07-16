# Core system prompt — frontier analysis + DuckPond ship

Sources reviewed (2026-07, [asgeirtj/system_prompts_leaks](https://github.com/asgeirtj/system_prompts_leaks)):
Claude Opus 4.8 / Sonnet 5 · ChatGPT GPT-5.6 · Grok Expert / 4.2 / 4.3 · Kimi K2.6

Company product pitches, ad policies, multi-agent theatre, and partisan framing were discarded. Only behavior patterns that make answers better were kept, then compressed for **small local models**.

---

## 1. Tools the frontier models have — do we need them?

| Tool class | Who has it | DuckPond today | Worth it? |
|---|---|---|---|
| **Web search + page fetch** | All four | `web_search`, `fetch_page` | **Yes — already core.** Biggest accuracy lift for anything post-cutoff. |
| **Code execution / sandbox** | ChatGPT python, Grok code_execution, Kimi ipython | Project sandbox: `run_command` + file tools | **Yes.** Verification beats "should work". |
| **File read/write** | Claude computer, Grok, Codex | `list/read/write_file`, `start_project` | **Yes.** Multi-file work without context stuffing. |
| **Image generation** | ChatGPT, Grok | `generate_image` | **Yes.** Local diffusion already wired. |
| **Rich UI / widgets** | ChatGPT genui, Kimi show_widget, Grok render | 20+ `show_*` widgets + slides/csv | **Yes — DuckPond strength.** Proactive cards beat walls of numbers. |
| **Memory CRUD** | Claude memory, Kimi memory_instruction, ChatGPT bio | `save/update/forget_memory` + auto-extract | **Yes.** Stops "I'm stateless" lies. |
| **Deep research loop** | ChatGPT web rigor, Claude search_first | Quick / Normal / Ultra research modes | **Yes.** Policy already in chat.js. |
| **Document export** | ChatGPT skills (pdf/docx/xlsx/pptx) | `generate_slides`, `export_csv` | Partial. Word/PDF skills later if needed. |
| **Automations / cron** | ChatGPT automations, Kimi cron | — | Nice-to-have later (reminders, recurring briefs). |
| **Past-chat search** | Claude conversation_search | Semantic memory + message vectors | Covered differently; full chat-search optional. |
| **Connectors (Gmail, calendar)** | ChatGPT / Claude MCP | MCP planned | Build when users need it. |
| **X/Twitter suite** | Grok-only | — | **No** unless you care about social firehose. |
| **Multi-agent team chat** | Grok Expert (Harper/Benjamin/Lucas) | — | **No.** Token theatre on small models; hurts more than helps. |
| **Ads / product cross-sell** | ChatGPT | — | **Never.** |
| **Company identity / brand politics** | All of them | — | **Never in core prompt.** |

### Advantages that matter for DuckPond

1. **Grounding** — search/fetch turns confident hallucinations into checkable claims with citations.
2. **Verification** — shell + files let the model prove code works instead of asserting it.
3. **Bandwidth** — widgets and images move structure/visuals out of prose (huge UX win).
4. **Continuity** — memory tools make multi-session use feel human without creepy narration.
5. **Agency** — project mode turns chat into a build loop (plan → write → run → fix).

What *doesn't* transfer well to Gemma/Qwen-class models: giant multi-step meta-scaffolds, partner-connector sales funnels, multi-agent debates, 10k-token policy essays.

---

## 2. How these patterns enhance the model

| Pattern (source) | What it buys |
|---|---|
| Search before present-day facts (Claude / ChatGPT) | Cuts stale CEOs, prices, versions |
| Lead with answer; match length (Claude) | Feels sharp; less ramble on small models |
| Truth > comfort; anti-sycophancy (Grok / Claude) | User can trust disagreement |
| Evenhanded contested topics, no party line (Grok stripped of brand) | Feels fair, not captive |
| Show-don't-tell / ban filler phrases (ChatGPT) | Kills "Happy to help!" sludge |
| Tool-over-guess + never invent capabilities (all) | Honesty about the live toolset |
| Self-correct mid-thread (Grok / Claude) | Models recover instead of doubling down |
| One clarifying question (Claude / Kimi) | Unblocks ambiguity without interrogation |
| Memory without "I can see in my profile…" (Claude) | Personalization that doesn't feel surveilly |
| Practical constraint first (Kimi) | Answers the real bottleneck, not the abstract |

---

## 3. Biases deliberately removed

- Anthropic product catalog, ads-free marketing, Claude Code upsells
- OpenAI ads handling, plan tiers, "you are GPT-5.6"
- xAI / Elon-adjacent political framing and multi-agent "team leader" cosplay
- Moonshot / Kimi product skills and Chinese-product defaults (kept universal craft only)
- Partisan "own the libs" *or* heavy progressive moralizing — neither belongs in a general assistant

Kept universal floors only: no sexual content involving minors; no actionable weapons/malware help. Matches DuckPond `contentFilter.js` (chat otherwise unrestricted).

---

## 4. Where the core prompt lives

- Default: `server/src/settings.js` → `DEFAULT_CORE_PROMPT`
- Live override: `app_settings.core_prompt` (owner Settings UI)
- Injected first in every chat via `corePrompt()` + `buildPrompt` / diffusion path
- **Per-turn tool policies** still append after (project / search / image / widgets / location / memory / ultra) — core must not duplicate those walls of text

---

## 5. Eval ideas (optional)

Against gemma-4-12b + qwen3-6-27b (or whatever is resident):

1. Hard reasoning (multi-step math / logic) — did it self-check?
2. "User is wrong" factual claim — does it push back with reasons?
3. Ambiguous build request — one clarifying Q vs wild guess?
4. "Latest X in 2026" — does it search instead of invent?
5. Coding fix — root cause + complete code, no placeholders?
6. "Remember my dog is named…" — save_memory without claiming amnesia?

---

## Shipped

`DEFAULT_CORE_PROMPT` rewritten 2026-07-15. Owner can still override in Settings; clear override to return to this default.
