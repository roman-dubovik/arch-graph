## arch-graph (static architecture facts)

This project uses **arch-graph** — a static extractor that turns the NestJS monorepo into a typed graph at `arch-graph-out/graph.json` (+ `diagnostics.json`, `validation.json`, `graph.mermaid`).

### Before answering any architecture question — check the graph first

The graph is the source of truth for these questions; do not grep or guess:

- "Who publishes / subscribes to NATS subject `X`?"
- "What services depend on TypeORM entity `Y` / queue `Z`?"
- "Which module imports / provides / exports `SomeProvider`?"
- "How does service `A` reach service `B`? (NATS, HTTP, BullMQ, DI)"
- "What changes if I rename / move `libs/foo`?" (ts-import edges)

If `arch-graph mcp` is available on PATH and the editor has an MCP client, prefer the MCP tools (`subject-publishers`, `subject-subscribers`, `service-dependencies`, `paths-between`, `unresolved-sites`). Otherwise read `arch-graph-out/graph.json` directly — it's a single JSON file, ~5–50k edges depending on monorepo size.

### Freshness

The graph is **static**. Treat it as stale if any of these is true:
- `arch-graph-out/graph.json` is older than the newest `.ts` file
- `arch-graph-out/` does not exist
- You just edited a NATS / TypeORM / BullMQ / HTTP call-site

To refresh: `arch-graph build` (or `arch-graph build --quiet` in a hook).

Even better: `arch-graph hook install` once — the post-commit hook rebuilds automatically when a commit touches `.ts` files.

### What's in the graph

| Domain | Edges | Resolution gate |
|---|---|---|
| NATS | `nats-publish`, `nats-subscribe` | recall ≥ 95% vs grep-based ground truth |
| TypeORM | `typeorm-inject` (service → entity) | recall ≥ 95%, resolve ≥ 95% |
| BullMQ | `bullmq-produce`, `bullmq-consume`, `bullmq-register` | recall ≥ 95% per role |
| NestJS DI | `module-import`, `module-provide`, `module-export`, `module-controller` | recall ≥ 95% per field |
| HTTP | `http-call` (internal) or `http-external` (host) | recall ≥ 95% on call sites |
| TS imports | `ts-import` (file→file, opt-in), `lib-usage` (service→lib) | recall ≥ 80% (alias-resolution best-effort) |

### Honesty rules

- **Edges are extracted, not runtime-observed.** A dynamic subject (`subject.something(${id})`) is recorded in `diagnostics.json` as `unresolved`, not invented.
- **`diagnostics.json` is the second source you should check** whenever the graph seems "missing" a relationship — the call-site is almost certainly listed as unresolved.
- **Coverage caveats** are in `arch-graph-out/validation.json` per domain (recall, resolveRate, ground-truth counts). If a domain shows zero ground-truth, that domain probably isn't used in this project (and the config can opt it out via `domains: { http: false }` etc.).

### Quick recipes (without MCP)

```bash
# Who publishes on a subject?
jq '.edges[] | select(.kind=="nats-publish" and (.label // "" | contains("user.created"))) | .source' arch-graph-out/graph.json

# What does a service depend on?
jq '.edges[] | select(.source=="service:platform-api") | {kind, target}' arch-graph-out/graph.json

# All unresolved NATS subjects
jq '.nats.unresolved[] | {file: .location.file, line: .location.line, via}' arch-graph-out/diagnostics.json
```
