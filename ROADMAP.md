# arch-graph — roadmap

Items below are sorted by impact × cost, derived from the [competitive landscape](./COMPETITIVE-LANDSCAPE.md) analysis. *Note: `COMPETITIVE-LANDSCAPE.md` is local research; not yet in the public repo.*

No ETAs or dates here — this is a soft roadmap, not a commitment. Order within a tier is the order we'd reach for items, not a queue.

## Shipped (2026-05-16) ✅

The following items from Tier 1, 2, and 3 are now live on `main`. Each shipped with vitest tests at ≥ 95% line coverage and a per-feature integration-test gate where applicable.

### Cycle detection — Tier 1 ✅
- **What**: Johnson's algorithm enumerates elementary cycles across `ts-import`, `lib-usage`, and `di-import` edge subgraphs. Surfaced as `diagnostics.cycles` (per-kind counts + per-cycle `nodes` + `edgeLocations`). Mermaid output highlights cycle-participating nodes with a red `style` directive. Graceful `RangeError` degradation with a structured `error` sentinel on very large graphs.
- **Where**: `src/detectors/cycles.ts`, `src/output/graph-mermaid.ts` cycle subgraph, `src/pipeline/build.ts` `safeDetectCycles` wrapper.

### Semantic sidecar — Tier 1 ✅
- **What**: Optional dense-vector semantic search layer over nodes, built on hybrid (node label + AST snippet) embeddings via local `@xenova/transformers` with model `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384-dim, multilingual). New CLI subcommands `arch-graph semantic build` and `arch-graph semantic search` plus MCP tool `semantic_search` for fuzzy intent queries ("find code about X"). Sidecar persisted at `arch-graph-out/<repo>/semantic/{manifest.json, embeddings.jsonl}`. Designed for federation with sister project 2-brain Phase 3.
- **Where**: `src/semantic/` (embedder, snippet extraction, I/O), `src/cli/semantic-commands.ts`, `src/mcp/server.ts` tool registration.
- **Diagnostic**: extends `diagnostics.json` with `semantic.counts.{indexed, skipped, fileReadErrors, transformerErrors}`, `skippedNodes` (capped at 50), `indexSizeBytes`, `model`, `dim`. Never throws on index errors; failures are values.

### Guards / Interceptors / Pipes — Tier 1 ✅
- **What**: `@UseGuards`, `@UseInterceptors`, `@UsePipes` decorators captured as typed edges (`di-guard`, `di-interceptor`, `di-pipe`) with `attachedTo: class | method:<name>`. Handles class-level + method-level decorators, multi-arg variants, `new InterceptorInstance()`, `Namespace.Guard` property access, `(AuthGuard as Type)`, `(((...)))` wrappers; `forwardRef`-aliased imports also resolved.
- **Where**: `src/extractors/di/filter-chain.ts`, `src/mapper/di-to-graph.ts`.
- **Diagnostic**: `unresolvedFilterRefs` (capped at 200 with `truncatedFilterRefs` counter), `skippedAnonymousFiles`, `dedupDropped`, per-kind counts. Count invariant: `guards + interceptors + pipes + unresolvedFilterRefs.length + dedupDropped + truncatedFilterRefs === filterChain.length`.

### TypeORM entity-relation (ER) edges — Tier 2 ✅
- **What**: `@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne` decorations emit `db-table → db-table` edges with kind `db-relation`. Handles bare-identifier (`@ManyToOne(Foo)`), string-token (`@ManyToOne('CategoryReference')`), and `forwardRef(() => Foo)` forms. Walks base-class hierarchy via `getBaseClass()` with cycle guard. Policy A skips `@OneToMany` to avoid duplicate-direction edges on the same FK.
- **Where**: `src/extractors/typeorm/relations.ts`, `src/mapper/typeorm-to-graph.ts`.
- **Diagnostic**: `unresolvedRelations` with structured `reason` (`unparseable` / `not-indexed` / `ownerNotIndexed`), `oneToManySkipped`, `baseClassCycles`. Invariant: `unparseable + notIndexed + ownerNotIndexed === unresolvedRelations.length`.

### Multi-module-system imports (CJS `require`) — Tier 3 ✅
- **What**: `require(...)` calls captured alongside static `import` and dynamic `import()`. Routes through the same alias resolver / edge emission. File-level edge dedup merges `cjsRequire: true` and `dynamic: true` meta when multiple kinds resolve to the same file.
- **Where**: `src/extractors/imports/extractor.ts`, `src/mapper/imports-to-graph.ts`.
- **Diagnostic**: `cjsRequires` array, `totalCjsRequire` count; multi-arg `require(id, opts)` and zero-arg `require()` surface as `<multi-args>` / `<zero-args>` synthetic specifiers with `dynamic-non-literal` resolution.

### Cycle-aware Mermaid output — Tier 3 ✅
- **What**: When `diagnostics.cycles` is non-empty, Mermaid renders cycle-participating nodes with `style nodeX fill:#fdd,stroke:#c00`. Cross-subgraph, no re-declaration. Slice-aware: `domain` and `per-service` slices only highlight cycle nodes visible in that slice. `%% WARNING:` comment emitted when cycle detection degraded.
- **Where**: `src/output/graph-mermaid.ts`.

## Tier 2 — Considered but deferred

### Hybrid mode: consume devtools snapshot (from @nestjs/devtools-integration)
- **Status**: under consideration
- **What**: optional `--devtools-snapshot <graph.json>` flag — merge runtime DI authority with our static cross-cutting edges
- **Effort**: medium (parse devtools schema + reconcile node IDs)
- **Why**: closes the "conditional DI" gap (where devtools is more accurate than static decorator parsing)
- **Why deferred**: no concrete user demand yet; static decorator parse + diagnostics cover ≥ 95% of structural questions on our reference set. Revisit if a contributor shows a real failure mode.

## Tier 3 — Polish (optional)

### Better cycle-aware Mermaid grouping (from arkit)
- **Status**: optional, partially shipped
- **What**: visual grouping by architectural layer in `graph.mermaid` — beyond the cycle highlight that already shipped, add explicit layer subgraphs (apps → libs → external)
- **Effort**: small
- **Why**: nice-to-have for visualization

## Tier 4 — Out of scope (keep skipped, document why)

### Cross-language coverage (Joern, scip-ts polyglot)
- arch-graph is TS-only by charter
- Joern/CPG abstraction is wrong level (statements/data-flow, not architectural edges)

### Runtime trace integration (OpenTelemetry service maps)
- Complementary, not competing
- Finds edges arch-graph can't see (dynamic subjects, prod-only paths) but requires deployed instrumented services
- Future: optional `--otel-snapshot` mode if there's user demand

## Note on benchmark

The competitor benchmark ([`bench/competitive-bench.md`](./bench/competitive-bench.md)) measures **recall + tokens** vs the same tools on real questions. This roadmap is the orthogonal "capability borrow" plan. The capability-matrix view of where each tool fits lives at [docs/comparison.html](./docs/comparison.html); the numeric head-to-head lives at [bench/report.md](./bench/report.md). After the Tier 1+2+3 ship in 2026-05-16, every shipped item is rated ✓ on the matrix.
