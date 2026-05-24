## arch-graph (static architecture facts)

This project uses **arch-graph** — a static extractor that turns the NestJS monorepo into a typed graph at `arch-graph-out/graph.json` (+ `diagnostics.json`, `validation.json`, `graph.mermaid`).

### Before answering any architecture question — check the graph first

The graph is the source of truth for these questions; do not grep or guess:

- "Who publishes / subscribes to NATS subject `X`?"
- "What services depend on TypeORM entity `Y` / queue `Z`?"
- "Which module imports / provides / exports `SomeProvider`?"
- "Which guards / interceptors / pipes are applied to controller `C` or method `m`?" (`di-guard`, `di-interceptor`, `di-pipe` edges)
- "What tables relate to `T` via `@ManyToOne / @OneToMany / @ManyToMany`?" (`db-relation` edges)
- "Are there import cycles in this codebase?" (`diagnostics.cycles` — ts-import, lib-usage, di-import)
- "How does service `A` reach service `B`? (NATS, HTTP, BullMQ, DI)"
- "What changes if I rename / move `libs/foo`?" (ts-import edges incl. CommonJS `require(...)`)
- "What are the outgoing / incoming dependencies of service `X`?"
### Prefer CLI query subcommands

The fastest way to answer architecture questions is `arch-graph`'s built-in query subcommands. They read `arch-graph-out/graph.json` and `arch-graph-out/code-intel/` directly:

```sh
# --- NEW: Code Intelligence (Surgical Reads & Context) ---
arch-graph code-search "q"      # Semantic search over code
arch-graph docs-search "q"      # Semantic search over docs
arch-graph code-intel outline <F> # TOC + line ranges for surgical reads
arch-graph code-intel get-type-definition <S> # All members/decorators of a type
arch-graph code-intel find-references <S> # All calls/flows/type-refs project-wide
arch-graph code-intel resolve-symbol <S> # Locate symbol/path (fuzzy)
arch-graph code-intel trace-scenario <E> # Full execution trace from endpoint
arch-graph code-intel trace-message-flow <P> # Cross-service NATS/RMQ trace
arch-graph code-intel impact-contract <D> # Impact of changing a DTO/Entity
arch-graph code-intel explain-flow --target <T> --param <P> # Trace parameter mutation
arch-graph code-intel policies           # EXPERIMENTAL — get project style rules
arch-graph code-intel blueprint <K>      # EXPERIMENTAL — get best code examples for Service/DTO/etc.
arch-graph code-intel suggest-placement <NAME> --kind <K>  # EXPERIMENTAL — propose target file/module
arch-graph code-intel validate-proposal <FILE>             # EXPERIMENTAL — lint a proposed change
# --- Legacy: Structural Graph Queries ---
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

**Surgical Context Strategy:**
1. (Optional, EXPERIMENTAL) Use `code-intel policies` to understand local coding norms.
2. Use `code-intel outline` to find the `line` and `endLine` of a target method.
3. Use `cat` (or your reading tool) to read ONLY that specific line range.
This saves 90% of context tokens and avoids hallucinating on unrelated code.

**Fuzzy fallback**: ...
**Fuzzy fallback**: If a question is imprecise ("how does X work?", "find code about Y") and no structured subcommand fits, use `arch-graph semantic search "<query>"` (or MCP tool `semantic_search`). Requires running `arch-graph semantic build` first to build the semantic index.

Options (structural query subcommands only): `--out <dir>` (default `./arch-graph-out`), `--json` (default), `--table`. Code-intel subcommands always emit JSON.
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
      "owner": "my-api",
      "counterpart": "user.created",
      "kind": "nats-publish",
      "file": "apps/api/user.service.ts",
      "line": 42
    }
  ]
}
```

### MCP fallback (if installed)

If `arch-graph mcp` is available on PATH and the editor has an MCP client configured, the MCP server exposes **30+ tools** across four groups:

- **Structural (10):** `subject_publishers`, `subject_subscribers`, `queue_producers`, `queue_consumers`, `service_dependencies`, `service_dependents`, `module_imports`, `table_users`, `path`, `stats`.
- **Semantic (3, requires `arch-graph semantic build`):** `code_search`, `docs_search`, `semantic_search`.
- **Code-intel — stable v1 (requires `arch-graph code-intel build`):** `resolve_symbol`, `explain_data_flow`, `explain_branch`, `trace_scenario`, `trace_exceptions`, `trace_message_flow`, `impact_contract`, `get_file_outline`, `get_type_definition`, `find_references`, `get_orientation`, `self_check`.
- **Code-intel — EXPERIMENTAL** (shape may change): `get_blueprint`, `get_project_policies`, `suggest_placement`, `validate_proposal`.
- **Natural-language fallback (2):** `explain`, `query`.

For unresolved / dynamic call-sites the extractor couldn't pin down, read `arch-graph-out/diagnostics.json` directly — there is no MCP tool for it.

### jq fallback (if CLI unavailable)

If neither the CLI nor MCP is available, read `arch-graph-out/graph.json` directly. GraphEdge fields are `{id, from, to, kind, file?, line?, dynamic?, subjectPattern?, meta?}` — not `source`/`target`/`label`/`location`. Node id prefixes: `nats:<subject>`, `service:<id>`, `db-table:<name>`, `queue:<name>`, `module:<ClassName>`, `provider:<ClassName>`, `file:<absolute-path>`.

For cycle diagnostics, read `arch-graph-out/diagnostics.json` → `.cycles.cycles[]` (each entry has `kind` ∈ {`ts-import`, `lib-usage`, `di-import`}, `nodes: string[]`, `edgeLocations: [{from, to, location?}]`). If `.cycles.error` is set, cycle detection degraded (e.g. RangeError on a very large graph) — output may be incomplete.

```bash
# Who publishes on a subject?
jq --arg s 'nats:user.created' '
  .edges[] | select((.kind=="nats-publish" or .kind=="nats-request") and .to==$s)
           | {from, kind, file, line}
' arch-graph-out/graph.json

# What does a service depend on?
jq --arg s 'service:my-api' '.edges[] | select(.from==$s) | {kind, to, file, line}' arch-graph-out/graph.json

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
| TypeORM | `db-read`, `db-write`, `db-access` (service → table) + `db-relation` (table → table via `@ManyToOne` / `@OneToMany` / `@ManyToMany` / `@OneToOne`; wrapper aliases via `typeorm.relationDecorators`) | recall ≥ 95%, resolve ≥ 95% |
| BullMQ | `queue-produce`, `queue-consume` | recall ≥ 95% per role |
| NestJS DI | `di-import`, `di-provides`, `di-exports`, `di-controller` + `di-guard` / `di-interceptor` / `di-pipe` (from `@UseGuards` / `@UseInterceptors` / `@UsePipes`, attachedTo class or method) | recall ≥ 95% per field |
| HTTP | `http-call` (internal) or `http-external` (host) | recall ≥ 95% on call sites |
| TS imports | `ts-import` (file→file, opt-in, captures static `import`, dynamic `import()`, and CommonJS `require(...)`), `lib-usage` (service→lib) | recall ≥ 80% (alias-resolution best-effort) |
| Cycles | `diagnostics.cycles` (Johnson's enumeration over `ts-import` / `lib-usage` / `di-import` subgraphs) | informational — surfaced in Mermaid output with red highlight |

### Honesty rules

- **Edges are extracted, not runtime-observed.** A dynamic subject (`subject.something(${id})`) is recorded in `diagnostics.json` as `unresolved`, not invented as an edge.
- **`diagnostics.json` is the second source you should check** whenever the graph seems "missing" a relationship — the call-site is almost certainly listed as unresolved.
- **Coverage caveats** are in `arch-graph-out/validation.json` per domain (recall, resolveRate, ground-truth counts). If a domain shows zero ground-truth, that domain probably isn't used in this project.
- **Custom TypeORM relation decorators require config.** If a project wraps `@ManyToOne` as something like `@ManyToOneWithIndex`, it must be declared in `arch-graph.config.ts` under `typeorm.relationDecorators`; otherwise those `db-relation` edges will be absent.
- **Cite source location** (`file:line`) for every edge you mention. Never invent an edge.
