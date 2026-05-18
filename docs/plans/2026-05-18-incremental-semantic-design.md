# Incremental Semantic Re-embed — Design

Date: 2026-05-18
Branch: `feat/e5-base-migration`
Worktree: `.worktrees/feat-e5-migration`
Parent design doc: `docs/plans/2026-05-18-e5-base-migration-design.md`

---

## 1. Goal

Today `arch-graph semantic build` re-embeds every node in the graph on every
run, regardless of whether a node's content changed. With e5-base at ×1.6 the
build time of MiniLM, a 30 K-node graph takes ~41 minutes end-to-end — far too
slow to run automatically on every commit. This document specifies an
incremental mode that skips re-embedding for any node whose content hash
matches the prior index, reducing a typical commit (10–30 changed nodes) to
roughly 1–2 seconds for e5-base. The hook installed by `arch-graph hook
install` will run `arch-graph semantic build --incremental` (the default)
automatically after every structural build, making the semantic index
continuously up-to-date with no manual intervention. A `--no-include-semantic`
opt-out flag preserves the previous structural-only hook behaviour for teams
that do not want the semantic step.

---

## 2. Schema Change

### 2.1 Schema version bump

`SEMANTIC_SCHEMA_VERSION` in `src/semantic/types.ts` advances from `1` to `2`.
Any prior index built with schemaVersion 1 lacks `contentHash` and cannot be
reused for incremental builds (see Section 5).

### 2.2 New field on SemanticRecord

A `contentHash: string` field is appended to every `SemanticRecord`. It is a
SHA-256 hex digest computed over the node's embedding inputs joined by the `|`
character in lowercase:

```
sha256( kind + "|" + label + "|" + snippet + "|" + modelAlias )
```

All four components are lowercased before hashing. The hash is computed at
build time and stored alongside the vector so the next incremental run can
compare hashes without re-computing embeddings.

### 2.3 Before / after example record

**Before (schemaVersion 1):**

```json
{
  "nodeId": "UserService",
  "kind": "service",
  "label": "UserService",
  "path": "apps/api/src/user/user.service.ts",
  "snippet": "export class UserService {\n  constructor(...",
  "vector": [0.012, -0.034, 0.098, "...768 more values..."]
}
```

**After (schemaVersion 2):**

```json
{
  "nodeId": "UserService",
  "kind": "service",
  "label": "UserService",
  "path": "apps/api/src/user/user.service.ts",
  "snippet": "export class UserService {\n  constructor(...",
  "contentHash": "a3f8d2c1b7e04591fc2d8a73b5e96120c4ef3d1a7b8290e5f1d3c6e2a4b7f908",
  "vector": [0.012, -0.034, 0.098, "...768 more values..."]
}
```

The `contentHash` field is added between `snippet` and `vector` for readability
but serialisation order is not a correctness concern.

---

## 3. Algorithm

### 3.1 Compatibility check

Before attempting to load a prior index, the builder performs a three-field
compatibility check on `semantic/manifest.json`:

1. `manifest.schemaVersion === 2` — schema version must be the current version.
2. `manifest.model === currentModelEntry.hubId` — hub ID must match exactly
   (catches alias changes, e.g. `minilm` → `e5-base`).
3. `manifest.dim === currentModelEntry.dim` — dimensionality must match (catches
   cases where two aliases share a hub ID but differ in dim, or config errors).

If all three pass, the prior index is usable. If any check fails, the builder
falls back to a full rebuild (see Section 5 for per-case behaviour).

### 3.2 Pseudocode

```
function buildSemanticIndex(opts):
  alias         = opts.modelAlias ?? 'minilm'
  modelEntry    = SEMANTIC_MODELS[alias]
  priorCache    = Map<nodeId, { contentHash, vector }>  // empty until loaded

  if opts.full is NOT true:
    manifestPath = join(outDir, 'semantic/manifest.json')
    if manifestPath exists:
      try:
        priorManifest = readManifest(manifestPath)  // no expected= arg
        if priorManifest.schemaVersion === 2
             AND priorManifest.model  === modelEntry.hubId
             AND priorManifest.dim    === modelEntry.dim:
          for each line in readEmbeddingsJsonl(embeddingsPath, modelEntry.dim):
            priorCache.set(line.nodeId, {
              contentHash: line.contentHash,
              vector:      line.vector,
            })
          // priorCache is now loaded; incremental diff proceeds below
        else:
          log one-line warning describing which check failed → full rebuild
      catch (corrupt / ENOENT / dim-mismatch):
        log one-line warning → full rebuild; priorCache stays empty

  sortedNodes = graph.nodes sorted by id
  toEmbed     = []
  reused      = Map<nodeId, SemanticRecord>

  for each node in sortedNodes:
    snippet  = extractSnippet(project, node)
    hash     = sha256( lower(node.kind + "|" + node.label + "|" + snippet + "|" + alias) )
    cached   = priorCache.get(node.id)

    if cached AND cached.contentHash === hash:
      reused.set(node.id, {
        nodeId:      node.id,
        kind:        node.kind,
        label:       node.label,
        path:        node.path,
        snippet:     snippet,
        contentHash: hash,
        vector:      cached.vector,
      })
    else:
      toEmbed.push({ node, snippet, hash })

  // Nodes in priorCache but NOT in sortedNodes are deleted nodes:
  // they are simply omitted from both reused and records — no explicit deletion step needed.

  records = Array.from(reused.values())

  for each batch of EMBED_BATCH_SIZE items in toEmbed:
    texts   = batch.map(item => buildEmbedText(item.node, item.snippet))
    vectors = await embedder(texts)   // throws → batch recorded as transformer-error
    for each (item, vector) in zip(batch, vectors):
      records.push({
        nodeId:      item.node.id,
        kind:        item.node.kind,
        label:       item.node.label,
        path:        item.node.path,
        snippet:     item.snippet,
        contentHash: item.hash,
        vector:      vector,
      })

  sort records by nodeId   // stable JSONL order
  writeManifest(...)
  writeEmbeddingsJsonl(records, ...)
  return { manifest, diagnostics }
```

### 3.3 Diagnostic counts

`SemanticDiagnostics.counts` gains two new fields:

- `reused: number` — nodes whose vector was copied from the prior index.
- `recomputed: number` — nodes that were re-embedded in this run.

`reused + recomputed` equals `indexed` (the existing field) when no skips
occurred in the embed phase. Skips reduce `recomputed` relative to
`toEmbed.length`, since failed embeds are counted under `skipped` instead.

---

## 4. CLI Flag

### 4.1 Default behaviour

`arch-graph semantic build` (no flag) runs in incremental mode: loads the prior
index if compatible, reuses unchanged nodes, re-embeds changed and new nodes.
This is equivalent to `--incremental`.

### 4.2 --full

`arch-graph semantic build --full` skips cache loading entirely. Every node is
re-embedded from scratch. Use cases:

- Forcing a clean rebuild after a suspected cache corruption.
- Benchmarking: measuring wall-clock time of the full embed pipeline.
- CI pipelines that require reproducible index state regardless of prior output.

### 4.3 --quiet

`arch-graph semantic build --quiet` suppresses informational stdout output
(progress lines, manifest summary). Errors and warnings still go to stderr.
This flag is used by the hook integration (Section 6) so commits stay clean.

### 4.4 Interaction summary

| Flag combination         | Behaviour                                         |
|--------------------------|---------------------------------------------------|
| (none)                   | incremental + auto-fallback to full when unusable |
| `--full`                 | full rebuild, no cache lookup                     |
| `--quiet`                | suppress stdout; same rebuild mode as default     |
| `--full --quiet`         | full rebuild, no stdout                           |

---

## 5. Backwards Compatibility

### 5.1 schemaVersion 1 indexes

A prior index with `schemaVersion: 1` lacks `contentHash` on each record.
There is no way to determine which nodes changed. Behaviour:

1. Compatibility check fails at the `schemaVersion === 2` test.
2. Builder logs exactly one warning line to stderr:

   ```
   [arch-graph semantic] WARNING: prior index is schemaVersion=1 (expected 2); forcing full rebuild.
   ```

3. Full rebuild proceeds. The new output is written with `schemaVersion: 2`.

Existing users upgrading from v1 indexes pay one full rebuild at the first run
after the upgrade. Subsequent runs are incremental. A migration note will be
added to `README.md` (Task 6 scope, not this doc).

### 5.2 No prior index (first build)

`priorCache` stays empty (ENOENT path). All nodes are enqueued for embedding.
Behaviour is identical to a full rebuild. No warning is emitted.

### 5.3 Manifest schemaVersion from the future

If `manifest.schemaVersion > 2` (a future version), the compatibility check
fails. Behaviour: same one-line warning as 5.1, force full rebuild. This is a
safe defensive fallback for downgraded binaries.

---

## 6. Hook Integration

### 6.1 Default-on per user direction

Per the `## UPDATE` section of the parent design doc, the semantic build step
is **included by default** in the hook installed by `arch-graph hook install`.
The rationale: with incremental re-embed, the per-commit cost for a typical
10–30 node change is 1–2 seconds — negligible as a pre-commit gate.

### 6.2 Hook body (updated)

The pre-commit hook body (currently in `PRE_COMMIT_BODY` in
`src/cli/hooks.ts`) gains a second command after the structural build:

```sh
arch-graph build --quiet || exit 1
git add arch-graph-out/graph.json \
        arch-graph-out/diagnostics.json \
        arch-graph-out/validation.json \
        arch-graph-out/graph.mermaid 2>/dev/null || true

# Incremental semantic index update (default-on).
# Fail-soft: transient embed errors must not block commits.
arch-graph semantic build --quiet || true
git add arch-graph-out/semantic/manifest.json \
        arch-graph-out/semantic/embeddings.jsonl 2>/dev/null || true
```

The `|| true` after `arch-graph semantic build` is intentional (see Section 10,
open question 1).

### 6.3 --no-include-semantic opt-out

`arch-graph hook install --no-include-semantic` installs a hook that runs only
the structural build, preserving the legacy behaviour for teams that manage the
semantic index separately or do not want the extra 1–2 s per commit.

When `--no-include-semantic` is passed:

- The `arch-graph semantic build` line and the subsequent `git add` for
  `semantic/` are omitted from the hook body.
- The installed hook is functionally identical to the pre-UPDATE hook.

### 6.4 Re-install behaviour

Re-running `arch-graph hook install` (with or without `--no-include-semantic`)
is idempotent: the existing marker block is replaced in-place via
`replaceMarkedSection`. Switching between the two modes on an already-installed
hook is safe.

### 6.5 Reference

User direction is captured in the `## UPDATE — 2026-05-18 evening` section of
`docs/plans/2026-05-18-e5-base-migration-design.md`:

> Hook default flipped: Task 5's `--include-semantic` flag on
> `arch-graph hook install` becomes **on by default**, with
> `--no-include-semantic` opt-out.

---

## 7. Performance Model

### 7.1 Full rebuild

```
T_full ≈ N × T_embed + T_io
```

Where:
- `N` = total node count in graph
- `T_embed` = per-node embed time (batched; ~80 ms/node at batch=32 on e5-base
  on Apple M-series, dominated by ONNX inference, not batch overhead)
- `T_io` = I/O time for reading graph.json + writing embeddings.jsonl; linear
  in N but small (~2 s at 30 K nodes)

At 30 K nodes: T_full ≈ 30,000 × 0.08 s + 2 s ≈ 41 minutes. Matches the
observed bench number in the parent design doc.

### 7.2 Incremental rebuild

```
T_incremental ≈ K × T_embed + N × T_hash + T_io
```

Where:
- `K` = number of changed or new nodes in this commit (typically 10–30)
- `N × T_hash` = cost of computing SHA-256 over ~400-char strings for all N
  nodes; SHA-256 over 400 bytes takes ~1 µs on modern hardware → 30 K × 1 µs
  = 30 ms total
- `T_io` = reading prior embeddings.jsonl (large) + writing new one; streaming
  read at ~200 MB/s for a ~300 MB e5-base index ≈ 1.5 s; write ≈ 1.5 s → 3 s
  round-trip I/O at 30 K nodes

For a typical commit touching 10–30 nodes on e5-base:

```
T_incremental ≈ 20 × 0.08 s + 0.03 s + 3 s ≈ 4.6 s
```

At the lower end (10 nodes changed): ≈ 3.8 s. At the upper end (30 nodes): ≈ 5.4 s.

For smaller codebases (5 K nodes, ~50 MB index, ~10 s full rebuild):
```
T_incremental ≈ 20 × 0.08 s + 0.005 s + 0.5 s ≈ 2.1 s
```

The I/O cost of streaming the prior index is the dominant term for large
graphs. Future optimisation: a separate per-node cache keyed by nodeId (a
SQLite or flat-file lookup) would reduce this to O(1) reads. That is out of
scope for this Task but noted for Task 8 empirical measurement.

---

## 8. Edge Cases

| Case | Detection | Behaviour |
|------|-----------|-----------|
| **Model alias change** (e.g. minilm → e5-base in config) | `manifest.model !== currentModelEntry.hubId` | Log warning: "model changed; forcing full rebuild." Full rebuild. |
| **Dim mismatch** (manifest.dim ≠ currentModelEntry.dim) | `manifest.dim !== currentModelEntry.dim` | Log warning: "dim changed; forcing full rebuild." Full rebuild. |
| **schemaVersion mismatch** (prior index is v1 or future) | `manifest.schemaVersion !== 2` | Log warning: "schemaVersion mismatch; forcing full rebuild." Full rebuild. |
| **Corrupt embeddings.jsonl** (invalid JSON on line N) | `JSON.parse` throws during priorCache load | Log warning: "embeddings.jsonl corrupt at line N; forcing full rebuild." Full rebuild. priorCache stays empty. |
| **Dim mismatch in JSONL line** (vector.length ≠ expected) | `readEmbeddingsJsonl` throws per existing contract | Same handling as corrupt: log warning, force full rebuild. |
| **Partial write failure** (process killed mid-write) | Prior `manifest.json` is only overwritten atomically at the end (write to temp + rename, or write-then-overwrite) | Prior manifest stays valid until `writeManifest` completes. Next run either re-embeds the partial state (if only JSONL was written and manifest was NOT yet updated) or resumes from the last good manifest. |
| **`--full` flag** | `opts.full === true` | Skip cache lookup entirely. All nodes enqueued. No warning emitted. |
| **Empty prior index** (first build) | ENOENT on manifest or embeddings.jsonl | priorCache stays empty (no warning). All nodes enqueued. Identical to full rebuild. |
| **Deleted nodes** (in priorCache but not in graph) | Node id not present in `sortedNodes` iteration | Omitted from output automatically: the output is built from `sortedNodes` only. No explicit deletion step needed. |
| **New nodes** (not in priorCache) | `priorCache.get(nodeId)` returns undefined | Hash mismatch path: enqueued for embedding. |
| **Label or snippet change only** | contentHash differs from cached hash | Re-embed triggered for that node. All other nodes reused. |

---

## 9. Test Plan

Task 5 must include a dedicated `src/semantic/incremental.test.ts` file plus
additions to `src/semantic/builder.test.ts`. The following cases must each be
covered by at least one test:

1. **Hash determinism**
   - Same `(kind, label, snippet, modelAlias)` inputs produce the same hash on
     two independent calls.
   - Changing any single field (kind, label, snippet, or modelAlias) produces a
     different hash.

2. **No-op rebuild**
   - Build with N nodes, produce embeddings.jsonl (schemaVersion 2).
   - Run `buildSemanticIndex` again with the same graph (no changes).
   - Assert: embedder function was called 0 times; `diagnostics.counts.reused`
     equals N; `diagnostics.counts.recomputed` equals 0.

3. **Single-node snippet change**
   - Build with N nodes.
   - Modify one node's snippet in the graph fixture.
   - Run incremental build.
   - Assert: embedder called exactly 1 time (for the changed node); reused = N-1;
     recomputed = 1.

4. **Model-alias change**
   - Build with alias `minilm`.
   - Run `buildSemanticIndex` with alias `e5-base` (different hub ID and dim).
   - Assert: compatibility check fails; full rebuild triggered; embedder called N
     times; no reuse.

5. **schemaVersion mismatch in prior manifest**
   - Manually write a `manifest.json` with `schemaVersion: 1`.
   - Run `buildSemanticIndex` in incremental mode.
   - Assert: warning logged to stderr containing "schemaVersion"; full rebuild
     triggered; embedder called N times.

6. **`--full` flag**
   - Build once to produce a valid schemaVersion-2 index.
   - Run `buildSemanticIndex` with `full: true`.
   - Assert: embedder called N times regardless of prior cache; reused = 0.

7. **Deleted nodes**
   - Build with N nodes.
   - Remove one node from the graph fixture.
   - Run incremental build.
   - Assert: output contains exactly N-1 records; deleted node id is absent;
     reused = N-2 (or N-1 if other nodes were reused and only the deleted node
     is gone); no orphan records.

8. **Hook with `--include-semantic` (default-on)**
   - Call `hookInstall` with default args (no `--no-include-semantic`).
   - Read the installed hook file.
   - Assert: hook body contains `arch-graph semantic build --quiet || true`.

9. **Hook with `--no-include-semantic`**
   - Call `hookInstall` with `noIncludeSemantic: true`.
   - Read the installed hook file.
   - Assert: hook body does NOT contain `arch-graph semantic build`.

10. **Corrupt embeddings.jsonl**
    - Write a `manifest.json` with valid schemaVersion-2 values plus an
      `embeddings.jsonl` where line 3 contains malformed JSON.
    - Run incremental build.
    - Assert: warning logged to stderr; full rebuild triggered; embedder called
      N times; final output is valid.

---

## 10. Open Questions

### 10.1 Hook fail-soft vs fail-hard (recommendation: fail-soft)

The hook body currently uses `arch-graph semantic build --quiet || true`.
The `|| true` means a semantic build failure (transient network error while
downloading the ONNX model, disk-full, transformer crash) does NOT block the
commit.

**Arguments for fail-soft (`|| true`):**
- The semantic index is a derived sidecar — its absence does not prevent the
  developer from committing or the CI from running.
- Transient errors (first-run model download, disk pressure) should not block
  every developer on the team during a morning deploy.
- The structural graph (graph.json) is already staged and committed; the
  semantic index can be regenerated with a manual `arch-graph semantic build`.

**Arguments for fail-hard (no `|| true`):**
- Guarantees the committed semantic index is always in sync with the graph.
- Makes embedding errors visible at commit time rather than later.

**Recommendation:** keep fail-soft (`|| true`) as the default. Teams that want
strict CI guarantees should run `arch-graph semantic build --quiet` as a
separate CI step (not the hook) where failures can be surfaced without blocking
every developer's local commit.

### 10.2 I/O cost for very large graphs

For graphs exceeding 50 K nodes the streaming-read cost of the prior
embeddings.jsonl (~1 GB for e5-base) may dominate incremental build time even
when only a few nodes changed. A future optimisation (out of scope for Task 5)
would be a keyed lookup cache (per-node file or SQLite) so only affected
records are read and rewritten. Task 8 empirical measurement will quantify
whether this is needed in practice.

### 10.3 Atomicity of manifest write

The current `writeManifest` implementation uses a direct `writeFile` call,
which is not atomic (a process kill mid-write leaves a truncated manifest).
Upgrading to a write-then-rename pattern (`writeFile` to a `.tmp` path, then
`rename`) would make the output atomic. This is a separate improvement from
incremental re-embed and is tracked but not required for Task 5 to ship.
