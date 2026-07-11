# disler/claude-code-hooks-multi-agent-observability — **C−**

**Panel:** B+ (v1) / 2.7 (v2) · **Independent:** **C−** ▼▼ · **Role: teaching
example only.**

The most-starred candidate (**1,475★ / 385 forks**, vs the report's "~1,400 / 372"),
and the biggest gap between reputation and substance. **Stalled 2026-02-08.**

## The subagent data is a dead path

- The hook **sends** `agent_id` / `agent_type`, but the **server drops them**
  (`db.ts:127`) — they survive only inside an opaque JSON blob, not as columns.
- Schema is a **single `events` table**: **no parent column**, and **no graph library
  anywhere** (grep finds no d3 / cytoscape / dagre / reactflow).
- "Trace every task handoff across the swarm" is, in reality, flat swim-lanes keyed on
  an application label. **No hierarchy is reconstructable** from what it stores.

## Quality & legal blockers

- **Zero tests.**
- **No license** — `private:true`, no `license` field → all-rights-reserved. A hard
  OPCⁿ blocker.
- Effectively **one real runtime dependency** (Vue) plus two dead deps.
- Stalled since 8 Feb 2026.

## Security — unfit for exposure

- Unauthenticated `POST /events`; **CORS `*`**.
- **SSRF**: the server dials an arbitrary `responseWebSocketUrl` taken from the request
  payload (`index.ts:198-201`).
- The `.env` / key guard the report credited is **commented out**
  (`pre_tool_use.py:324-327`).

## The one thing it's good for

- `send_event.py` (~180 lines) is the **clearest teaching example** of the whole
  ingest pattern: hook → HTTP → SQLite → WebSocket → browser. Read it to learn the
  loop; do not build on it.

## Verdict

Popular, but hollow: no hierarchy, no tests, no license, stalled, and insecure. Learn
the pattern from its hook script and move on. **C−.**
