# Feedback Coverage Track

Date: 2026-05-21
Status: active track
Latest implementation commits:

- `749b940 feat: cover rmq and graph feedback gaps`
- pending: plan follow-ups for RMQ payload DTO, DI token injection, constructor diagnostics, semantic quotas/boosts

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

Status: implemented baseline in `749b940`.

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
- Remaining: evaluate recall impact on the comparison benchmark.
- Remaining: decide whether `code_search` / `docs_search` need their own preset quotas beyond caller-supplied `kindQuotas`.

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
