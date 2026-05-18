# Design: OpenAPI YAML Enrichment for Endpoint Nodes
Date: 2026-05-17

## Goal
Add a post-extraction enrichment pass that reads OpenAPI YAML files and injects
operation descriptions (often in Russian for project-c) into matching endpoint nodes
via `meta.openapiInfo`, extending `buildEmbedText` so the richer text gets
vectorized and improves A_find recall.

## Baseline
- Tests: 1059 passing
- tsc baseline: 25 errors (pre-existing, must not grow)

## Architecture overview

```
ArchGraphConfig  (new field: openapiGlobs?)
        │
        ▼
enrichEndpointsFromOpenApi(graphNodes, projectRoot, openapiGlobs)
        │  uses fast-glob to find YAML files
        │  uses js-yaml to parse each file
        │  matches by operationId-first, fallback (method,path)
        │  mutates endpoint GraphNode meta.openapiInfo in-place
        │
        ▼
DiagnosticsReport.openapi (new optional field)
        │
        ▼
buildEmbedText() — appends openapiInfo fields for endpoint nodes
```

## Key findings from analysis

### Endpoint node structure (from mapper/endpoint-to-graph.ts)
- Node id: `endpoint:METHOD /pattern` (e.g. `endpoint:GET /users/:id`)
- `node.meta.methodName` — controller method name (CRITICAL for operationId match)
- `node.meta.controllerClass` — class name
- `node.label` — `"GET /users/:id"` (method + space + path)
- `node.meta.openapiInfo` — NEW field injected by enrichment

### operationId matching strategy
Primary: `operationId === endpoint.meta.methodName` (case-sensitive, exact)
Fallback: parse `node.id` → `method.toLowerCase()` + `pattern` vs YAML `method` + `path`
  - Parse label: `node.label` = `"POST /users/:id"` → method=`POST`, path=`/users/:id`

### Existing patterns to follow
- `js-yaml` already in deps, already used in `src/extractors/docs/extract-docs.ts`
- `fast-glob` already in deps, used in the same extract-docs.ts
- Config extension pattern: same as `docs?: DocsConfig` in `ArchGraphConfig`
- Diagnostics field pattern: same as `endpoint?: EndpointDiagnostics` in `DiagnosticsReport`
- Build pipeline wiring: after endpoint mapping, before semantic index build
  (insert after line ~362 in build.ts: `const endpointsMapped = mapEndpointsToGraph(...)`)

### buildEmbedText location
`src/semantic/builder.ts` — private function `buildEmbedText(node, snippet)` at bottom
Currently: `label + kind` base + snippet. Need to add openapiInfo text for endpoint kind.

## File-touch matrix

| Task | Files (exact paths) | Touches |
|------|---------------------|---------|
| 1 — Core enrichment pass | `src/extractors/openapi/enrich-endpoints.ts` | NEW file |
| 1 — Tests | `src/extractors/openapi/enrich-endpoints.test.ts` | NEW file |
| 2 — Config extension | `src/core/config.ts` | add `OpenApiConfig`, `openapiGlobs?` to `ArchGraphConfig` |
| 2 — Types extension | `src/core/types.ts` | add `OpenApiDiagnostics`, `DiagnosticsReport.openapi?` |
| 3 — Builder extension | `src/semantic/builder.ts` | extend `buildEmbedText` for endpoint+openapiInfo |
| 3 — Builder tests | `src/semantic/builder.test.ts` | add tests for AC-F (embed text) |
| 4 — Pipeline wiring | `src/pipeline/build.ts` | call enrichment pass after endpoint mapping |

## Acceptance Criteria (per task)

### Task 1 — Core enrichment pass (AC-2, AC-3, AC-4, AC-6, AC-7-A through E)
1. `enrichEndpointsFromOpenApi(nodes, projectRoot, globs?)` is exported from new file
2. Signature: `(nodes: GraphNode[], projectRoot: string, openapiGlobs?: string[]) => Promise<OpenApiEnrichResult>`
3. Default globs when none provided: `['api/*.yaml', 'api/*.yml', '**/openapi.yaml', '**/swagger.yaml']`
4. Parses `paths` → each `path/method` → extracts `operationId`, `summary`, `description`, `tags`, `parameters`
5. Primary match: `node.meta.methodName === operationId`
6. Fallback match: `node.label.split(' ')[0].toLowerCase() === method` AND `node.id.includes(path)`
7. Matched nodes get `meta.openapiInfo = { description?, summary?, tags?, paramSummary? }`
8. `paramSummary`: concat of `param.name + ': ' + param.description` for each param with description, joined by '; '
9. Unmatched YAML entries → `result.diagnostics.endpointsUnmatched` (do NOT throw)
10. Parse errors → `result.diagnostics.parseErrors` (continue processing other files)
11. No YAML files → silent no-op, `filesProcessed: 0`
12. Mutates `nodes` in-place AND returns diagnostics
13. Tests: AC-7-A, B, C, D, E all covered with in-memory YAML fixtures

### Task 2 — Config + Types extensions (AC-1, AC-6)
1. `ArchGraphConfig` gains `openapi?: OpenApiConfig` where `OpenApiConfig = { globs?: string[] }`
2. `DiagnosticsReport` gains `openapi?: OpenApiDiagnostics`
3. `OpenApiDiagnostics` shape: `{ filesProcessed: number; endpointsMatched: number; endpointsUnmatched: Array<{operationId?: string; method: string; path: string}>; parseErrors: Array<{file: string; error: string}> }`
4. No existing tests broken by the config extension

### Task 3 — buildEmbedText extension + tests (AC-5, AC-7-F)
1. `buildEmbedText` for `endpoint` nodes with `meta.openapiInfo` appends text block: description + summary + tags (joined ', ') + paramSummary, separated by newlines, only when values exist
2. `buildEmbedText` for endpoint without `meta.openapiInfo` is UNCHANGED
3. `buildEmbedText` for all non-endpoint kinds is UNCHANGED
4. Unit test AC-7-F: fixture endpoint node with `meta.openapiInfo.description = 'Получение списка категорий'` → embed text contains that Russian string
5. Unit test AC-7-F negative: endpoint node without openapiInfo → same as before

### Task 4 — Pipeline wiring (AC-1, AC-6 in context)
1. After `endpointsMapped`, call `enrichEndpointsFromOpenApi(graph.nodes, cfg.root, cfg.openapi?.globs)`
2. Result diagnostics stored in `DiagnosticsReport.openapi`
3. No-op when `cfg.openapi` absent (uses default globs but that's fine — no YAML = no-op)
4. Pipeline tests not broken

## Constraints
- Do NOT add a new `NodeKind`
- Do NOT modify endpoint extractor logic
- Do NOT touch doc-section pipeline
- `js-yaml` and `fast-glob` already in deps — no new deps needed
- Conventional Commits, scope = `openapi` or `arch-graph`
- Selective `git add <paths>` — NEVER `git add -A`
- All git ops via `git -C <arch-graph-root>/.worktrees/feat-openapi-enrich`

## Execution order
All 4 tasks touch DIFFERENT files — safe to run as single agent sequentially.
Single implementer (Sonnet) in the existing worktree. No isolation needed (already isolated).

## CWD discipline (mandatory for all agents)
- Worktree: `<arch-graph-root>/.worktrees/feat-openapi-enrich`
- Branch: `feat/openapi-enrich`
- All git ops: `git -C <arch-graph-root>/.worktrees/feat-openapi-enrich <cmd>`
- DO NOT `git switch` / `git checkout <other-branch>`
- Commit ONLY to current branch `feat/openapi-enrich`
