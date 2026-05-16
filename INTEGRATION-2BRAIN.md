# Integration: arch-graph semantic sidecar ↔ 2-brain Phase 3

## Why this exists

arch-graph works as a standalone architecture extractor for NestJS monorepos — deterministic, structure-focused queries via CLI and MCP tools. The sister project **2-brain** (Anthropic's memory and code-context federation system) will add optional semantic search in Phase 3 (`memory.code_context`). The shared embedding model makes vectors comparable across both systems, enabling a future federated pattern: 2-brain can query arch-graph's semantic index via MCP, optionally combining results with its own dense retrieval over drawers.

## Shared embedding model

Both arch-graph and 2-brain use **the same embedding model** for cross-system vector comparability:

- **Model**: `Xenova/paraphrase-multilingual-MiniLM-L12-v2`
- **Dimensions**: 384
- **Architecture**: multilingual (supports code comments in non-English, natural-language queries in any language)
- **Deployment**:
  - **arch-graph**: local `@xenova/transformers` (ONNX Runtime, in-process)
  - **2-brain**: local Python `sentence-transformers` with ONNX runtime

This fixed choice is a **federation contract** — any divergence (different model, different version, different preprocessing) breaks vector comparability.

## MCP contract — locked for federation

The `semantic_search` MCP tool exposes this schema (identical shape expected for any federation consumer):

### Input

```typescript
{
  query: string,                           // text to embed and search for
  topK?: number,                           // default 10, max 50
  kinds?: string[],                        // optional filter by NodeKind
  includeVectors?: boolean,                // default false; true includes full 384-dim vectors
}
```

### Output

```typescript
{
  query: string,                           // echo of input query
  results: Array<{
    nodeId: string,                        // arch-graph node identifier (e.g., "service:auth-api", "db-table:users")
    kind: NodeKind,                        // e.g., "service", "db-table", "nats:subject"
    label: string,                         // human-readable node label
    path?: string,                         // file path (omitted for abstract nodes like queues)
    score: number,                         // cosine similarity in [-1, 1]
    snippet?: string,                      // ≤ 400 characters of context (code snippet or label)
    vector?: number[],                     // 384-dim float array; present only if includeVectors=true
  }>,
  model: string,                           // "Xenova/paraphrase-multilingual-MiniLM-L12-v2"
  dim: 384,
  indexBuiltAt: string,                    // ISO 8601 timestamp of sidecar build
  graphHashMatches: boolean,               // false → caller should re-run `arch-graph semantic build`
}
```

## Expected consumer pattern (2-brain Phase 3)

When 2-brain Phase 3 ships `memory.code_context(query)`, the pattern will be:

1. **Optionally enable federation**: if both arch-graph and 2-brain are available in the Claude Code environment, user configuration enables `codeContext.federate = true`.
2. **Call the MCP tool**: 2-brain's `memory.code_context` will internally call `semantic_search(query, topK=10)` against the arch-graph MCP server.
3. **Optionally combine results**: 2-brain may apply **Reciprocal Rank Fusion (RRF)** to blend arch-graph results with its own drawer-based retrieval, re-ranking by combined score.
4. **Fallback gracefully**: if the sidecar is missing or stale (graphHashMatches=false), the output surfaces the issue as a hint ("run `arch-graph semantic build` first").

## Compatibility guarantee — version bump rules

The MCP contract above is **stable for federation**. Any breaking change requires:

1. **Coordinated version bump** in both arch-graph and 2-brain.
2. **Semver major** (e.g., v1.0.0 → v2.0.0) if output shape changes.
3. **Semver minor** (e.g., v1.1.0) if new optional fields are added (backward-compatible).
4. **Semver patch** (e.g., v1.0.1) for bug fixes and content changes that don't affect the schema.

## Federation diagram

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Code session                                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  User query: "find code about authentication"               │
│       │                                                      │
│       ▼                                                      │
│  ┌──────────────────────────────────────────┐               │
│  │  2-brain Phase 3                         │               │
│  │  memory.code_context(query)              │               │
│  │  ┌─ dense search over drawers            │               │
│  │  └─ MCP call to arch-graph (optional)    │               │
│  └─────────────┬──────────────────────────┐ │               │
│                │                          │ │               │
│     ┌──────────▼──────────┐     ┌─────────▼─┐               │
│     │  2-brain drawers    │     │ arch-graph│               │
│     │  (memory index)     │     │ semantic  │               │
│     │ Xenova ONNX Runtime │     │ sidecar   │               │
│     │ 384-dim vectors     │     │ Xenova    │               │
│     └──────────┬──────────┘     │ ONNX      │               │
│                │                │ 384-dim   │               │
│     ┌──────────▼──────────────────────────┐ │               │
│     │  Optional RRF ranking                │ │               │
│     │  (combine 2-brain + arch-graph)      │ │               │
│     └──────────┬──────────────────────────┘ │               │
│                │                            │               │
│     ┌──────────▼──────────┐                  │               │
│     │  Merged result set  │                  │               │
│     │  (code context)     │                  │               │
│     └─────────────────────┘                  │               │
│                                              │               │
└──────────────────────────────────────────────────────────────┘
```

## Current status

- **arch-graph semantic sidecar**: shipped 2026-05-16 ✅ — `arch-graph semantic build|search` and MCP tool `semantic_search` are live.
- **2-brain Phase 3**: not yet shipped — expected to consume this contract in a future release. Uses future tense ("will consume") for all 2-brain references until Phase 3 lands.

## Reference

- **arch-graph semantic CLI**: `arch-graph semantic build [--out <dir>] [--repo <id>]` builds sidecar; `arch-graph semantic search "<query>"` queries it.
- **MCP tool name**: `semantic_search` — automatically available when `arch-graph mcp` is running.
- **Sidecar location**: `arch-graph-out/<repo>/semantic/` (peer to `graph.json`).
- **Design doc**: `docs/plans/2026-05-16-semantic-sidecar-design.md` (for implementers).
