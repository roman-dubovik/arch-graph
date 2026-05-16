# arch-graph — roadmap

Items below are sorted by impact × cost, derived from the [competitive landscape](./COMPETITIVE-LANDSCAPE.md) analysis. *Note: `COMPETITIVE-LANDSCAPE.md` is local research; not yet in the public repo.*

No ETAs or dates here — this is a soft roadmap, not a commitment. Order within a tier is the order we'd reach for items, not a queue.

## Tier 1 — Borrow from neighbors (low cost, high value)

### Cycle detection (from dependency-cruiser, madge)
- **Status**: planned
- **What**: detect circular `ts-import` / `lib-usage` cycles, surface as diagnostics
- **Effort**: small (BFS/DFS on existing graph edges)
- **Why**: dep-cruiser proves the demand; integrates into our existing diagnostics framework

### Guards / Interceptors / Pipes (from @nestjs/devtools-integration)
- **Status**: planned
- **What**: extend NestJS DI coverage with the filter-chain decorators (`@UseGuards`, `@UseInterceptors`, `@UsePipes`)
- **Effort**: small-medium (same extractor pattern as `@Controller`, just different decorators)
- **Why**: completes the DI picture; devtools shows this is standard expectation

## Tier 2 — Higher coverage (medium cost, medium-high value)

### TypeORM entity-relation (ER) edges (from erdia, typeorm-uml, nestjs-doctor)
- **Status**: planned
- **What**: extract `@ManyToOne` / `@OneToMany` / `@JoinTable` annotations → emit `db-relation` edges between tables
- **Effort**: medium (entity-walk + decorator parse already in extractor)
- **Why**: arch-graph today only has `service → table`; ER edges enable "what depends on this entity's schema" questions

### Hybrid mode: consume devtools snapshot (from @nestjs/devtools-integration)
- **Status**: under consideration
- **What**: optional `--devtools-snapshot <graph.json>` flag — merge runtime DI authority with our static cross-cutting edges
- **Effort**: medium (parse devtools schema + reconcile node IDs)
- **Why**: closes the "conditional DI" gap (where devtools is more accurate than static decorator parsing)

## Tier 3 — Polish (low priority unless feedback)

### Multi-module-system imports (from dependency-cruiser)
- **Status**: optional
- **What**: dep-cruiser handles ESM/CJS/AMD; we handle ts-morph projects
- **Effort**: small-medium (corner cases for legacy CJS)
- **Why**: only matters for users with non-modern TS configs

### Better cycle-aware Mermaid output (from arkit)
- **Status**: optional
- **What**: visual grouping by architectural layer in `graph.mermaid`
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

The competitor benchmark (`bench/competitive-bench.md` planned) measures **recall + tokens** vs the same tools on real questions. This roadmap is the orthogonal "capability borrow" plan. The capability-matrix view of where each tool fits lives at [docs/comparison.html](./docs/comparison.html); the numeric head-to-head lives at [bench/report.md](./bench/report.md).
