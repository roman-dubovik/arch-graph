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

The project uses structural, semantic, and code-intelligence sidecars. Before querying:

```bash
# 1. Structural graph check
if [ ! -f arch-graph-out/graph.json ]; then
    arch-graph build
fi

# 2. Code-Intel check (if using deterministic tools)
if arch-graph code-intel self-check --quiet; then
    : # Index is fresh
else
    echo "Code-intel index is stale or missing. Rebuilding..."
    arch-graph code-intel build --quiet
fi
```

### Step 3 — Which tool to use?

| Goal | Primary Tool |
|---|---|
| Topology / Cross-app deps | `subject_publishers`, `service_dependencies`, `jq graph.json` |
| Fuzzy discovery / Search | **`code-search`**, **`docs-search`**, `semantic_search` |
| Method / DTO / Flow facts | `code-intel` (outline, explain-flow, impact-contract, resolve-symbol) |
| Detailed Member Map | `code-intel get-type-definition` |
| Global Usages / Refs | `code-intel find-references` |
| Exceptions / Error Flow | `code-intel trace-exceptions` |
| Feature Implementation | `code-intel` (blueprint, policies, suggest-placement) — *Experimental* |

### Step 4 — Answer using CLI query subcommands

**"Find code related to 'auth' or 'promos'."**
```bash
arch-graph code-search "auth logic"
```

**"Find documentation about 'deployment' or 'testing'."**
```bash
arch-graph docs-search "deployment guide"
```

**"How does this file/module work? Give me an outline."**
```bash
arch-graph code-intel outline src/path/to/file.ts
# Use line and endLine from output for surgical reads to save tokens!
```

**"What are the members and decorators of this Class/DTO/Entity?"**
```bash
arch-graph code-intel get-type-definition UserEntity
```

**"Who calls this method or uses this symbol project-wide?"**
```bash
arch-graph code-intel find-references AuthService.login
```

**"What is the impact of changing this DTO/Entity or field?"**
```bash
arch-graph code-intel impact-contract CreateItemDto --field name
```

**"Trace the execution chain starting from an endpoint."**
```bash
arch-graph code-intel trace-scenario "POST /items/create"
```

**"Find all possible exceptions bubbling from an entry point."**
```bash
arch-graph code-intel trace-exceptions "ItemsService.create"
```

**"Trace a message pattern across all microservices."**
```bash
arch-graph code-intel trace-message-flow "order.created"
```

**"What conditions surround this specific line of code?"**
```bash
arch-graph code-intel explain-branch --file path.ts --line 42
```

**"Show me the best existing code example for a Service/DTO/Controller."**
```bash
# Experimental
arch-graph code-intel blueprint service
```

**"What are the project's coding rules and style conventions?"**
```bash
# Experimental
arch-graph code-intel policies
```

### Fallback — MCP server (if installed)

If `arch-graph mcp` is configured, use its tools: `resolve_symbol`, `get_file_outline`, `get_blueprint`, `get_project_policies`, `impact_contract`, `explain_data_flow`, `explain_branch`, `trace_scenario`, `trace_exceptions`, etc.

**Surgical Context Strategy:**
1. Call `get_file_outline` to find the `line` and `endLine` of a target method.
2. Read ONLY that specific range using your standard file-reading tool.

### Step 5 — Honesty in the answer

- Quote the `file:line` of every extracted edge or symbol you cite.
- If a relevant call-site is in `diagnostics.json` as `unresolved`, say so explicitly.
- Never invent an edge. Determinism is the core value — be precise.

## Maintenance

```bash
arch-graph build                            # rebuild manually after touching .ts files
arch-graph hook install                     # pre-commit hook (default, recommended)
arch-graph claude install --skill           # write CLAUDE.md section + skill file
arch-graph code-intel build                 # rebuild deep intelligence sidecar
```
