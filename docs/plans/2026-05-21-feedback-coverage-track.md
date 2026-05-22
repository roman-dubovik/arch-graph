# Feedback Coverage Track

Date: 2026-05-21
Status: active track
Latest implementation commits:

- `749b940 feat: cover rmq and graph feedback gaps`
- `7ffb3e6 feat: enhance RMQ and DI extraction, add semantic search quotas and boosts`
- `17007f8 feat: cover nats aliases and fe diagnostics`
- `b77a315 feat: resolve inherited nats command subjects`
- `93d74e1 docs: document nats command resolution`
- pending: CodeQL-like analysis track

## Goal

Close the feedback gaps where arch-graph either missed real project architecture
or represented it with misleading semantics. The priority is practical recall:
custom NestJS/RabbitMQ decorators, TypeORM relation truth, DI provider
dependencies, local-only graph artifacts, and more reliable semantic retrieval.

## Non-goals

- Do not commit generated `arch-graph-out/` artifacts into consumer projects.
- Do not pretend RMQ is NATS. RabbitMQ patterns must be a separate graph domain.
- Do not build a full CodeQL clone inside arch-graph.
- Do not infer runtime-only facts when static evidence is missing.

## Track Principles

1. Prefer explicit configuration over guessing project-specific wrappers.
2. Emit honest diagnostics for unresolved/dynamic cases.
3. Keep graph artifacts local by default; commit only config/instructions.
4. Add graph schema fields only when downstream agents can use them directly.
5. Use heavier static-analysis engines only as optional future backends.

## Block 1: Consumer Repo Install/Init Policy

Status: implemented in `749b940`.

### What changed

- `pre-commit` validates `arch-graph build --quiet` for staged TypeScript changes.
- `pre-commit` no longer stages `arch-graph-out/graph.json`, diagnostics,
  validation, Mermaid, or semantic sidecar files.
- `arch-graph-out/` remains local generated output and should be ignored by the
  consuming repo.
- README/init wording now says config and Claude instructions are committed,
  generated graph output is local.

### Acceptance Criteria

- Running `arch-graph hook install` installs a pre-commit hook with no `git add`.
- Hook blocks commits on real build errors.
- Hook does not mutate the git index except by normal user staging.
- README and init prompt do not claim graph artifacts are committed.

## Block 2: RMQ / RabbitMQ Decorator Coverage

Status: implemented in `749b940`.

### What changed

- Added config:

```ts
export default {
  rmq: {
    subscribeDecorators: ['RmqEventPattern'],
  },
};
```

- Added `rmq-pattern` node kind.
- Added `rmq-subscribe` edge kind.
- `RmqEventPattern` is represented as RabbitMQ/RMQ, not as `nats-subject`.
- Mermaid/MCP/snippet-recall schema paths know the new node/edge kinds.

### Acceptance Criteria

- `@RmqEventPattern(SomeEnum.Event)` resolves literal enum/string patterns.
- RMQ nodes have ids like `rmq:order.created`.
- RMQ subscribe edges point `rmq:<pattern> -> service:<owner>`.
- NATS tools remain NATS-only.

### Follow-up Status

- Implemented: payload DTO extraction for handler method parameters.
- Remaining: add project corpus validation once at least one real RMQ repo is available.

## Block 2.5: NATS Decorator Alias Coverage

Status: implemented in `17007f8`; inherited command resolution in progress.

### What changed

- Added `nats.subscribeDecorators` to `ArchGraphConfig`.
- Custom NATS decorators such as `NatsMessagePattern` are merged with the
  built-in `MessagePattern` / `EventPattern` scan set.
- Configured custom decorators emit `nats-subscribe` edges. Standard
  `MessagePattern` keeps its existing `nats-reply` semantics.

### Acceptance Criteria

- `nats: { subscribeDecorators: ['NatsMessagePattern'] }` validates.
- `@NatsMessagePattern('ROLL_FORWARD_ENGAGEMENT')` creates a `nats-subscribe`
  site with `via: '@NatsMessagePattern'`.
- Unconfigured custom decorators are ignored rather than guessed.
- RMQ decorators remain in the RMQ domain.

### Follow-up Status

- Implemented: Nest command object subjects, e.g.
  `client.send({ cmd: EAuditServiceCmd.CREATE_ENGAGEMENT }, payload)`.
- Implemented: `this.somePattern` / `this.someCmd` class-property subjects.
- Implemented: base-class calls like `this.client.send(this.getEntitiesCmd, ...)`
  are expanded through subclass overrides when the override has a static
  initializer.
- Remaining: run on target-monorepo and confirm NATS unresolved drops from 31.

## Block 3: TypeORM Relation Fidelity

Status: implemented in `749b940`.

### What changed

- `db-relation.meta.type` is normalized to one of:
  `ManyToOne`, `OneToMany`, `OneToOne`, `ManyToMany`.
- `db-relation.meta.isOwnerSide` is emitted.
- `OneToMany` is no longer dropped; it is emitted as inverse side with
  `isOwnerSide: false`.
- Extracts `inverseProperty` from relation callbacks like
  `(order) => order.user`.
- Extracts selected DB-relevant options:
  `onDelete`, `onUpdate`, `nullable`.
- Explicit `@JoinTable({ name })` tables are represented as `db-table` nodes.

### Acceptance Criteria

- `ManyToOne` edges are owner-side.
- `OneToMany` edges are inverse-side and visible in graph traversal.
- `OneToOne` owner side is based on `@JoinColumn`.
- `ManyToMany` owner side is based on `@JoinTable`.
- Explicit join table names become nodes.
- Generated join table names are not guessed.

### Remaining Limitation

Auto-generated TypeORM join table names depend on naming strategy/runtime
configuration. The graph should continue to avoid guessing them unless the
project supplies enough static configuration to make the name deterministic.

## Block 4: DI Provider Usage Edges

Status: implemented in `749b940`.

### What changed

- Constructor injection is extracted as `DiProviderUseSite`.
- Mapper emits `di-uses` edges only when both source and target providers are
  already present in the DI graph.
- This avoids phantom `provider:*` nodes for classes not registered in modules.

### Acceptance Criteria

- `class OrdersService { constructor(users: UsersService) {} }` emits
  `provider:OrdersService -> provider:UsersService` when both are registered.
- Unregistered constructor types do not create graph nodes.
- Existing `di-provides`, `di-exports`, `di-controller`, guard/interceptor/pipe
  edges keep their behavior.

### Follow-up Status

- Implemented: `@Inject(TOKEN)` constructor parameters as token `di-uses` edges when the token provider exists.
- Implemented: diagnostics for skipped constructor dependencies where source/target provider is not in the DI graph.

## Block 5: Semantic Retrieval Quality

Status: closed.

### What changed

- Search ranking now combines dense cosine ranking with lexical BM25 ranking.
- Results are fused with Reciprocal Rank Fusion.
- This helps exact symbol/decorator/table names such as `RmqEventPattern`,
  `ManyToOneWithIndex`, table names, or config keys.

### Acceptance Criteria

- Dense-only behavior still works when lexical match is absent.
- Exact lexical hits can rise above near-tied dense hits.
- No index schema change required.
- Existing MCP/CLI response contract remains unchanged.

### Follow-up Status

- Implemented: per-kind quota/boost controls in semantic search and MCP semantic handler.
- Implemented: `code_search` and `docs_search` expose the same ranking controls
  as `semantic_search` (`minScore`, `kindQuotas`, `kindBoosts`) while still
  hiding `kinds` / `excludeKinds`; bucket filters remain factory-owned.
- Evaluated on the 2026-05-21 three-project benchmark with `e5-base`:
  `both-buckets` and `fallback` both reached 76/108 HITs (70.4%); `fallback`
  used fewer calls (141 vs 216). `per-category` reached 69/108 (63.9%).
- Decision: do not add default preset quotas for `code_search` / `docs_search`
  yet. The current misses are dominated by extractor coverage, FE validation
  ground-truth noise, and query-suite labeling, not by kind mix inside a bucket.
  Keep caller-supplied `kindQuotas` / `kindBoosts` for targeted investigations.

## Block 5.5: Init / CLAUDE.md Snippet Hygiene

Status: implemented in `17007f8`.

### What changed

- Appended semantic strategy snippets are now wrapped in
  `<!-- arch-graph:semantic-strategy:start/end -->`.
- Re-running `arch-graph init` replaces the existing managed semantic strategy
  block instead of appending another copy.
- Legacy unmarked `## arch-graph semantic search strategy` sections are removed
  before the marked block is written.

### Why `CLAUDE.md.arch-graph-snippet.md` Exists

The separate file is a fallback/review artifact. It is created when the user
chooses not to append to `CLAUDE.md`, or when non-interactive init needs a safe
place to write instructions without mutating project memory. When appending to
`CLAUDE.md`, the project does not need the separate file.

## Block 5.6: FE Diagnose And Recall Hygiene

Status: closed; route/hook recall hygiene and diagnostics noise classification
extended after target-monorepo and project-gamma validation feedback.

### What changed

- `arch-graph diagnose --only=fe` now filters diagnostic output to FE.
- FE diagnose prints top missed routes, hooks, and components from
  `validation.fe`.
- FE hook ground truth now mirrors extractor semantics: a `useXxx` function is
  counted as a hook only if its body calls another hook. Bare use-prefixed
  utilities no longer inflate missed hook counts.
- Pages Router detection now treats `pages/` as a Next.js route root only in
  expected project/package positions. Feature folders such as
  `components/**/pages/**` are not counted as route ground truth.
- Pages Router roots under `apps/*/src/pages` / `packages/*/src/pages` are now
  gated by Next.js markers (`next.config.*`, `next` dependency, or Nx Next
  executor). Webpack/Vite/React Router apps with feature folders named
  `src/pages` no longer inflate route ground truth with `utils.ts`,
  `schema.ts`, `types.ts`, `hooks.ts`, or `consts.ts`.
- React Router JSX routes are extracted from `react-router-dom` `<Route path>`
  declarations, including paths stored in imported object constants such as
  `APP_ROUTES.USERS.ITEM.PATH`.
- Hook extraction now recognizes namespaced React hook calls such as
  `React.useContext(...)` and `React.useEffect(...)`, closing context-wrapper
  custom hook misses.
- FE unresolved diagnostics now classify:
  - `external-package`
  - `workspace-alias-unresolved`
  - `local-file-unresolved`
  - `tsx-component-unresolved`
- `arch-graph diagnose --only=fe` prints classification counters and orders
  actionable local/alias/component misses before external package noise.

## Block 6: CodeQL / Static Analysis Strategy

Status: research decision, not implementation.

### Finding

CodeQL is useful as a model for deep data-flow/static analysis, but it is not a
clean free backend for closed corporate repositories in local GitLab. GitHub's
public docs and CodeQL CLI terms distinguish open-source/public use from
closed-source/private use that requires a paid GitHub Code Security/Advanced
Security license.

The `github/codeql` repository contains MIT-licensed query libraries. The CLI
and engine are licensed separately, so forking CodeQL and publishing a fully
open-source compatible replacement is not a realistic route.

### Recommended Direction

Use arch-graph-native extractors for concrete architectural facts:

- NestJS decorators
- TypeORM relations
- DI metadata and constructor dependencies
- queues/events/schedules
- HTTP/config/imports/docs

Use optional OSS backends only where they add clear value:

- Semgrep OSS for pattern/taint checks.
- Joern for code property graph experiments.
- TypeScript compiler API / ts-morph for narrow TS/NestJS extraction.
- ESLint custom rules for local policy checks.

### Acceptance Criteria

- Do not add CodeQL as a required dependency.
- If CodeQL support is ever added, it must be optional and license-gated in docs.
- Prefer OSS-compatible tooling for local GitLab corporate use.

## Block 7: Verification

Status: current baseline.

### Passed

- `npm audit --audit-level=high` returned `found 0 vulnerabilities`.
- Targeted tests for RMQ, TypeORM, DI, hooks, init, semantic search, Mermaid,
  snippet recall passed.
- Combined targeted suite: `324 passed`.
- Semantic focused suite: `109 passed`.
- `git diff --check` passed.

### Known Existing Failures

These remain outside this track and existed before the feedback work:

- `src/cli/uninstall.test.ts`: fallback rm path failures x2.
- `src/pipeline/build.test.ts`: docs pass emits no `doc-section` nodes x1.
- `npm run build`: fixture/dependency TypeScript errors in sample files
  (`react`, `@nestjs/*`, `typeorm`, decorator fixture issues).

## Done Definition

This track is complete when:

- The implemented changes are on `main`.
- Consumer repos only need config/docs committed; graph artifacts stay local.
- Real RMQ projects can configure `RmqEventPattern` without NATS confusion.
- TypeORM relation graph carries cardinality/ownership/inverse/options metadata.
- DI graph answers provider dependency questions from constructor injection.
- Semantic search handles exact code names better than dense-only search.
- CodeQL positioning is documented as optional/licensed, not a default path.
