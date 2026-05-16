# Design: Semantic sidecar for arch-graph (Variant 3)
Date: 2026-05-16
Branch: `feat/semantic`
Worktree: `.worktrees/feat-semantic`

## Goal

Add an optional, self-contained semantic-search layer to arch-graph as a new subcommand `arch-graph semantic build|search` plus a new MCP tool `semantic_search`. The layer is built on top of the existing deterministic graph: each `GraphNode` gets a dense vector embedding produced from `label + kind + AST snippet`, persisted in a sidecar at `arch-graph-out/<repo>/semantic/`.

The sidecar is independent of any other product — `arch-graph` continues to work standalone. The design also fixes the **MCP contract shape** so the sister project **2-brain** (Phase 3 — `memory.code_context`) can later federate over it.

## Non-goals

- Hybrid (dense + BM25) search — 2-brain already does this on its side; arch-graph stays pure-dense.
- Reindexing on graph regeneration — `semantic build` is explicit and always full-rebuild for v1.
- LLM-based summarisation of nodes (Variant 2 territory).
- Replacing the deterministic graph or any existing query subcommand.

## File-touch matrix

| Task | Files (exact paths) | Touches |
|------|---------------------|---------|
| 1 — Semantic foundation | `package.json`, `src/semantic/types.ts`, `src/semantic/embedder.ts`, `src/semantic/snippet.ts`, `src/semantic/io.ts`, `src/semantic/embedder.test.ts`, `src/semantic/snippet.test.ts`, `src/semantic/io.test.ts` | new dep `@xenova/transformers`, new module `src/semantic/`, types, embedder wrapper (singleton), snippet extractor (ts-morph), JSONL/JSON read+write, unit tests |
| 2 — `semantic build` CLI | `src/semantic/builder.ts`, `src/semantic/builder.test.ts`, `src/cli/semantic-commands.ts`, `src/cli/index.ts` (registration only — lines ~700–760), `src/core/types.ts` (extend `DiagnosticsReport` with optional `semantic` field) | new builder pass: read graph + ts-morph project, extract snippet per node, embed, write sidecar, populate diagnostics |
| 3 — `semantic search` CLI | `src/semantic/search.ts`, `src/semantic/search.test.ts`, `src/cli/semantic-commands.ts` (extend), `src/cli/index.ts` (registration only) | kNN cosine search, CLI output (`--json` / `--table`) |
| 4 — MCP `semantic_search` tool | `src/mcp/server.ts` (registration only — near `explain` around line 322), `src/mcp/server.test.ts` (or a new sibling test) | register tool, zod input schema, handler reusing `src/semantic/search.ts` |
| 5 — Docs | `INTEGRATION-2BRAIN.md` (new, repo root), `README.md` (1–2 paragraphs + usage block), `claude-md.template.md` (note that `semantic_search` exists as fallback when query subcommands don't fit), `ROADMAP.md` (mark Shipped) | docs only, no code |

**Sequential**: Tasks 1 → 2 → 3 → 4 → 5. Task 2 depends on Task 1's `embedder.ts` + `snippet.ts`. Task 3 depends on Task 2's index format. Task 4 depends on Task 3's search function. Task 5 depends on the rest landing first so it documents real behaviour, not guesses.

**Note: `src/cli/index.ts` is touched by Tasks 2 and 3** — that means they cannot run in parallel even if we wanted. Single shared worktree, strict sequence.

## Patterns to follow

- **CLI two-word dispatch**: follow `src/cli/hooks.ts` (`parseHookArgs → { sub, args }` switch). The `semantic` command is registered as a pre-`parseArgs` dispatch in `src/cli/index.ts` similar to `claude` and `hook` (around lines 704–733).
- **MCP tool registration**: follow `subject_publishers` and `service_dependencies` in `src/mcp/server.ts`. Each tool: `server.registerTool(name, { description, inputSchema: { ... zod ... } }, handler)`. Handler returns `jsonResult(...)`.
- **Test naming**: `*.test.ts` next to source. Vitest. Coverage gate is 95% lines/95% functions/90% branches per-file (`vitest.config.ts`). New files must meet it on first commit.
- **In-memory fixtures**: `src/__fixtures__/in-memory-project.ts` for ts-morph-backed tests.
- **Graph loader**: `src/output/graph-json.ts` already has read/write helpers — reuse, don't reinvent.
- **Logging / output**: existing CLI commands use plain `console.log` for results and `console.error` for diagnostics. Keep it consistent. JSON mode default, `--table` opt-in.
- **Exit codes** (per README): `0` found, `4` not found, `1` error. Follow exactly for `semantic search`.

## External constraints

- **TypeScript-only**, Node ≥ 20, ESM modules (`"type": "module"` in package.json).
- **Embedding model is fixed by design**: `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384-dim, multilingual). This matches 2-brain's ONNX model so vectors are cross-comparable for future federation. Document this choice as a contract, not an implementation detail.
- **Model loads lazily** — only when `semantic build` or `semantic search` runs. The MCP server must not preload the model on startup; lazy on first `semantic_search` call.
- **Determinism**: graph extraction stays deterministic. Semantic layer is explicitly probabilistic and is reported as such in diagnostics.
- **No new runtime dependencies** beyond `@xenova/transformers`.
- **`arch-graph-out/<repo>/semantic/` layout is mandatory** — must live as a peer of `graph.json`. Multi-repo configs (existing convention — see `arch-graph-out/insyra/`, `platform/`, etc.) must work without code changes.
- **Diagnostics**: extend `DiagnosticsReport` with an optional `semantic?: SemanticDiagnostics` field. Field is optional so `arch-graph build` (without semantic) keeps emitting the same diagnostics.json shape.
- **Honesty rules from `claude-md.template.md` apply**: any node that could not be embedded (file unreadable, snippet extraction failed, transformer error) must appear in `diagnostics.semantic.skippedNodes` with a `reason`. No silent drops.

## Sidecar format (Tasks 1–2)

```
arch-graph-out/<repo>/
├── graph.json
├── diagnostics.json                    # extended with .semantic
├── validation.json
└── semantic/
    ├── manifest.json                   # { model, dim, builtAt, graphHash, nodeCount }
    └── embeddings.jsonl                # one JSON object per line: { nodeId, kind, label, path, snippet, vector }
```

- `vector` is a `number[]` of length 384, float32 cast to JSON numbers (acceptable size for v1; binary packing is a v2 optimisation).
- `graphHash` is a SHA-256 of `graph.json` at build time — `semantic search` warns if hash drifted (graph rebuilt after semantic, so the index is stale).
- One line per node keeps the file streamable for very large graphs (platform: ~300; insyra: ~5k).

## MCP contract (Task 4) — locked for 2-brain federation

Tool name: `semantic_search`

```ts
// Input (zod)
{
  query: z.string().min(1),
  topK: z.number().int().min(1).max(50).optional().default(10),
  kinds: z.array(z.string()).optional(),        // optional filter by NodeKind
  includeVectors: z.boolean().optional().default(false),
}

// Output
{
  query: string,
  results: Array<{
    nodeId: string,
    kind: NodeKind,
    label: string,
    path?: string,
    score: number,           // cosine similarity, [-1, 1]
    snippet?: string,        // ≤ 400 chars
    vector?: number[],       // present only when includeVectors=true
  }>,
  model: string,             // "Xenova/paraphrase-multilingual-MiniLM-L12-v2"
  dim: 384,
  indexBuiltAt: string,      // ISO timestamp
  graphHashMatches: boolean, // false → caller should re-run `semantic build`
}
```

This is the shape 2-brain Phase 3 (`memory.code_context`) will rely on. **Do not break it post-merge** without a coordinated bump.

## Acceptance Criteria

> Default tests AC for every code task: "Unit tests for the new code, covering happy path + at least one error/edge branch, must be added in the same commit. The tests must run as part of `pnpm test` and pass with coverage gates green."

### Task 1 — Semantic foundation

1. `pnpm add @xenova/transformers` lands in `package.json` and `package-lock.json`.
2. `src/semantic/types.ts` exports `SemanticManifest`, `SemanticRecord`, `SemanticDiagnostics`.
3. `src/semantic/embedder.ts` exposes `embed(texts: string[]): Promise<number[][]>` and `embedOne(text: string): Promise<number[]>`. The transformer pipeline is initialized lazily as a module-level singleton (no global state outside the module).
4. `src/semantic/snippet.ts` exposes `extractSnippet(project: ts-morph.Project, node: GraphNode): { snippet: string; reason?: string }`. Returns `''` snippet and `reason` on failure (file not found, label not located, ts-morph throws). **Never throws** — failures are values.
5. `src/semantic/io.ts` exposes `writeManifest`, `writeEmbeddingsJsonl`, `readManifest`, `readEmbeddingsJsonl` (the last is a streaming generator for large indices).
6. Unit tests cover: happy embed of 2 strings; embedOne; snippet extraction from in-memory fixture; snippet failure with explicit reason; JSONL roundtrip with a 3-node fixture.
7. `pnpm test` and `pnpm test:coverage` green. Coverage on new files meets 95/95/90.

### Task 2 — `semantic build` CLI

1. `arch-graph semantic build [--out <dir>] [--config <path>] [--repo <id>]` works for both single-repo and multi-repo configs.
2. Reads `arch-graph-out/<repo>/graph.json`, builds a ts-morph Project from the same `arch-graph.config.ts` as `build` does, extracts snippet per node, embeds in batches of ≤ 32.
3. Writes `arch-graph-out/<repo>/semantic/manifest.json` and `embeddings.jsonl`.
4. Populates `diagnostics.semantic` in the existing `diagnostics.json` (extending it, not overwriting unrelated fields). Required fields: `counts.{indexed, skipped, fileReadErrors, transformerErrors}`, `skippedNodes` (cap 50), `indexSizeBytes`, `model`, `dim`.
5. Idempotent re-run: running twice in a row produces the same index modulo `builtAt`.
6. Exit code 0 on success, 1 on hard failure (model load failure, config missing). Non-zero `skipped` is **not** failure — it's diagnostic.
7. Unit tests cover: build over in-memory 3-node graph; partial failure (1 snippet fails) recorded in diagnostics with reason; manifest contains correct `graphHash`.
8. Integration test in `scripts/integration-test.sh` adds a smoke step: build semantic over the existing `src/__fixtures__/` snapshot and assert `embeddings.jsonl` has the expected line count.

### Task 3 — `semantic search` CLI

1. `arch-graph semantic search "<query>" [--out <dir>] [--repo <id>] [--k <n>] [--json|--table] [--kinds k1,k2]` works.
2. Reads sidecar manifest + embeddings, embeds query, computes cosine similarity, returns top-K.
3. If `manifest.graphHash` ≠ current `graph.json` hash, prints a warning to stderr but still runs (with `graphHashMatches: false` in JSON output).
4. Exit code 0 if k > 0 results, 4 if no results (e.g. graph empty), 1 on hard failure.
5. `--json` (default) emits the same shape as the MCP tool output (minus `query` echo if desired — keep query for parity). `--table` prints aligned columns: score, kind, label, path.
6. Unit tests: kNN correctness on a hand-crafted 5-vector fixture (cosine math validated against numpy-equivalent expectations); kind filter; empty index → exit 4; hash mismatch → warning emitted.

### Task 4 — MCP `semantic_search` tool

1. Tool registered in `src/mcp/server.ts` immediately after `explain` registration.
2. Input/output schema matches the **MCP contract (Task 4)** section above exactly.
3. Handler reuses `src/semantic/search.ts` — no duplicated logic.
4. Model is loaded lazily on first invocation (subsequent calls reuse the cached pipeline).
5. If sidecar is missing for the requested repo, returns a structured error result (not a thrown exception): `{ results: [], error: "semantic-index-missing", hint: "run: arch-graph semantic build" }`.
6. Unit test: register and invoke the tool against a fixture index; assert output schema; assert missing-index path.

### Task 5 — Docs

1. `INTEGRATION-2BRAIN.md` exists at repo root. Documents: the model contract, the MCP tool shape, how 2-brain Phase 3 `memory.code_context` is expected to consume it, the federation diagram.
2. `README.md` gains a new section "Semantic search (optional)" with: model name, install/build/search examples, sidecar layout, a note that arch-graph works standalone without it.
3. `claude-md.template.md` gains a 3-line note in the "fallbacks" section: "If a question is fuzzy (`how does X work`, `find code about Y`) and no structured query fits — use MCP tool `semantic_search`. Run `arch-graph semantic build` first if the sidecar isn't built."
4. `ROADMAP.md` marks "Semantic sidecar" as Shipped (2026-05-16) with one-paragraph summary mirroring the existing Shipped section style.
5. **No claims about 2-brain that aren't true today** — the doc says "2-brain Phase 3 *will* consume this", not "is consuming". Honesty.

## Quality gate (every task)

```sh
pnpm test
pnpm test:coverage    # only on the new files; project-wide gate is per-file, so new files must meet 95/95/90
```

For Task 2 specifically: additionally run `pnpm test:integration` after the integration step is added.

## Open questions (resolve during execution if hit)

1. **Batch size for embedder**: 32 is a safe default. Profile on platform graph (~300 nodes); if RAM headroom allows, push to 64. Document the chosen value.
2. **Snippet length cap**: target 400 chars. If labels alone are tiny and snippet is the main signal, allow up to 600 — but cap somewhere so JSONL stays under ~5 MB on insyra (5k nodes).
3. **What to do with `nats-subject` / `db-table` nodes that have no `path`**: embed just `label + kind` — these are abstract anchors and their embedding still has value for "find all queues about retries" style queries.

## Risks

- **Model download on first run is ~135 MB and slow.** Mitigate by: print a clear "downloading model, one-time, will cache to ~/.cache/..." message; document this in README.
- **JSONL grows large on big graphs.** Mitigate by streaming reader; v2 can add binary packing if needed (out of scope here).
- **Coverage gate (95/95/90) is strict.** Allow extra time on Task 1 and Task 2 for edge tests.
