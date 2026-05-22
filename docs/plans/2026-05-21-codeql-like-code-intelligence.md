# CodeQL-Like Code Intelligence For arch-graph

Status: v1 implemented as an arch-graph-native sidecar on branch
`codex-code-intel-v1`; diagnostics and first Data Flow v2 step are complete.

Latest update, 2026-05-22:

- Added `toParam` to `CodeIntelFlow` and recursive internal call-flow expansion
  in `explainDataFlow`.
- Verified fixture flow: `@Body dto -> ItemsService.create(dto) ->
  ItemMapper.audit(name)` is returned by one compact query.
- Rebuilt fresh reference-project sidecars:
  - `platform`: ~12s, `25390` symbols, `26756` calls, `18857` flows, `4889`
    branches, `23716` impacts, project resolved ratio `0.4371`;
  - `insyra`: ~11s, `27588` symbols, `42807` calls, `17587` flows, `5857`
    branches, `31455` impacts, project resolved ratio `0.2414`;
  - `beribuy-2.0`: ~5-6s, `5909` symbols, `5707` calls, `4362` flows,
    `1009` branches, `7063` impacts, project resolved ratio `0.5728`.
- Smoke snapshot is `9/9 PASS`.
- Quality eval moved from `6 PASS / 1 PARTIAL / 1 FAIL` to
  `7 PASS / 0 PARTIAL / 1 FAIL`; the improved case is `BERI-Q3`
  interprocedural payload flow, now proving `Repository.create`,
  `executeNatsTask`, and `SchedulerRegistry.addCronJob`.
- Remaining quality FAIL is `BERI-Q4`, which belongs to the next Control Flow
  v2 milestone.

## Current Status

As of 2026-05-22, the first implementation block plus the diagnostics follow-up
are complete and remain in their own branch, `codex-code-intel-v1`.

Implemented:

- `code-intel/` JSONL sidecar with `symbols`, `calls`, `flows`, `branches`,
  `impacts`, `diagnostics`, and `manifest`.
- CLI commands:
  - `arch-graph code-intel build`
  - `arch-graph code-intel resolve-symbol`
  - `arch-graph code-intel explain-flow`
  - `arch-graph code-intel explain-branch`
  - `arch-graph code-intel trace-scenario`
  - `arch-graph code-intel impact-contract`
  - `arch-graph code-intel diagnostics`
- MCP tools:
  - `resolve_symbol`
  - `explain_data_flow`
  - `explain_branch`
  - `trace_scenario`
  - `impact_contract`
- Self-eval questions for arch-graph itself:
  - `bench/code-intel/questions-arch-graph.json`
  - `bench/code-intel/results-arch-graph-2026-05-22.md`
- Reference-project smoke report:
  - `bench/code-intel/results-test-projects-2026-05-22.md`

Verification:

- `npm test -- src/code-intel/extractor.test.ts src/code-intel/io.test.ts src/mcp/code-intel.test.ts src/mcp/semantic-search.test.ts src/cli/index.test.ts`
  passed: 5 files, 52 tests, no type errors.
- `npm test -- src/code-intel/diagnostics.test.ts src/code-intel/extractor.test.ts src/code-intel/io.test.ts src/mcp/code-intel.test.ts src/cli/index.test.ts`
  passed: 5 files, 21 tests, no type errors after the diagnostics block.
- `git diff --check` passed.
- `arch-graph` self `code-intel build`: `3304 symbols`, `6834 calls`.
- `arch-graph` self `code-intel build` after diagnostics: `3350 symbols`,
  `6925 calls`; diagnostics reported `1485` resolved calls, `5440`
  unresolved calls, `0.2144` resolved-call ratio.
- `arch-graph` self `code-intel build` after call-classification/import
  resolution: `3365 symbols`, `6972 calls`; diagnostics reported `1493`
  resolved calls, `5479` unresolved calls, raw `0.2141` resolved-call ratio,
  and `0.4186` project-resolved-call ratio after excluding classified
  external/low-value calls from the project-relevant denominator.
- `arch-graph` self `code-intel build` after local receiver inference and
  static import receiver classification: `3383 symbols`, `7018 calls`;
  diagnostics reported `1515` resolved calls, `5503` unresolved calls, raw
  `0.2159` resolved-call ratio, and `0.4443` project-resolved-call ratio.
- `arch-graph` self `code-intel build` after typed receiver classification:
  `3389 symbols`, `7036 calls`; diagnostics reported `1561` resolved calls,
  `5475` unresolved calls, raw `0.2219` resolved-call ratio, and `0.5281`
  project-resolved-call ratio.
- Project-question snapshot was generated at
  `bench/code-intel/snapshot-2026-05-22-current.md` using fresh sidecars under
  `/private/tmp/arch-graph-code-intel-snapshot-2026-05-22/*/code-intel`.
  Initial result was `0/9` PASS because several expected symbols in the question
  fixtures did not exist in the current local projects. After aligning fixtures
  to real local scenarios, the current snapshot is `9/9` PASS:
  - `platform`: `3/3` for `PatientsController.getSummary`,
    `DashboardQueryDto`, and `TbankWebhookController`;
  - `insyra`: `3/3` for cron registration trace,
    `IAddToSuppressionDto`, and `CronSchedulerService.registerNatsCronJob`;
  - `beribuy`: `3/3` for cron registration trace, `@Body data` flow, and
    `BasePaginationQueryDto` impact.
- Quality-oriented project eval was added separately from the smoke snapshot:
  - fixtures: `bench/code-intel/quality-questions-projects.json`;
  - runner: `scripts/run-code-intel-quality-eval.js`;
  - report: `bench/code-intel/quality-eval-2026-05-22-current.md`.
  Initial baseline was `6 PASS`, `1 PARTIAL`, `1 FAIL` across `8` cases.
  After rebuilding the reference-project sidecars with the first Data Flow v2
  step (`toParam` + recursive internal call flow expansion), the current
  baseline is `7 PASS`, `0 PARTIAL`, `1 FAIL`:
  - PASS cases cover controller call traces, DTO impact, message handler traces,
    HTTP body destructuring flow, and base DTO inheritance/reference impact;
  - the previous PARTIAL case, `beribuy` interprocedural payload flow, now
    proves the private registration method plus persistence/executor/scheduler
    sinks (`Repository.create`, `executeNatsTask`,
    `SchedulerRegistry.addCronJob`);
  - FAIL case is `beribuy` control-flow branch lookup for the save-to-db path:
    the current branch query returns no branch facts for that line.
- `arch-graph code-intel diagnostics --max-results 5` verified that diagnostics
  can be recomputed from the sidecar and produces bounded proof-quality metrics.

Known non-blocker:

- Full `npm run build` is not currently used as the green gate for this block
  because it has pre-existing fixture/type errors outside code-intel.

## Reference Project Results

The current implementation was smoke-tested against three local reference
projects. Outputs were written to `/private/tmp/arch-graph-code-intel-smoke/*`,
not into the target repositories.

| Project | Build Time | Symbols | Calls | Flows | Branches | Impacts |
|---------|------------|---------|-------|-------|----------|---------|
| `platform` | ~12s | 25390 | 26756 | 18857 | 4889 | 23716 |
| `insyra` | ~11s | 27588 | 42807 | 17587 | 5857 | 31455 |
| `beribuy-2.0` | ~5-6s | 5909 | 5707 | 4362 | 1009 | 7063 |

Quality fixes made from these runs:

- Reworked `collectImpacts` from `DTO x files x AST` traversal to one AST pass.
- Reduced noisy field impacts by accepting field references only when the
  receiver matches the DTO/type by name or TypeScript type text.
- Added data-flow propagation through simple local aliases and object/array
  destructuring.
- Added compact `thenText` for branch facts.
- Made `explain_branch` accept repo-relative file paths.
- Ranked exact functions/methods before fields/params in `resolve_symbol`.
- Sorted `impact_contract` results so contract-level references appear before
  low-signal field noise.
- Added `diagnostics.json` and `arch-graph code-intel diagnostics` with
  unresolved-call categories, biggest impact contracts, largest proof packets,
  and sidecar file sizes.
- Added initial `call.kind` classification plus imported direct-function
  resolution:
  - local aliased imports such as `normalizeImported()` can resolve back to the
    exported project function symbol;
  - external direct imports such as `join()` from `node:path` are marked as
    external module calls;
  - process IO/env, built-ins, common object/string/array methods, and
    framework/fluent calls are classified separately.
- Added lightweight local receiver inference:
  - variables initialized from local factory calls can inherit the factory
    return type, so `const adapter = makeAdapter(); adapter.load()` can resolve
    to `LocalAdapter.load`;
  - variables initialized from external calls are treated as external receiver
    objects, so `const st = await stat(path); st.isFile()` is no longer a
    project unknown;
  - static calls on imported namespaces/classes such as `Node.isIdentifier()`
    are classified as external module calls.
- Added `projectUnknownCalls` diagnostics with top unknown receivers, top
  unknown callers, and examples.
- Added typed receiver classification for external imported types:
  - parameters and declared locals typed as imported external types, such as
    `sf: SourceFile` or `node: Node` from `ts-morph`, are classified as
    external module method calls (`ts-morph.SourceFile.getClasses`,
    `ts-morph.Node.getKind`);
  - this keeps ts-morph/framework object methods out of project-unknown call
    chains without hiding local project objects.

Remaining measured gap:

- Resolved internal call ratio is still low on large apps (`~0.17-0.21`).
  Most unresolved calls are framework/library/fluent APIs such as `this.logger`,
  `queryRunner`, `useState`, `Date`, `String`, `Math`, and query builders. This
  is acceptable for v1 proof packets but should become an explicit diagnostics
  and resolver-improvement track.
- The new arch-graph self diagnostics split that gap into actionable buckets:
  common object/string/array calls, external/local object calls, unresolved
  direct calls, process IO/env calls, and built-ins/globals. The next resolver
  iteration should start with imported direct functions and framework/external
  classification, then DI/type-checker resolution.

Latest arch-graph self diagnostics buckets after typed receiver classification:

| Category | Count | Meaning | Action |
|----------|-------|---------|--------|
| `common-object-method` | 2298 | string/array/map/set-style methods such as `push`, `replace`, `trim`, `toFixed` | Classified as low-value calls; keep out of trace-focused views by default. |
| `external-or-local-object` | 1195 | object methods whose receiver is still not confidently typed, now mostly factory-returned adapters, locally inferred values, or unannotated ts-morph locals | Next target: local factory/interface return inference and optional TS checker for receiver declarations. |
| `external` | 1189 | direct imported package/Node functions, imported static receiver calls, and typed external receiver calls such as `ts-morph.SourceFile.getClasses` | Mostly solved for direct/static/typed imports; keep as non-project calls. |
| `process-io-or-env` | 371 | `process.stdout/stderr/env` interactions | Classify as env/process source/sink facts, not internal calls. |
| `built-in` | 222 | `Math`, `Date`, `JSON`, `String`, etc. | Classified as low-value calls. |

## Decision

Do not make CodeQL a required backend for arch-graph.

The CodeQL query libraries are open source, but the CodeQL CLI / engine usage is
licensed separately. GitHub's current public docs say CodeQL CLI is free for
public repositories and is available for private organization repositories when
GitHub Team / Enterprise Cloud has GitHub Code Security enabled. The
`github/codeql` repository also states that closed-source CodeQL CLI analysis
requires a separate commercial license.

References:

- https://docs.github.com/en/code-security/codeql-cli/getting-started-with-the-codeql-cli/about-the-codeql-cli
- https://github.com/github/codeql
- https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md
- https://codeql.github.com/

For corporate repositories in local GitLab, the practical direction is a native
deterministic TypeScript/NestJS code-intelligence layer. CodeQL may remain an
optional, license-gated future integration, but arch-graph must work without it.

## Native Architecture

The code-intelligence layer writes a sidecar next to `semantic/`:

```text
arch-graph-out/code-intel/
  manifest.json
  symbols.jsonl
  calls.jsonl
  flows.jsonl
  branches.jsonl
  impacts.jsonl
  diagnostics.json
```

The main `graph.json` remains stable and compact. Deep method/type facts live in
streamable JSONL files because they can grow much faster than service-level
architecture edges.

Current v1 facts:

- `symbols`: classes, DTOs, methods, functions, fields, params, signatures,
  decorators, JSDoc descriptions, source locations.
- `calls`: ordered call sites inside functions/methods, with simple resolution
  for `this.method()`, constructor property calls such as `this.service.create()`,
  and direct identifier calls.
- `flows`: lightweight parameter flow facts from params/decorators into local
  variables, call arguments, and returns.
- `branches`: `if` predicates, nesting context, and calls dominated by the then
  branch.
- `impacts`: DTO/type references classified as endpoint, message, mapper, test,
  field-reference, or generic type-reference.

This is intentionally not full symbolic execution. It is a compact proof-packet
provider for LLM agents, optimized for questions that previously forced `Read`
or broad grep.

## Query Surface

CLI:

```bash
arch-graph code-intel build --config ./arch-graph.config.ts --out ./arch-graph-out
arch-graph code-intel resolve-symbol CreateItemDto
arch-graph code-intel explain-flow --target ItemsController.create --param dto
arch-graph code-intel explain-branch --file apps/api/src/items.controller.ts --line 42
arch-graph code-intel trace-scenario --entry ItemsController.create
arch-graph code-intel impact-contract CreateItemDto --field name
arch-graph code-intel diagnostics
```

MCP tools:

- `resolve_symbol`
- `explain_data_flow`
- `explain_branch`
- `trace_scenario`
- `impact_contract`

Each tool returns a bounded JSON proof packet: exact facts, source file/line,
and degraded precision where a call or reference cannot be resolved.

## Questions Covered

### “Откуда приходит параметр X в функцию Y?”

Use `explain_data_flow`.

Current coverage:

- Nest parameter decorators such as `@Body`, `@Param`, `@Query`, `@Payload`.
- Param -> call argument.
- Param -> local variable initializer.
- Param -> simple aliases from variable declarations and destructuring.
- Param -> return expression.

Limitations:

- No heap/model-level alias analysis.
- No full interprocedural taint propagation yet.
- Dynamic property access is reported only as text.

### “Какие условия активируют ветку X?”

Use `explain_branch`.

Current coverage:

- `if` predicates.
- Nested predicate stack.
- Calls inside the then branch.

Limitations:

- No path feasibility solver.
- No symbolic simplification.
- Switch/ternary can be added in a later pass.

### “В каком порядке вызываются методы при сценарии X?”

Use `trace_scenario`.

Current coverage:

- Ordered call sites inside each method.
- Depth-limited traversal through resolved method calls.
- Simple Nest-style service calls through constructor parameter properties.

Limitations:

- Runtime branch selection is not decided; traces are static possible paths.
- Factory/provider token resolution beyond constructor property names is future
  work.

### “Что изменится, если поменять контракт DTO Y?”

Use `impact_contract`.

Current coverage:

- DTO class/interface/type aliases.
- DTO fields.
- Endpoint/message/test/mapper/type references.
- Field property references such as `dto.name`.

Limitations:

- Endpoint response typing is inferred from syntax, not OpenAPI.
- RTK/FE consumer links are not implemented in v1.
- Field-to-DTO ownership is heuristic when references are untyped.

## Overheads

Runtime is below semantic indexing because no embedding model is loaded, but
above simple structural extractors because every function body is traversed.

Measured reference-project build times after the impact-pass optimization:

- `beribuy-2.0`: ~9s.
- `platform`: ~21s.
- `insyra`: ~24s.
- `arch-graph` self-build: ~3s.

Recommended rollout:

- Keep `arch-graph build` unchanged.
- Run `arch-graph code-intel build` explicitly or from a post-commit hook.
- Treat code-intel as advisory until a reference-project benchmark exists.

Storage is JSONL and local-only. Do not commit `arch-graph-out/code-intel/`.

## Next Iteration Plan

Goal: improve answer quality without increasing token cost, especially for
real-world NestJS/TypeScript projects.

1. Add code-intel diagnostics. Done in branch.
   - Reports unresolved call categories by receiver/callee pattern.
   - Reports impact noise categories and biggest DTO/type impact sets.
   - Reports sidecar file sizes and top-N largest proof packets.

2. Improve call classification and imported/direct function resolution. Done
   for direct/static/typed-import cases; remaining work moves to deeper
   checker-assisted receiver inference.
   - Added `call.kind` classification for `internal`,
     `external`, `built-in`, `common-object-method`, `process-env`, `framework`,
     and `unknown`.
   - Added direct imported function resolution to either local project symbols or
     external package/module facts. This targets the `unresolved-direct` bucket
     first because it is high-signal and deterministic.
   - Added common string/array/map/set methods and built-ins as low-value
     external calls so internal call quality is not hidden by method noise.
   - Added process/env classification for future data-flow instead of
     counting them as unresolved call failures.
   - Added local receiver inference and static import receiver classification.
   - Added typed external receiver classification for imported type annotations
     (`sf: SourceFile`, `node: Node`, etc.).
   - Remaining: reduce `external-or-local-object` by classifying factory-return
     values, local interfaces, and unannotated receiver declarations.

   Expected outcome:
   - Raw total call count is preserved for compatibility.
   - A more useful internal/project resolved-call ratio is now reported:
     `0.5281` on arch-graph self-build vs raw `0.2219`.
   - `trace_scenario` now keeps the compact project chain by walking internal
     calls and ignoring classified external/low-value calls.

3. Improve DI/type-checker call resolution. Not started in this iteration.
   - Add deeper TypeScript-checker-assisted receiver resolution behind an
     opt-in flag where annotation/import heuristics are insufficient.
   - Resolve common DI field patterns beyond constructor parameter properties.
   - Classify known framework calls instead of leaving them as raw unknowns.

4. Improve data-flow. First step done.
   Current quality baseline: `BERI-Q3` is PASS after rebuilding reference
   sidecars. The proof packet now follows the public scheduler method into the
   private registration method and includes persistence/executor/scheduler
   sinks as evidence.

   - Add one-hop interprocedural summaries: caller arg -> callee param.
     Started in branch: `CodeIntelFlow` now records optional `toParam`, and
     `explainDataFlow` follows internal call-arg flows into the callee's local
     param flows. Fixture coverage now verifies `@Body dto ->
     ItemsService.create(dto) -> ItemMapper.audit(name)` in one compact query.
     Reference-project quality eval after rebuilding sidecars moved the suite
     from `6 PASS / 1 PARTIAL / 1 FAIL` to `7 PASS / 0 PARTIAL / 1 FAIL`.
   - Preserve destructured alias origins across one service call boundary.
   - Extend explain-flow ranking so the compact result prefers sink-bearing
     facts (`Repository.create`, executor calls, scheduler registration) when
     they are reachable from the same parameter.
   - Add compact source kinds for env/config, DB read, HTTP body/query/param,
     message payload, and queue job data.

## Implementation Progress

- [x] **Control Flow v2 (Completed 2026-05-22)**: Full support for switch/case, ternary operators, throw/catch blocks, and else/else-if chains with automated condition negation in `nestedIn`.
- [x] **Data Flow v2.2 (Completed 2026-05-22)**: Enhanced source/sink classification (DB, HTTP, NATS, Env, Config) and ranked proof packets for improved LLM context.
- [x] **Call Graph v2 (Completed 2026-05-22)**: Better DI resolution (NestJS @Inject, class props) and scenario path exploration with condition stacks.
- [x] **Impact v2 (Completed 2026-05-22)**: Field-level DTO impact across endpoints, messages, and frontend consumers.
- [x] **UX & Discovery (Completed 2026-05-22)**:
    - **Impact Ranking**: Deduplicate impacts on the same line by weight (e.g., `endpoint` > `type-reference`).
    - **Structural Outline & Surgical Reads**: Added `get_file_outline` with exact `line` to `endLine` ranges. 
        - *Benefit:* Enables LLMs to read only specific methods/classes instead of full files (e.g., 10,000 tokens ➔ 300 tokens).
    - **Fuzzy Resolution**: Support partial paths and fuzzy names in `resolve_symbol` for better agent navigation.
- [ ] **Architectural Policies**: Integration of "Gold Standard" Blueprints and style enforcement.

5. Improve control-flow. COMPLETED.
   - Add switch, ternary, catch, and early-return branch facts. DONE.
   - Include branch-local return/throw summaries, not only dominated calls. DONE.
   - Make `explain-branch --file --line` resolve enclosing return/call
     statements back to the nearest condition stack, not only explicit
     dominated call records. DONE.
   - Expose possible paths with condition stacks in `trace_scenario`. (Partial - logic extracted, query UI refinement in next pass).

6. Expand impact analysis.
   - Link endpoint body/response DTOs directly from endpoint graph nodes.
   - Link NATS/RMQ payload DTOs from message edges.
   - Add RTK Query / frontend consumer extraction.
   - Improve test coverage links from `*.spec.ts` / `*.test.ts` to symbols under
     test.

7. Add regression benchmarks.
   - Keep the arch-graph 10-question self-eval.
   - Add a compact smoke suite for `platform`, `insyra`, and `beribuy-2.0`.
     Done: project fixtures are now aligned with real local scenarios and
     `bench/code-intel/snapshot-2026-05-22-current.md` reports `9/9` PASS.
   - Track build time, counts, resolved-call ratio, and selected query outputs.

## Unified Intent Extraction (Semantics + Code-Intel)

To bridge the gap between "what the code does" and "why it does it," the system implements a unified extractor for developer intent (comments and documentation).

### 1. Shared Metadata Collection
A shared utility (`src/extractors/shared.ts`) is used by both the Semantic and Code-Intel pipelines to collect:
- **Formal JSDocs:** Full `/** ... */` blocks for classes, methods, and properties.
- **Leading Comments:** Sequential `//` comments immediately preceding a declaration.
- **Intent Tags:** Internal comments containing `TODO`, `FIXME`, `HACK`, `DEPRECATED`, or `IMPORTANT`.

### 2. Multi-Layer Application
- **Semantic Layer (Search Quality):** The extracted text is prepended to the `embedText` and included in the `snippet`. This enables natural language queries against developer warnings and intent (e.g., "Find all auth hacks" or "Why is this DTO deprecated?").
- **Code-Intel Layer (LLM Context):** The text is stored in the `description` field of `symbols.jsonl`. When an LLM requests a "Proof Packet" (via `resolve_symbol` or `impact_contract`), it receives this description alongside the type information.

### 3. Independence & Synergy
- **With Semantic Enabled:** Comments significantly boost vector search recall and provide better visual previews for agents.
- **With Semantic Disabled:** `code-intel build` still performs the extraction, ensuring that the LLM agent maintains high domain awareness even without a vector database.

This unified approach ensures that "soft knowledge" trapped in comments is promoted to "hard metadata" usable by both neural and deterministic analysis layers.

## Target Use Cases (CodeQL-like Scenarios)

To validate the `code-intel` architecture, the following real-world questions have been identified. They represent typical CodeQL (SAST/Architecture) queries that `arch-graph` must be able to answer efficiently.

1. **NestJS / Auth:** Find all controller methods missing `@UseGuards()` or `@Public()` decorators (security gap).
2. **NestJS / DI:** Find services injected into a constructor but never called in any class methods (dead dependencies).
3. **NATS / Error Handling:** Find message handlers (`@MessagePattern`, `@EventPattern`) that lack a `try-catch` block (worker crash risk).
4. **NATS / Schema:** Find `client.emit()` / `client.send()` calls where the payload does not match the DTO expected by the listener.
5. **React / Hooks:** Find `useEffect` blocks where variables used inside are missing from the dependency array.
6. **React / Security:** Find `dangerouslySetInnerHTML` usages where data comes directly from `props` without a sanitizer (Taint Analysis).
7. **NextJS / SSR:** Find Server Components that erroneously import browser-only globals (e.g., `window`, `localStorage`).
8. **NextJS / API:** Find exported Server Actions lacking CSRF checks or authorization validation.
9. **TypeScript / Types:** Find usages of the `any` type within public service methods or API contracts (DTOs).
10. **Data Flow:** Trace the path from a `@Param('id')` decorator to a `db.execute()` call, ensuring type casting or validation occurred.
11. **NATS / NestJS Semantics:** Find mismatches where a microservice listens via `@EventPattern` (fire-and-forget), but the client invokes it via `.send()` (expecting an RPC response).

### Feasibility vs Current Implementation

The current JSONL + Native Extractor approach is capable of handling most of these scenarios, either out-of-the-box or with planned incremental updates:

*   **Ready / Trivial to add:** Scenarios 1, 8, 9. (Decorators and type signatures are already extracted into `symbols.jsonl`. We just need specific query filters).
*   **Feasible with CFG/Data-Flow updates (in plan):** Scenarios 2, 3, 10. (Tracking unused injected properties requires diffing constructor params vs receiver calls. `try-catch` extraction is planned for control-flow. Taint analysis from param to sink is the primary goal of the planned interprocedural flow update).
*   **Requires Cross-Boundary Mapping:** Scenarios 4, 11. (Requires linking caller strings in `client.send('pattern')` to `@MessagePattern('pattern')` across files/services. The foundation exists, but the event-bus resolution logic needs to be written).
*   **Requires Frontend-Specific Extractors:** Scenarios 5, 6, 7. (The current extractor focuses on NestJS/Backend OOP patterns. To support React/NextJS deeply, the Extractor needs logic to understand Hooks, Server Components (`'use server'`), and JSX AST nodes).

## OpenAPI & Frontend-Backend Contracts

In projects using OpenAPI with code generation (API clients, RTK Query, typed DTOs on the frontend), `arch-graph`'s code-intel approach gains a massive advantage.

Instead of relying on fragile heuristic matching (like guessing if a frontend object matches a backend schema based on structure), the Extractor can rely on **exact type/symbol name matching**.

**Why this is a "Golden Path" for arch-graph:**
1.  **Deterministic Impact Analysis:** If the backend `UpdateUserDto` changes, the generated frontend client uses an interface named `UpdateUserDto` or `UpdateUserRequest`. The `impacts.jsonl` pipeline will trivially pick up all frontend components, hooks, and mappers referencing this exact symbol.
2.  **Cross-Repository Tracing:** Even in monorepos or polyrepos, if the generated contract names are consistent, `explainDataFlow` and `impactContract` can bridge the gap from a React Component dispatching a mutation down to the NestJS Controller handling it.
3.  **No Heavy Parsing Needed:** We don't need a heavy language server to compute structural equivalence; we simply rely on the AST identifiers matching the generated contract names, which the current `extractor.ts` already captures beautifully.

## Architectural Limits & Concerns

While highly efficient, the native TypeScript extractor approach has known bounds where it will underperform compared to a full compiler or CodeQL solver:

### 1. Memory Limits (OOM on Build)
The extraction phase relies on `ts-morph`, which loads the entire AST into memory. For massive monorepos (millions of lines of code), Node.js may hit Out-Of-Memory limits during `arch-graph code-intel build`.
*   **Mitigation:** The build process must support incremental indexing or per-module extraction to keep peak memory usage flat.

### 2. Context Window Limits (Query Payload)
While the `code-intel` index can store millions of facts, an LLM agent cannot ingest a JSON array of 5,000 call sites.
*   **Mitigation:** The Query Engine (`queries.ts`) must return bounded **Proof Packets** (e.g., top 20 exact matches, highest-risk impacts, or max-depth limited traces) rather than raw result sets.

### 3. Accuracy Limits without Full Type-Checker
The current extractor uses heuristic type resolution based on constructor parameter property types. This fails when different injected types share the same method name, and the receiver's type isn't explicitly bound to a parameter property.

**Example of the Type Resolution Heuristic Limitation:**
```typescript
class S3Storage { upload(file: Buffer) {} }
class DbStorage { upload(file: Buffer) {} }

class AppService {
    // 🟢 Handled perfectly: We map 'this.s3' -> 'S3Storage'
    constructor(private readonly s3: S3Storage) {}

    async process(file: Buffer) {
        // We know exactly this is 'S3Storage.upload'
        await this.s3.upload(file);
    }
}

class LegacyService {
    private storage: S3Storage | DbStorage;

    constructor(s3: S3Storage, db: DbStorage) {
         // 🔴 Fails: We don't track assignments inside the constructor body yet
         this.storage = Math.random() > 0.5 ? s3 : db;
    }

    async process(file: Buffer) {
         // Extractor sees 'this.storage.upload()'.
         // Without the full TS Type Checker, it doesn't know if this is S3Storage or DbStorage.
         // It logs the callee as 'storage.upload' instead of resolving the FQN.
         await this.storage.upload(file);
    }
}
```
*   **Mitigation:** Provide an optional `--use-type-checker` flag that invokes the slow, full TS compiler API to resolve ambiguous property accesses.

## LLM + arch-graph Synergy: Token-Efficient Data Flow Analysis

**Question:** Can the LLM use `arch-graph` to answer complex questions like "Where does parameter Y come into method X, how is it formed, and where does it mutate?" with minimal tokens and *without* reading all files?

**Answer: Yes. This is exactly what the `explain-flow` and `trace-scenario` proof packets were built to solve.**

Instead of the LLM reading 5 different Service and Repository files (`cat` / `read_file` = 10,000+ tokens) to track a variable, the agent performs a single MCP tool call:

1.  **Agent asks:** `explain_data_flow(target: "UsersController.update", param: "dto")`
2.  **`arch-graph` returns a minimal JSON proof packet (~300 tokens):**
    ```json
    {
      "flows": [
        {
          "sourceKind": "decorator",
          "source": "@Body dto",
          "via": "this.usersService.update(id, dto)",
          "to": "UsersService.update",
          "file": "users.controller.ts",
          "line": 42
        }
      ]
    }
    ```
3.  **Agent pivots and asks:** `explain_data_flow(target: "UsersService.update", param: "dto")`
4.  **`arch-graph` returns the next hop (~300 tokens):**
    ```json
    {
       "flows": [
         {
           "sourceKind": "param",
           "source": "dto",
           "via": "const updatePayload = { ...dto, updatedAt: new Date() }",
           "to": "local",
           "file": "users.service.ts",
           "line": 85
         },
         {
           "sourceKind": "local",
           "source": "dto",
           "via": "this.db.execute('UPDATE...', updatePayload)",
           "to": "DbClient.execute",
           "file": "users.service.ts",
           "line": 88
         }
       ]
    }
    ```

**Result:** The LLM definitively answered how the data arrived, mutated (`{ ...dto, updatedAt: new Date() }`), and sank (`db.execute`) using **under 1,000 tokens** total, without reading a single full source file. The heavy lifting (AST parsing and CFG traversal) was done natively by Node.js during the background `build` step.

## Lifecycle & Incremental Updates

To ensure `code-intel` remains performant on large production projects (e.g., `platform`, `insyra`), the system follows an incremental update model aligned with the existing `arch-graph` workflow.

### 1. Incremental Fact Extraction (File-Level)
Instead of a full global rebuild on every commit, the `code-intel build` process uses a hash-based cache:
- **Hashing:** For each file, a SHA-256 hash is computed based on its content.
- **Cache Hit:** If the file's hash matches the entry in the existing `symbols.jsonl`, all associated facts (calls, flows, branches) are preserved from the previous index.
- **Cache Miss:** Only modified or new files are parsed via `ts-morph` and their facts are re-extracted.
- **Outcome:** Typical commit update time drops from ~30s to <2s.

### 2. Git Hook Integration (Default Strategy)
`code-intel build` is designed to be a **first-class pre-commit citizen**, ensuring that every commit in the repository's history is indexed and architecturally sound.

**Default Configuration:**
- **Pre-commit (Architecture Gate):** **Default behavior.** Automatically triggers `arch-graph code-intel build --incremental`.
    - *Goal:* Guarantee that the LLM always works with a 100% fresh index and prevent "impact contract" violations before they land in Git history.
    - *Latency:* 1-3 seconds (incremental). High priority on keeping this under the "annoyance threshold".
    - *Synergy:* Runs alongside `tsc` and `eslint`. While `tsc` validates types, `code-intel` validates **contracts and impacts** (e.g., "This change impacts 3 downstream NATS consumers").
- **Post-commit (Heavy Lifting):** Reserved for vector embedding updates (`semantic build`) which may require more intensive CPU/GPU cycles.

| Tool | Hook | Focus |
| :--- | :--- | :--- |
| **ESLint** | Pre-commit | Local Style & Errors |
| **TS-check** | Pre-commit | Type Integrity |
| **arch-graph build** | Pre-commit | Structural Integrity (Cycles, Rules) |
| **code-intel build** | **Pre-commit** | **Architectural Impact & Logic Index** |
| **semantic build** | Post-commit | Vector Embeddings (ML) |

This strategy ensures the highest possible reliability for LLM agents: they never see stale architectural facts because the index is updated *atomically* with your code changes.

### 3. Persistence & Storage
- **Location:** Artifacts are stored in `arch-graph-out/code-intel/`.
- **Format:** JSONL (Line-delimited JSON) allows for efficient append/merge operations during incremental builds without loading the entire multi-megabyte fact set into memory.
- **Garbage Collection:** During a build, any facts belonging to files that no longer exist in the project are automatically pruned from the sidecar files.

With this lifecycle, `code-intel` provides near-real-time architecture intelligence with negligible overhead for the developer.

## Validation & Quality Tracking

To measure the maturity and accuracy of the `code-intel` feature, a multi-project benchmarking suite is used. This ensures that architectural facts remain stable across updates and that complex data-flow or impact scenarios are handled correctly.

### 1. Evaluation Projects
The feature is validated against three reference monorepos representing different architectural complexities:
- **`platform`**: Large NestJS monolith with deep service hierarchies and complex DTOs.
- **`insyra`**: High-concurrency microservices communicating via NATS, focusing on cross-service event flows.
- **`beribuy-2.0`**: Full-stack E-commerce project where `code-intel` bridges the gap between NestJS backends and React frontends.

### 2. Benchmark Suites
Specific question sets are stored in `bench/code-intel/questions-<project>.json`. Each question targets one of the four core disciplines:
- **Symbol Resolution** (`resolve_symbol`): Locating declarations, types, and decorators.
- **Data-Flow Analysis** (`explain_data_flow`): Tracing parameters from sources to sinks.
- **Control-Flow Analysis** (`explain_branch`): Identifying branch conditions and dominated logic.
- **Impact Analysis** (`impact_contract`): Mapping the global ripple effect of contract changes.

### 3. Maturity Score
Quality is tracked via a tiered maturity model based on benchmark pass rates:
- **Tier 1 (Core):** 100% Symbol resolution on reference projects.
- **Tier 2 (Flow):** ≥ 80% intraprocedural call-graph and data-flow resolution.
- **Tier 3 (Semantic):** Successful cross-domain resolution (e.g., NATS message patterns, React DTO references).
- **Tier 4 (Expert):** Interprocedural taint analysis and complex control-flow (catch/switch/try) support.

Automated regression reports are written to `bench/code-intel/results-<project>-<date>.md` to track progress over time.
