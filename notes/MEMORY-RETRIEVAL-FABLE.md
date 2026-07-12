# Memory / retrieval — handoff for FABLE (big architecture)

Cross-conversation recall: the model remembers facts/decisions from *other*
chats and pulls them in when relevant. Routed to Fable because it needs a new
always-on service + a change to the core prompt-building path — and it **cannot
be validated on the current stack** (see blocker). Opus stopped here on purpose.

## The hard blocker (why this isn't just "add a table")
- The llama-server **router (:8081) does not do embeddings**: `/v1/embeddings`
  returns `501 "This server does not support embeddings. Start it with
  --embeddings"`. Router presets run models in chat/generation mode; `--embeddings`
  is a per-process mode that *disables* generation, so you can't just flip it on
  the shared router.
- **No embedding model on disk** (checked: no bge/nomic/gte/minilm/e5 gguf).

So semantic memory requires standing up embedding infrastructure first.

## Recommended architecture
1. **Dedicated embedding service** (don't touch the router):
   - Download a small embed gguf — `nomic-embed-text-v1.5` (768d) or
     `bge-small-en-v1.5` (384d), Q8. Put under `llm-models/embed/`.
   - New systemd user unit `duckpond-embed.service`: `llama-server --embeddings
     --pooling mean -m <embed.gguf> --host 127.0.0.1 --port 8083 -ngl 99 -c 2048`.
     It's tiny, keep it resident. Add env `EMBED_URL=http://127.0.0.1:8083`.
2. **Storage** (`server/src/db.js`): `message_vectors(message_id INTEGER PRIMARY
   KEY, user_id, conv_id, dim, vec BLOB, created_at)`. Store the embedding as a
   Float32Array BLOB. Add `users.memory_enabled INTEGER DEFAULT 0`.
3. **`server/src/memory.js`** (new): `embed(text)` (POST EMBED_URL/v1/embeddings),
   `storeMessageVector(msg)`, `retrieve(userId, queryText, {k=4, minSim=0.35,
   excludeConvId})` → brute-force cosine over the user's vectors, top-k above
   threshold. **Brute-force in JS is fine here** — 2 users, a few thousand
   messages; do NOT pull in sqlite-vss/native extensions (build pain on this
   atomic OS). Revisit sqlite-vec only if it ever gets huge.
4. **Wire into chat** (`server/src/routes/chat.js`):
   - On message save (user + assistant), fire-and-forget `storeMessageVector`.
   - In the prompt build for a new turn (when `users.memory_enabled`): embed the
     new user text, `retrieve()` excluding the current conversation (its history
     is already in-prompt), and inject a system section: `"## Relevant notes from
     earlier conversations\n<snippets, each with a date>"`. Cap total injected
     tokens (~600) and dedupe near-identical hits.
5. **Backfill**: one-time pass embedding existing messages when a user first
   enables memory (batch, rate-limited).
6. **Settings UI**: a "Memory" toggle in `SettingsPanel.svelte` (mirror the
   image-gen section pattern), persisted via the auth PATCH route.

## Gotchas
- Embed the SAME normalized text you'd retrieve on; nomic wants `search_document:`
  / `search_query:` prefixes — check the model card.
- Don't embed system/compaction/tool messages — only real user/assistant turns.
- Respect deletion: drop vectors when a message/conversation is deleted (FK or a
  hook — messages currently hard-delete subtrees in chat.js).
- Two-user GPU contention (task #9) touches this: the embed service is separate
  VRAM; make sure it fits alongside a chat model or run it CPU-only (`-ngl 0`,
  small model → fine on CPU).

## Cheaper fallback if you decide semantic isn't worth the service
SQLite **FTS5** (built in, no model, no service): full-text index over messages,
BM25 rank, inject top lexical matches. Much simpler, fully local, testable today —
lower recall quality (term overlap, not meaning). Opus can build this version on
request in one session if the user prefers lexical-now over semantic-later.
