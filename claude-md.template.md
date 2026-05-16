## arch-graph (static architecture facts)

This project uses **arch-graph** — a static extractor that turns the NestJS monorepo into a typed graph at `arch-graph-out/graph.json` (+ `diagnostics.json`, `validation.json`, `graph.mermaid`).

### Before answering any architecture question — check the graph first

The graph is the source of truth for these questions; do not grep or guess:

- "Who publishes / subscribes to NATS subject `X`?"
- "What services depend on TypeORM entity `Y` / queue `Z`?"
- "Which module imports / provides / exports `SomeProvider`?"
- "How does service `A` reach service `B`? (NATS, HTTP, BullMQ, DI)"
- "What changes if I rename / move `libs/foo`?" (ts-import edges)
- "What are the outgoing / incoming dependencies of service `X`?"

### Prefer CLI query subcommands

The fastest way to answer architecture questions is `arch-graph`'s built-in query subcommands. They read `arch-graph-out/graph.json` directly — no MCP server, no stdio overhead, structured output:

```sh
arch-graph who-publishes <subject>     # NATS publishers
arch-graph who-subscribes <subject>    # NATS subscribers
arch-graph queue-producers <queue>     # BullMQ producers
arch-graph queue-consumers <queue>     # BullMQ consumers
arch-graph table-users <table>         # TypeORM repository users
arch-graph deps-of <service-id>        # outgoing dependencies by kind
arch-graph dependents-of <service-id>  # services that depend on this one
arch-graph module-imports <module>     # what a NestJS module imports
arch-graph path <from> <to>            # shortest directed path
arch-graph stats                       # node + edge counts per kind
```

Options: `--out <dir>` (default `./arch-graph-out`), `--json` (default), `--table`.
Exit codes: `0` = found, `4` = not found.

Sample — find publishers of `user.created`:

```sh
arch-graph who-publishes user.created --json
```

```json
{
  "query": "who-publishes",
  "input": "user.created",
  "found": true,
  "results": [
    {
      "role": "publisher",
      "owner": "platform-api",
      "counterpart": "user.created",
      "kind": "nats-publish",
      "file": "apps/api/user.service.ts",
      "line": 42
    }
  ]
}
```

### MCP fallback (if installed)

If `arch-graph mcp` is available on PATH and the editor has an MCP client configured, the MCP tools can also answer these queries: `subject_publishers`, `subject_subscribers`, `queue_producers`, `queue_consumers`, `service_dependencies`, `service_dependents`, `module_imports`, `table_users`, `path`, `explain`, `query`, `stats`. For unresolved / dynamic call-sites the extractor couldn't pin down, read `arch-graph-out/diagnostics.json` directly — there is no MCP tool for it.

### jq fallback (if CLI unavailable)

If neither the CLI nor MCP is available, read `arch-graph-out/graph.json` directly. GraphEdge fields are `{id, from, to, kind, file?, line?, dynamic?, subjectPattern?, meta?}` — not `source`/`target`/`label`/`location`. Node id prefixes: `nats:<subject>`, `service:<id>`, `db-table:<name>`, `queue:<name>`, `module:<ClassName>`.

```bash
# Who publishes on a subject?
jq --arg s 'nats:user.created' '
  .edges[] | select((.kind=="nats-publish" or .kind=="nats-request") and .to==$s)
           | {from, kind, file, line}
' arch-graph-out/graph.json

# What does a service depend on?
jq --arg s 'service:platform-api' '.edges[] | select(.from==$s) | {kind, to, file, line}' arch-graph-out/graph.json

# Who imports / provides a module?
jq --arg m 'module:AuthModule' '.edges[] | select(.to==$m and (.kind | startswith("di-"))) | {kind, from, file, line}' arch-graph-out/graph.json

# All unresolved NATS subjects (diagnostics, not graph)
jq '.nats.unresolved[] | {file: .location.file, line: .location.line, via}' arch-graph-out/diagnostics.json
```

### Freshness

The graph is **static**. The pre-commit hook (if installed) rebuilds it automatically and stages the output files before each commit that touches `.ts` files — keeping the graph coherent with the code in history.

Treat the graph as stale if any of these is true:
- `arch-graph-out/graph.json` is older than the newest `.ts` file
- `arch-graph-out/` does not exist
- You just edited a NATS / TypeORM / BullMQ / HTTP call-site

To rebuild manually: `arch-graph build`

### What's in the graph

| Domain | Edges | Resolution gate |
|---|---|---|
| NATS | `nats-publish`, `nats-subscribe`, `nats-request`, `nats-reply` | recall ≥ 95% vs grep-based ground truth |
| TypeORM | `db-read`, `db-write`, `db-access` (service → table) | recall ≥ 95%, resolve ≥ 95% |
| BullMQ | `queue-produce`, `queue-consume` | recall ≥ 95% per role |
| NestJS DI | `di-import`, `di-provides`, `di-exports`, `di-controller` | recall ≥ 95% per field |
| HTTP | `http-call` (internal) or `http-external` (host) | recall ≥ 95% on call sites |
| TS imports | `ts-import` (file→file, opt-in), `lib-usage` (service→lib) | recall ≥ 80% (alias-resolution best-effort) |

### Honesty rules

- **Edges are extracted, not runtime-observed.** A dynamic subject (`subject.something(${id})`) is recorded in `diagnostics.json` as `unresolved`, not invented as an edge.
- **`diagnostics.json` is the second source you should check** whenever the graph seems "missing" a relationship — the call-site is almost certainly listed as unresolved.
- **Coverage caveats** are in `arch-graph-out/validation.json` per domain (recall, resolveRate, ground-truth counts). If a domain shows zero ground-truth, that domain probably isn't used in this project.
- **Cite source location** (`file:line`) for every edge you mention. Never invent an edge.
