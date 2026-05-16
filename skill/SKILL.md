---
name: arch-graph
description: "NestJS-monorepo static architecture graph — answers questions about NATS publishers/subscribers, BullMQ queues, TypeORM entities, NestJS module DI, HTTP inter-service calls, and TS-import topology. Use when the user asks any architecture question about a NestJS codebase, especially if `arch-graph-out/graph.json` exists."
trigger: /arch-graph
---

# /arch-graph

arch-graph is a domain-specific static extractor for NestJS monorepos. It produces a typed graph (`arch-graph-out/graph.json`) plus diagnostics, validation report, and a Mermaid flowchart. It answers questions that graphify and grep cannot, because it understands NestJS / NATS / BullMQ / TypeORM semantics directly.

Use this skill whenever the user asks anything about the architecture of a NestJS project — message flow, dependencies, who-calls-who, impact of a rename, etc.

## When to use vs graphify

| Question shape | Use |
|---|---|
| "Who publishes on `subject.X`?" | **arch-graph** |
| "What services depend on entity `Y`?" | **arch-graph** |
| "Show me the path from service A to B" | **arch-graph** |
| "What changes if I rename `libs/auth`?" | **arch-graph** (ts-import edges) |
| "Summarize what this codebase is about" | graphify (semantic / concept graph) |
| "Find the section in the paper that says X" | graphify |

arch-graph is **deterministic, fast, no LLM cost** — every edge was extracted from AST, not inferred. The trade-off is narrower scope: it knows NestJS, not general code semantics.

## What You Must Do When Invoked

Follow these steps in order.

### Step 1 — Detect install + config

```bash
if ! command -v arch-graph >/dev/null 2>&1; then
    echo "arch-graph is not installed. Run: bash scripts/install.sh (from the repo) or follow the README install steps."
    exit 1
fi

# Is there a config in the current dir?
if [ ! -f arch-graph.config.ts ] && [ ! -f arch-graph.config.json ]; then
    echo "No arch-graph.config.ts here. Run \`arch-graph init\` to set one up, then re-run."
    exit 1
fi
```

If both checks pass, continue.

### Step 2 — Freshness check

The pre-commit hook (when installed) keeps the graph coherent — it rebuilds and stages `graph.json`, `diagnostics.json`, `validation.json`, `graph.mermaid` before each commit that touches `.ts` files. Even so, verify:

```bash
if [ ! -f arch-graph-out/graph.json ]; then
    echo "No graph yet — building."
    arch-graph build
else
    NEWEST_TS=$(find . -name '*.ts' -not -path './node_modules/*' -not -path './arch-graph-out/*' -not -path './dist/*' -newer arch-graph-out/graph.json 2>/dev/null | head -1)
    if [ -n "$NEWEST_TS" ]; then
        echo "Graph is stale (newer .ts: $NEWEST_TS) — rebuilding."
        arch-graph build
    fi
fi
```

If the build's recall gate fails (exit code 3 with `--strict`, otherwise always exit 0), surface the message but continue — the user may still want a partial answer.

### Step 3 — Answer using CLI query subcommands (preferred)

**Prefer the CLI query subcommands.** They read `arch-graph-out/graph.json` directly — no MCP server startup, no stdio overhead, fully structured JSON output. This is the most efficient path.

Match the user's question to the right subcommand:

**"Who publishes / subscribes to a NATS subject?"**
```bash
arch-graph who-publishes user.created --json
arch-graph who-subscribes user.created --json
# or --table for human-readable output
```

**"What does a service depend on? What depends on it?"**
```bash
arch-graph deps-of my-api --json
arch-graph dependents-of auth-service --json
```

**"BullMQ queue — who produces / consumes?"**
```bash
arch-graph queue-producers email-queue --json
arch-graph queue-consumers email-queue --json
```

**"TypeORM table — which services access it?"**
```bash
arch-graph table-users user --json
```

**"NestJS module — what does it import?"**
```bash
arch-graph module-imports AuthModule --json
```

**"Shortest path between two nodes?"**
```bash
arch-graph path service:my-api service:notification-service --json
```

**"Graph overview / sanity check?"**
```bash
arch-graph stats --table
```

Options: `--out <dir>` (default `./arch-graph-out`), `--json` (default), `--table`.
Exit codes: `0` = found, `4` = not found (node missing from graph), `1` = bad args / I/O error.

For unresolved / dynamic call-sites (things the extractor couldn't pin down), read `arch-graph-out/diagnostics.json` directly — there is no query subcommand for it.

### Fallback 1 — MCP server (if installed)

If `arch-graph mcp` is configured in the editor's MCP client, use its typed tools: `subject_publishers`, `subject_subscribers`, `queue_producers`, `queue_consumers`, `service_dependencies`, `service_dependents`, `module_imports`, `table_users`, `path`, `explain`, `query`, `stats`. MCP is slightly more expressive (the `explain` and `query` tools) but requires a running server.

### Fallback 2 — jq on graph.json (last resort)

If neither the CLI nor MCP is available, query `arch-graph-out/graph.json` with `jq`. Edges are `{id, from, to, kind, file?, line?, dynamic?, subjectPattern?, meta?}` — not `source`/`target`/`label`/`location`. Node id prefixes: `nats:<subject>`, `service:<id>`, `db-table:<name>`, `queue:<name>`, `module:<ClassName>`.

```bash
# Who publishes on a subject?
jq --arg s 'nats:user.created' '
  .edges[] | select(
    ((.kind=="nats-publish" or .kind=="nats-request") and .to==$s)
    or ((.kind=="nats-subscribe" or .kind=="nats-reply") and .from==$s)
  ) | {kind, from, to, file, line}
' arch-graph-out/graph.json

# What does service X depend on?
jq --arg s 'service:my-api' '.edges[] | select(.from==$s) | {kind, to, file, line}' arch-graph-out/graph.json

# Module DI — who imports this module?
jq --arg m 'module:AuthModule' '.edges[] | select(.to==$m and (.kind | startswith("di-"))) | {kind, from, file, line}' arch-graph-out/graph.json

# All unresolved NATS sites (diagnostics)
jq '.nats.unresolved[] | {file: .location.file, line: .location.line, via}' arch-graph-out/diagnostics.json
# also: .typeorm.unresolvedEntities, .bullmq.unresolved, .http.unresolved, .imports.unresolvedImports
```

### Step 4 — Honesty in the answer

- Quote the `file:line` of every extracted edge you cite.
- If a relevant call-site is in `diagnostics.json` as `unresolved` (e.g. dynamic NATS subject), say so explicitly — do not pretend the graph "doesn't see it".
- If the user asks about HTTP / BullMQ / DI and `validation.json` shows the domain has zero ground-truth, mention that the domain may not be in use (rather than reporting "no results, therefore no calls").
- Never invent an edge. The whole value proposition is determinism — be precise about what the graph says.

## Maintenance

```bash
arch-graph build                            # rebuild manually after touching .ts files
arch-graph hook install                     # pre-commit hook (default, recommended)
arch-graph hook install --mode=post-commit  # post-commit hook (optional)
arch-graph hook status                      # check installed mode
arch-graph hook uninstall                   # remove
arch-graph claude install --skill           # write CLAUDE.md section + skill file
arch-graph claude uninstall                 # remove CLAUDE.md section
```

## Limitations (honest)

- **No runtime tracing.** A subject published only in production code paths that never hit a static call-site won't appear.
- **Dynamic subjects** (`subject.${id}`) become `unresolved` entries in `diagnostics.json`, not edges.
- **Decorator-only sources.** Wrapper publish / subscribe APIs need to be declared in `arch-graph.config.ts` (`nats.wrapperPublishApis`, `wrapperSubscribeApis`).
- **TS-import resolution** uses `tsconfig.base.json` paths — exotic alias setups may produce `externalOrUnresolved` entries.
- **Recall gates** (`validation.json`) are the floor: 95% for NATS / TypeORM / BullMQ / DI / HTTP, 80% for TS imports. `arch-graph build --strict` hard-fails (exit 3) when any enabled domain drops below floor; without `--strict`, the build is advisory (always exit 0).
