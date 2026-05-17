# Design: FE Level 1 + Variant 2 extractors
Date: 2026-05-16
Base branch: `feat/semantic` (already 887f2ea, contains semantic sidecar)
Worktrees: `.worktrees/feat-fe-l1` (branch `feat/fe-l1`), `.worktrees/feat-var2` (branch `feat/var2-extractors`)

## Goal

Two parallel feature tracks lifting the 26-query baseline (see `2026-05-16-coverage-baseline.md`) on platform / insyra / beribuy 2.0:

- **FE Level 1** — extract React/Next pages, components, routes, hooks → new node kinds `fe-page`, `fe-component`, `fe-route`, `fe-hook`. Closes the C-category (UI) miss class.
- **Variant 2** — three live extractors (endpoint, db-entity-field, config-field callsites) + one placeholder (scoped-marker stub). Closes most A/E misses and lifts beribuy 2.0 from 40% → 65%+ by introducing endpoint nodes.

## Real-corpus signal (from Phase 1 research)

The research adjusted Variant 2 scope to what platform/insyra/beribuy **actually use**:

| Var 2 sub-feature | Pattern | Real usage? | Decision |
|---|---|---|---|
| endpoint | `@Controller(...) @Get/@Post/...` | **632 usages in platform** | Full extractor (Pattern A1 in design doc) |
| db-entity-field | `@Entity @Column` | **1312 usages in platform** | Full extractor (extends `typeorm/entity-index.ts`) |
| config-field (callsite) | `configService.get('KEY')`, `process.env.X` | ✅ heavily used | Full extractor — consumer-side (creates `config-field` node + `config-read-by` edge) |
| config-field (declaration) | `@Config()` class decorator | ❌ not in any project | Skip in v1 |
| config-field (factory) | `registerAs('ns', () => {...})` | ❌ not in any project | Skip in v1 |
| scoped-marker | `@Scope(REQUEST)`, `@Inject(REQUEST)` | ❌ not found | NodeKind placeholder, extractor = stub (no-op). Activate when corpus appears. |

This is a deliberate scope reduction vs. naïve "Var 2 full" — we add the kind to the enum for future-proofing but emit zero scoped-marker nodes in v1. Documented as `tests: N/A` for the stub.

## Non-goals

- **Frontend frameworks other than React/Next** in FE L1 (Vue, Svelte, Angular deferred).
- **Handler → backend trace** (FE Level 3) — out of scope; pages/components only.
- **Cross-monorepo edges** — D3 explicit non-goal.
- **Embeddings model change** — semantic layer reuses existing model and snippet logic. We only feed it more nodes.

## Worktree strategy

Two **independent** worktrees, both branched from `feat/semantic` HEAD (commit `887f2ea`):

| Worktree | Branch | Base | Purpose |
|---|---|---|---|
| `.worktrees/feat-fe-l1` | `feat/fe-l1` | `feat/semantic` | FE L1 extractor |
| `.worktrees/feat-var2` | `feat/var2-extractors` | `feat/semantic` | Var 2 (3 live + 1 stub) |

Both will touch `src/core/types.ts` (NodeKind/EdgeKind enum) but **with disjoint new entries**. A simple textual merge resolves cleanly because the additions land on adjacent lines, not the same line. We accept this as a low-risk merge concern.

Merge order: `feat/semantic` → main (deferred) → `feat/fe-l1` → main → `feat/var2-extractors` → main. Verification script runs after each merge.

## File-touch matrix

### Track A — FE Level 1 (worktree `feat-fe-l1`)

| Task | Files (exact paths) | Touches |
|------|---------------------|---------|
| A1 — Types | `src/core/types.ts` | Add 4 NodeKinds (`fe-page`, `fe-component`, `fe-route`, `fe-hook`), 3 EdgeKinds (`fe-imports`, `fe-renders`, `fe-routes-to`). Update `NODE_KIND_CHECK`. `EDGE_KIND_CHECK` in `src/mcp/server.ts`. |
| A2 — Extractor | `src/extractors/fe/extractor.ts` (new), `src/extractors/fe/react-patterns.ts` (new), `src/extractors/fe/router-patterns.ts` (new), `src/extractors/fe/*.test.ts` (new) | React component / hook / page / route detection via ts-morph. Per-file 95/95/90 coverage. |
| A3 — Mapper | `src/mapper/fe-to-graph.ts` (new), `src/mapper/fe-to-graph.test.ts` (new) | Extractor sites → graph nodes + edges. |
| A4 — Validation | `src/validation/fe-validator.ts` (new), `src/validation/fe-validator.test.ts` (new) | Ground-truth regex + recall check. Floor 90% (FE patterns more variable than NestJS canonical). |
| A5 — Pipeline integration | `src/pipeline/build.ts` | Register extractor → validate → map in the existing run loop. ≤ 30 lines. |
| A6 — Fixtures | `src/__fixtures__/fe-sample/` (new) | Minimal React/Next fixture for tests. |

### Track B — Variant 2 (worktree `feat-var2`)

| Task | Files (exact paths) | Touches |
|------|---------------------|---------|
| B1 — Types | `src/core/types.ts` | Add 4 NodeKinds (`endpoint`, `config-field`, `scoped-marker`, `db-entity-field`), 4 EdgeKinds (`endpoint-of`, `endpoint-calls`, `config-read-by`, `entity-has-field`). `scoped` edge kind reserved but unused. Update CHECK records and `EDGE_KIND_CHECK` in MCP. |
| B2 — Endpoint extractor | `src/extractors/endpoint/extractor.ts` (new), `src/extractors/endpoint/extractor.test.ts` (new) | `@Controller` + `@Get/@Post/@Patch/@Delete/@Put/@All/@Options/@Head/@Sse` decorators. Controller prefix resolution (string + object form). Pattern combination. attachedTo class+method. |
| B3 — Endpoint mapper | `src/mapper/endpoint-to-graph.ts` (new), `src/mapper/endpoint-to-graph.test.ts` (new) | endpoint nodes + `endpoint-of` edges. Reuses existing `di-guard/interceptor/pipe` edges that attach at method level — no new edge kind for those. |
| B4 — db-entity-field extractor | Extends `src/extractors/typeorm/entity-index.ts` + new `src/extractors/typeorm/fields.ts`, new `src/extractors/typeorm/fields.test.ts` | Walk entity classes' `getProperties()`, find `@Column/@PrimaryColumn/@CreateDateColumn/@UpdateDateColumn/@DeleteDateColumn/@PrimaryGeneratedColumn`. Type, nullable, name. |
| B5 — db-entity-field mapper | Extends `src/mapper/typeorm-to-graph.ts` + new tests | `db-entity-field` nodes + `entity-has-field` edges (db-table → db-entity-field). |
| B6 — Config-field extractor (callsite) | `src/extractors/config/extractor.ts` (new), `src/extractors/config/extractor.test.ts` (new) | Find `configService.get<T>('KEY')` and `process.env.KEY` callsites. Emit `config-field:<KEY>` node and consumer class. |
| B7 — Config-field mapper | `src/mapper/config-to-graph.ts` (new), `src/mapper/config-to-graph.test.ts` (new) | `config-field` nodes + `config-read-by` edges. |
| B8 — Scoped-marker stub | `src/extractors/scoped/extractor.ts` (new, no-op), `src/extractors/scoped/extractor.test.ts` (new, asserts stub behavior) | NodeKind placeholder; extractor returns empty array. Test asserts empty result + diagnostic note "stub-extractor, awaiting corpus signal". |
| B9 — Pipeline integration | `src/pipeline/build.ts` | Register 4 new extractor → validate → map blocks. |
| B10 — Validators | `src/validation/endpoint-validator.ts`, `src/validation/config-validator.ts` (new each, no validator for stub) | Ground-truth regex + recall floor 95% (canonical NestJS patterns). |
| B11 — Fixtures | `src/__fixtures__/var2-sample/` (new) | Endpoint + entity-field + config callsite fixtures. |

### Track C — Verification (small, runs in one of the worktrees after both merge)

| Task | Files (exact paths) | Touches |
|------|---------------------|---------|
| C1 — Eval script | `scripts/run-baseline-eval.sh` (new) | Bash script: rebuilds graph + semantic on 3 projects, runs the 26-query suite, compares to baseline doc expectations, prints diff table. |
| C2 — Eval fixtures | `scripts/eval/queries.json` (new) | The 26 queries with expected categories + golden-hit checklist. |

## Patterns to follow

**For both tracks:**
- **Extractor template**: `src/extractors/di/extractor.ts` — pure function over ts-morph `Project`, returns typed result; never throws on parse failures (returns diagnostic entry).
- **Mapper template**: `src/mapper/di-to-graph.ts` — takes extractor output + ownership registry, returns `{ nodes, edges, diagnostics }`.
- **Validation template**: `src/validation/di-validator.ts` — regex over source files for ground-truth, compute recall.
- **Test conventions**: vitest, `*.test.ts` adjacent to source, per-file 95/95/90.
- **Pipeline registration**: `src/pipeline/build.ts` — add `extract → validate → map` triplet block; merge into final `assembleGraph()` call.

**FE-specific:**
- File-extension filtering: `.tsx`/`.jsx` (skip `.ts` in extractor). `allowJs: false` stays; we add `.tsx` via ts-morph already-supported parsing.
- Component detection: `JsxElement | JsxSelfClosingElement` in return type, OR file imports `react` and exports a function/class.
- `React.memo` / `forwardRef` wrappers: unwrap to find inner function; label = the exported name.
- Default export: `getDefaultExportSymbol()`.

**Var 2-specific:**
- Endpoint prefix resolution: handle `@Controller('users')` (StringLiteral) and `@Controller({path: 'users', version: '1'})` (ObjectLiteral with property). Fallback: no prefix.
- Endpoint pattern: `'/'.concat(prefix, '/', methodArg).replace(/\/+/g, '/').replace(/\/$/, '')` — produce canonical path.
- HTTP method: from decorator name (`@Get` → `'GET'`).
- Entity field nullable: `@Column({nullable: true})` (ObjectLiteral) or `@Column('text', {nullable: true})` (mixed).
- Config callsite key: first string literal arg of `configService.get('KEY')` or `configService.getOrThrow('KEY')` or `process.env.KEY` member access (env var = `.KEY` identifier).

## External constraints

- **NodeKind enum** is consumed by MCP server's Zod schema (`NODE_KIND_VALUES` enum) — additions automatically propagate, but contract is locked, **no kind renames allowed**.
- **`semantic build` reuse**: the existing semantic sidecar code is kind-agnostic — new nodes automatically get embeddings without semantic code changes. Snippet extractor (`src/semantic/snippet.ts`) handles `VariableDeclaration`/`FunctionDeclaration`/`ClassDeclaration` — sufficient for new node kinds.
- **Recall floors**:
  - FE extractor: ≥ 90% on canonical patterns (looser than NestJS-canonical 95% because React variant is wider).
  - Endpoint extractor: ≥ 95% (canonical NestJS).
  - db-entity-field: ≥ 95%.
  - Config-field: ≥ 90% (callsite detection has known false-negatives on dynamic key construction).
- **No fabricated node kinds** — every kind we add must have an extractor producing it. The single exception is `scoped-marker` (stub, no extractor) — explicitly documented.
- **Backwards compat**: existing diagnostics report shape (`DiagnosticsReport`) extends with new fields; never breaks existing readers.

## Acceptance Criteria

> Tests-as-AC default: every code task adds unit tests covering happy path + one error branch in the same commit, satisfying per-file 95/95/90 coverage, AND tests pass via `npm test`.

### Track A — FE Level 1

**A1 — Types**
- `src/core/types.ts` declares 4 new NodeKinds and 3 new EdgeKinds.
- `NODE_KIND_CHECK` and `NODE_KIND_VALUES` updated.
- `EDGE_KIND_CHECK` in `src/mcp/server.ts` updated.
- `npm test` green; no type errors.

**A2 — FE extractor**
- `extractFe(cfg, project)` returns `FeExtractResult` with `pages[]`, `components[]`, `hooks[]`, `routes[]` arrays + `diagnostics`.
- Detects: arrow `const X = () => <JSX/>`, function declarations returning JSX, class components extending `React.Component`, `React.memo(...)` and `forwardRef(...)` wrappers, default exports.
- Hooks: function whose name starts with `use[A-Z]` AND body contains a `use*` call.
- Returns `[]` (not throws) on parse failures; failures recorded in diagnostics.
- Coverage 95/95/90 per file.

**A3 — Mapper**
- Produces `fe-page`, `fe-component`, `fe-route`, `fe-hook` nodes with paths.
- Emits `fe-imports` edges (page → component), `fe-renders` edges (component → component composition), `fe-routes-to` edges (route → page).
- Owner attribution via `OwnershipRegistry`; unowned recorded in diagnostics.
- Coverage 95/95/90.

**A4 — Validation**
- `enumerateFeGroundTruth` regex-detects pages (under `pages/` or `app/*/page.tsx`), components (exported JSX-returning), hooks.
- Recall ≥ 90% on the test fixture.
- Strict mode (`--strict` flag in build) fails if recall < 90%.

**A5 — Pipeline integration**
- `runBuild` calls FE extractor + validator + mapper.
- New diagnostics field `fe?: FeDiagnostics` in `DiagnosticsReport` (optional, doesn't break consumers).
- Graph emit includes new nodes/edges.

**A6 — Fixtures**
- `src/__fixtures__/fe-sample/` contains: 1 `pages/` route, 1 `app/` route, 3 components (arrow, function, class), 2 hooks (one custom, one trivial).
- Used by FE extractor tests + mapper tests.

**Track A integration AC** (verified after Phase 5/6):
- `npm test` green.
- `npm run test:integration` green (existing).
- Build platform — new graph has ≥ 200 FE nodes (platform has 4+ FE apps).

### Track B — Variant 2

**B1 — Types**
- 4 new NodeKinds, 4 new EdgeKinds, `scoped` edge kind reserved.
- All CHECK records updated.

**B2 — Endpoint extractor**
- Detects all 9 HTTP method decorators + `@Controller` prefix (string, object form, no-arg).
- Returns `EndpointSite[]` with `method`, `pattern`, `controllerClass`, `methodName`, `location`.
- Pattern is canonical: `/users/:id` style.
- Handles `@Version`, `@HttpCode` as `meta` (stored, not failed).
- Coverage 95/95/90.

**B3 — Endpoint mapper**
- `endpoint:<METHOD> <pattern>` nodes (e.g., `endpoint:GET /users/:id`).
- `endpoint-of` edges → controller class.
- Reuses existing `di-guard/interceptor/pipe` edges by method match (no new edge kind).
- Coverage 95/95/90.

**B4-B5 — db-entity-field**
- Walks each `@Entity`-classed class via existing entity-index, collects `@Column*` decorated properties.
- Field meta: `name` (from decorator or property), `type` (string from decorator arg or TS type), `nullable`.
- `db-entity-field:<table>/<field>` nodes.
- `entity-has-field` edges (db-table → db-entity-field).
- Coverage 95/95/90.

**B6-B7 — Config-field callsite extractor**
- Detects `configService.get<T>('KEY')`, `configService.getOrThrow<T>('KEY')`, `process.env.KEY` (member access).
- `config-field:<KEY>` nodes (one per unique key).
- `config-read-by` edges (config-field → consumer class).
- Coverage 95/95/90.

**B8 — Scoped-marker stub**
- Extractor returns empty `ScopedMarkerSite[]`.
- Test asserts: result.length === 0; diagnostic entry "stub-extractor, awaiting corpus signal" present.
- No mapper, no validator (no nodes produced).
- Documented: `tests: stub-only by AC, scope justified in design doc § 'Real-corpus signal'`.

**B9 — Pipeline integration**
- 4 new extract+validate+map blocks in build.ts.
- 4 new diagnostics fields (`endpoint?`, `config?`, `dbEntityFields?` (or merged into typeorm), `scoped?` reserved no-op).

**B10 — Validators**
- Endpoint: regex over `@(Get|Post|...)` decorators, recall ≥ 95%.
- Config callsite: regex over `configService\.(get|getOrThrow)` + `process\.env\.`, recall ≥ 90%.
- db-entity-field: regex over `@Column` etc., recall ≥ 95%.

**B11 — Fixtures**
- `src/__fixtures__/var2-sample/`: 2 controllers with mixed prefixes/methods, 1 entity with 5 fields, 3 services using configService, 1 file with process.env.

**Track B integration AC**:
- `npm test` green.
- Build platform → graph has ≥ 500 endpoint nodes, ≥ 1000 db-entity-field nodes (from 632/1312 estimates).

### Track C — Verification (after both merge)

**C1 — Eval script**
- `bash scripts/run-baseline-eval.sh` runs:
  1. Build arch-graph on platform, insyra, beribuy 2.0.
  2. Run `semantic build` on each.
  3. Run 26 queries (5 categories: A find / B debug / C UI / E arch / cross-project) per project where applicable.
  4. For each query, parse top-5 JSON output, compare to expected golden-hit list from `scripts/eval/queries.json`.
  5. Emit Markdown table: project × category → hit-rate before/after.
- Exit code 0 if all categories meet baseline-doc expected thresholds; 1 otherwise.
- Output saved to `scripts/eval/results-YYYY-MM-DD.md`.

**C2 — Queries spec**
- `scripts/eval/queries.json`: array of `{query, project, category, expectedAtLeastOne: ["nodeIdGlob", ...], minScore: 0.5}` entries.
- 26 queries total: 9 from baseline + 6 from insyra + 5 from beribuy + 6 new ones probing new node kinds (FE + endpoint).

**Final AC** (gates merge to main):

| Project | Category | Baseline | Expected after | Hard threshold to pass |
|---|---|---|---|---|
| platform | A find | 60% | 80% | ≥ 75% |
| platform | C UI | 30% | 75% | ≥ 65% |
| platform | overall | 60% | 85% | ≥ 75% |
| insyra | overall | 50% | 85% | ≥ 70% |
| beribuy 2.0 | overall | 40% | 70% | ≥ 60% |

If hard threshold not met → Phase 6 fix-iterate before declaring done.

## Open questions / risks

1. **Merge conflict on types.ts**: both tracks add to NodeKind/EdgeKind. Mitigation: text-level merge adds adjacent items; if conflict appears, manual merge (5-min fix) accepted.

2. **FE recall floor 90% (not 95%)**: React patterns are more variable (HOCs, dynamic exports). 90% is the documented floor; can be tightened later if data shows we hit 95% naturally.

3. **endpoint extractor + existing HTTP extractor overlap**: The existing HTTP extractor handles inter-service calls (`httpService.get('http://...')`), endpoint extractor handles route definitions. Different concerns; no overlap. Documented explicitly to prevent confusion.

4. **Sidecar size growth**: 5.5 MB → ~15-18 MB on platform after both tracks. Streaming JSONL handles this fine; no perf concern for v1.

5. **Eval script needs `semantic search --json` to produce stable output**: confirmed in baseline tests — output format is stable.

6. **Stub `scoped-marker` confusion**: a maintainer may add an extractor in the future not realizing it's stub-by-design. Mitigated by explicit comment + design-doc reference in the stub file.

7. **Build time on insyra**: graph grew 299 → 897 from `feat/semantic` already. After both tracks the count likely doubles. `npm run test:integration` will run ≤ 2-3 minutes on a fresh machine, still acceptable.
