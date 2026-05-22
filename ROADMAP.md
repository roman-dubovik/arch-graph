# arch-graph roadmap

_Last updated: 2026-05-22_

No ETAs. Order within a section is rough priority, not a commitment.

## Where we are

A deterministic TypeScript architecture-graph builder for NestJS monorepos with an optional local multilingual semantic sidecar. Pipeline: ts-morph extractors → `graph.json` + (optional) `embeddings.jsonl` + `manifest.json`. **Zero LLM tokens at build and query.**

## Shipped

### Foundation (2026-05-16)
- **Cycle detection** — Johnson's algorithm across subgraphs.
- **Semantic sidecar** — Local multilingual search.
- **Guards / Interceptors / Pipes** — Metadata extraction.
- **TypeORM entity-relation edges** — Cross-table links.

### AI Runtime Layer & Code Intelligence (2026-05-22)
- **`code-intel-v1`** — Deterministic TypeScript facts sidecar. **30+ tools** including symbols, members, references, call traces, and DTO/Entity impact.
- **Exception Flow (Throw Graph)** — `trace_exceptions` tool and enhanced `trace_scenario` capture `throw` statements and `try-catch` blocks bubbling from an entry point.
- **Surgical Reads** — `get_file_outline` with line-range detection (90% context token savings).
- **Cross-Service Flow** — `trace_message_flow` bridges structural NATS/RMQ edges with code-intel traces.
- **AI Operating System** — Orientation hooks, Style Guardians, and Dependency Guardrails integrated into multi-agent setup.
- **Unified Benchmarks** — Aggregated results across **3 real-world monorepos**.

### Post-semantic expansion (2026-05-17)
- **`doc-section-v1`** — Documentation as graph nodes.
- **`code-vs-docs-v1`** — Split search tools (70% recall).
- **`ui-uplift-v1`** — Tailwind & i18n component enrichment.
- **`openapi-enrich-v1`** — Swagger metadata folding.
- **`fe-i18n-multi-enum-v1`** — Locale & Enum route resolution.

### Cron & BullMQ (2026-05-19)
- **`cron-v1`** — NestJS Schedule semantics.
- **`bullmq-extras-v1/v2/v3`** — High-fidelity queue extraction with generics and inheritance.

## Future

### 1. Architectural Policies & Auto-Fixer
Transform `validate_proposal` into an active assistant.
- **Auto-Fixer**: Propose code patches (e.g. Service scaffolding) when guardrails are triggered.
- **Synthesized Blueprints**: Deep project-pattern integration for code generation.

### 2. Cross-Repo Intelligence
Federated graphs linking multiple monorepos via shared patterns.
- **Global Impact Analysis**: Cross-repo contract change tracking.

### 3. Static Route Resolver
Deep prefix concatenation for NestJS paths.
- **`resolve_url` tool**: Handlers to HTTP path mapping.

### 4. Code Metrics & Refactoring
Deterministic "Code Smells" index (Complexity, Fan-out).
- **`suggest_refactoring` tool**: Hard facts vs LLM intuition.

## Known limits (honest)
- **Static extraction** — cannot see runtime-only config.
- **Eval set** — currently 3 monorepos (expanding soon).

## Related artifacts
- [`docs/BENCHMARKS.md`](./docs/BENCHMARKS.md) — Durable summary.
- [`docs/comparison.html`](./docs/comparison.html) — Capability matrix.
