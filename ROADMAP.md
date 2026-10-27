# Roadmap and notes

Ideas that are planned but not built yet, with what is known about them.

## Tell connected Claude sessions when their tools change

**Goal:** when permissions change (Permissions page, a connection's level in the Security tab, exposed/local mode, a connection's access time running out), Claude sessions that are already connected should pick up the new tool list without reconnecting. Today a session keeps the list it fetched until it asks again.

**What happens today**

- `tools/list` is filtered per connection (`lib/tools.js` `list(access)`), and `tools/call` re-checks permission on every call. So a tool that was switched off is already refused at once ("not allowed for this connection"); the only gap is that a session does not *see* newly allowed tools, and keeps seeing removed ones, until it re-lists.
- HomeClaude advertises `capabilities.tools.listChanged: false` (`lib/mcp.js`).
- Every list result carries `ttlMs: 30000` and `cacheScope: "private"`. Clients on the 2026-07-28 protocol re-fetch the list once that expires, so they already catch up within about 30 seconds.

**Why it is not a one-line change**

HomeClaude answers each request with plain JSON: no `Mcp-Session-Id`, no event stream, and no `GET /mcp` stream. A `notifications/tools/list_changed` message is sent *from* the server, so it needs an open channel to the client:

- **Protocol 2024-11-05 to 2025-11-25 (handshake clients):** the server would hand out a session id at `initialize`, accept `GET /mcp` with `Accept: text/event-stream` to keep a stream open per session, and write the notification there. Sessions need an idle timeout, a cap per connection, and clean-up when a connection is revoked or its access time ends (close its streams at once).
- **Protocol 2026-07-28 (stateless clients):** sessions and the `GET` stream were removed. Server-to-client messages only travel on the response stream of a request the client made. Here `ttlMs` is the intended mechanism; a shorter `ttlMs` for tools (for example 10 s) is the practical lever.

**Plan**

1. Keep `ttlMs`, and consider lowering it for `tools/list` only.
2. Add optional sessions for handshake clients: issue `Mcp-Session-Id`, support `GET /mcp` (SSE) and `DELETE /mcp`, then set `listChanged: true` in the `initialize` result (and only there).
3. One place that fires on every permission change (`setAccess`, `setSecurity`, `oauth.setScope`, `oauth.setSpan`, revocation, expiry) and sends `notifications/tools/list_changed` to the open streams the change affects (all of them for global changes, only that connection's for per-connection ones).
4. Revoking a connection or ending its access time also closes its streams.
5. Both ports: the private port (Claude Code on your network) and the public port, with the public port's limits (streams per connection, idle timeout behind the reverse proxy; Cloudflare closes idle streams after about 100 s, so send a comment line as keep-alive).
6. Tests: change a permission with a session open and check the notification arrives; check the stateless path still works and that a revoked connection's stream closes.

**Verify against real clients before relying on it:** which Claude apps open the `GET` stream at all, and whether they re-list on the notification.
