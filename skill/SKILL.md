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

### Step 1 — Detect install + graph

```bash
if ! command -v arch-graph >/dev/null 2>&1; then
    echo "arch-graph is not installed. Run: bash scripts/install.sh (from the repo) or follow https://… README install steps."
    exit 1
fi

# Is there a config in the current dir?
if [ ! -f arch-graph.config.ts ] && [ ! -f arch-graph.config.json ]; then
    echo "No arch-graph.config.ts here. Run \`arch-graph init\` and fill in id/root/appsGlob, then re-run."
    exit 1
fi
```

If both checks pass, continue.

### Step 2 — Build (or freshness-check)

The graph is static. Check whether `arch-graph-out/graph.json` exists and is newer than the newest `.ts` file in the repo:

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

If the build's regression gate fails (exit code 3), surface the message but continue — the user may still want a partial answer.

### Step 3 — Answer using the graph

Prefer **the MCP server** if it's installed and configured (`arch-graph mcp` — see `arch-graph mcp --help`). MCP exposes typed tools: `subject_publishers`, `subject_subscribers`, `queue_producers`, `queue_consumers`, `service_dependencies`, `service_dependents`, `module_imports`, `table_users`, `path`, `explain`, `query`, `stats`. They're cheap and structured. For diagnostics (unresolved / dynamic call-sites the extractor couldn't pin down) read `arch-graph-out/diagnostics.json` directly — no MCP tool for it.

Otherwise read `arch-graph-out/graph.json` directly with `jq`. Edges are `{id, from, to, kind, file?, line?, dynamic?, subjectPattern?, meta?}` — not `source`/`target`/`label`/`location`. Common shapes:

**"Who publishes / subscribes to a subject?"**
```bash
# subjects are nodes with kind=nats-subject and id `nats:<subject>` — edges
# point from owner (service/lib) to subject for senders, subject to owner for
# subscribers.
jq --arg s 'nats:user.created' '
  .edges[] | select(
    ((.kind=="nats-publish" or .kind=="nats-request") and .to==$s)
    or ((.kind=="nats-subscribe" or .kind=="nats-reply") and .from==$s)
  ) | {kind, from, to, file, line}
' arch-graph-out/graph.json
```

**"What does service X depend on?"**
```bash
jq --arg s 'service:platform-api' '.edges[] | select(.from==$s) | {kind, to, file, line}' arch-graph-out/graph.json
```

**"Shortest path between two services?"**
Without MCP, load both nodes and do a BFS in Python or just walk edges in jq. With MCP, call the `path` tool (`{from, to, kindFilter?}`).

**"Module DI — who imports / provides this?"**
```bash
# DI edges are kind=di-import / di-provides / di-exports / di-controller, all
# prefixed `di-` (not `module-`). Module nodes have id `module:<ClassName>`.
jq --arg m 'module:AuthModule' '.edges[] | select(.to==$m and (.kind | startswith("di-"))) | {kind, from, file, line}' arch-graph-out/graph.json
```

**"All unresolved sites in domain D?"**
```bash
# Site-level diagnostics. NATS / TypeORM / BullMQ / HTTP / imports site types
# nest their source location as `.location.file` / `.location.line`.
jq '.nats.unresolved[] | {file: .location.file, line: .location.line, via}' arch-graph-out/diagnostics.json
# also: .typeorm.unresolvedEntities, .bullmq.unresolved, .http.unresolved, .imports.unresolvedImports
```

### Step 4 — Honesty in the answer

- Quote the `location.file:line` of every extracted edge you cite.
- If a relevant call-site is in `diagnostics.json` as `unresolved` (e.g. dynamic NATS subject), say so explicitly — do not pretend the graph "doesn't see it".
- If the user asks about HTTP / BullMQ / DI and `validation.json` shows the domain has zero ground-truth, mention that the domain may not be in use (rather than reporting "no results, therefore no calls").
- Never invent an edge. The whole value proposition is determinism — be precise about what the graph says.

## Maintenance

Re-run `arch-graph build` after touching `.ts` files. Or install the git hook once:

```bash
arch-graph hook install        # post-commit auto-rebuild on .ts changes
arch-graph hook status         # check
arch-graph hook uninstall      # remove
```

For always-on integration with Claude Code in this project:

```bash
arch-graph claude install      # writes a section to ./CLAUDE.md
arch-graph claude uninstall    # removes it
```

## Limitations (honest)

- **No runtime tracing.** A subject published only in production code paths that never hit a static call-site won't appear.
- **Dynamic subjects** (`subject.${id}`) become `unresolved` entries in `diagnostics.json`, not edges.
- **Decorator-only sources.** Wrapper publish / subscribe APIs need to be declared in `arch-graph.config.ts` (`nats.wrapperPublishApis`, `wrapperSubscribeApis`).
- **TS-import resolution** uses `tsconfig.base.json` paths — exotic alias setups may produce `externalOrUnresolved` entries.
- **Recall gates** (validation.json) are the floor: 95% for NATS / TypeORM / BullMQ / DI / HTTP, 80% for TS imports. Anything below is a build-time hard failure.
