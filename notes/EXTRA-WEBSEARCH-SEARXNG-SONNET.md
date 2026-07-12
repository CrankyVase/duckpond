# Web search — handoff for SONNET (deploy + verify + close safety gap)

The code is DONE (`server/src/websearch.js`, `WEB_SEARCH_TOOL`/`FETCH_PAGE_TOOL`
wired into chat.js + agent.js). It just doesn't work because **SearxNG isn't
running** and there's one unfinished chat branch. Grind/infra, ~1 session.

## 1. Deploy SearxNG (podman, this box uses podman not docker)
- `websearch.js` calls `${SEARXNG_URL || http://127.0.0.1:8888}/search?...&format=json`.
- Run the container as a systemd user service (match the existing unit style in
  `/home/cranky/.config/systemd/user/`):
  ```
  podman run -d --name searxng -p 127.0.0.1:8888:8080 \
    -v ~/searxng:/etc/searxng:Z docker.io/searxng/searxng:latest
  ```
- **Must enable JSON output** — edit `~/searxng/settings.yml`:
  `search.formats: [html, json]`, and set a random `server.secret_key`.
- Verify: `curl 'http://127.0.0.1:8888/search?q=ducks&format=json'` returns JSON
  with `results[]`. Then confirm `web_search`/`fetch_page` work live in a chat.

## 2. Close the safety gap (real bug)
In `routes/chat.js`, a `web_search`/`fetch_page` tool call from a conversation
**without a workspace** currently falls into the agent gate branch (the
`else if (toolsOn && res.toolCalls?.length)` path picks `start_project` or
`res.toolCalls[0]` as the "gate call") — so a plain search can wrongly spin up a
project sandbox. Add a dedicated **inline tool branch** for search, modeled on
the in-chat image branch right above it (the `every(t => name==='generate_image')`
block): run `searchWeb`/`fetchPage`, feed results back as tool messages, let the
model answer with citations — no run, no workspace. Handle the mixed case (search
+ real project tools) sensibly: only short-circuit when ALL calls are search/fetch.

## 3. Hook up the composer button (optional polish)
The Globe button in `Chat.svelte` currently just toasts "coming soon". Once
search works, either remove the placeholder or wire it to a per-conversation
"prefer web search" hint. Low priority.
