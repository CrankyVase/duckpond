# MCP support — handoff for SONNET

Let the model use external tools via MCP servers the user configures. The chat
already has a tool-calling loop (`agentLoop` in routes/agent.js, and the inline
image branch in routes/chat.js), so this is mostly: connect to MCP servers, turn
their tools into function defs, and route calls back. Opus is doing the general
inline tool-calling loop separately (task #37) — coordinate: MCP tools should
plug INTO that loop, not build a parallel one.

## Transport: stdio (start here)
MCP servers are subprocesses speaking JSON-RPC 2.0 over stdin/stdout. Minimum
protocol:
1. send `initialize` (protocolVersion, capabilities, clientInfo) → read result
2. send `notifications/initialized`
3. `tools/list` → `{ tools: [{ name, description, inputSchema }] }`
4. `tools/call` `{ name, arguments }` → `{ content: [{type:'text', text}], isError? }`

**Don't hand-roll if you can install** `@modelcontextprotocol/sdk` (Client +
StdioClientTransport) — it handles framing/reconnect. Check network/npm works on
this box first; if not, a minimal newline-delimited JSON-RPC client over
`child_process.spawn` is ~80 lines (id→pending-promise map, initialize, list,
call). SSE/HTTP transport can come later.

## Config
- Store server defs in `app_settings` key `mcp_servers` (JSON), owner-editable —
  mirror the core-prompt pattern in `server/src/settings.js`
  (`getSetting`/`setSetting`). Shape:
  `[{ name, command, args: [], env: {}, enabled }]`.
- Add an owner-only settings route (see how core_prompt is saved) + a textarea
  or small list UI in `SettingsPanel.svelte`. Keep it simple: a JSON editor is
  fine for v1.

## Server module `server/src/mcp.js`
- On boot + on config change: spawn each enabled server, initialize, cache its
  `tools/list`. Expose:
  - `mcpToolDefs()` → OpenAI-format function defs, **namespaced** so they never
    collide with built-ins: name = `mcp__<server>__<tool>`, params =
    the tool's inputSchema.
  - `callMcpTool(fullName, args)` → split off `mcp__<server>__`, route to that
    server's `tools/call`, return the text content (or an ERROR: string).
  - `isMcpTool(name)` → `name.startsWith('mcp__')`.
- Handle a server crashing (respawn or mark unavailable; don't take down chat).

## Wiring into chat
- Add `mcpToolDefs()` to the tool list offered in the plain-chat path
  (`routes/chat.js`, the `baseTools` array) and to `AGENT_TOOLS` usage.
- In the tool dispatch (Opus's inline loop + `execTool` in agent.js): if
  `isMcpTool(name)`, call `callMcpTool` instead of the built-in switch.
- Cap tool count / description length — small local models get confused by huge
  tool lists. Consider only exposing MCP tools when the user enables it per
  conversation or globally.

## Test
Use a stdio server that needs no network once installed, e.g. the filesystem
server pointed at a temp dir, or write a 30-line mock MCP server (responds to
initialize/tools.list/tools.call) to validate the client offline.
