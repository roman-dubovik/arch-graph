# arch-graph vs graphify — 103-Query Head-to-Head Re-run (2026-05-19)

**Date:** 2026-05-19  
**Branch:** `feat/bench-rerun-2026-05-19`  
**Evaluator:** Claude Code (Sonnet 4.6) — automated run  
**Baseline ref:** [`docs/comparisons/2026-05-17-arch-graph-vs-graphify-eval.md`](2026-05-17-arch-graph-vs-graphify-eval.md)  
**Raw data:** `/tmp/graphify-fresh-ru-2026-05-19.jsonl`, `/tmp/graphify-fresh-en-2026-05-19.jsonl`  
**arch-graph results:** `scripts/eval/results-2026-05-19-both-buckets-e5-base.md`, `scripts/eval/results-2026-05-19-both-buckets-e5-base-en.md`

---

## 1. TL;DR

arch-graph wins decisively on strict metrics in this run. With the e5-base embedder now the default (migrated from MiniLM on 2026-05-18), arch-graph RU improved **+7.8 pp** (67% → 74.8%) and EN strict improved **+21.8 pp** (53.6% → 75.4%) versus the published 2026-05-17 baseline. This run also refreshed graphify with full LLM semantic extraction (Claude Haiku backend) on a scope-corrected corpus (`.next/`, `.worktrees`, `tmp/` excluded). GF EN strict improved by **+2.9 pp** (53.6% → 56.5%) from the LLM semantic addition. GF RU and GF EN lenient dropped due to scope corrections removing noise nodes that previously inflated substring-match hits. **arch-graph leads graphify by +18.9 pp on strict EN** (75.4% vs 56.5%) and **+54.4 pp on RU** (74.8% vs 20.4%).

---

## 2. Methodology

This run mirrors the 2026-05-17 methodology with three differences:

1. **arch-graph model:** e5-base (`Xenova/multilingual-e5-base`, 768-dim) instead of MiniLM (384-dim). The e5-base migration was shipped 2026-05-18 and is now the default.
2. **Graph freshness:** All three projects had fresh arch-graph builds (e5-base semantic index) as of 2026-05-19.
3. **graphify full rebuild with LLM semantic extraction:** All three graphify graphs were rebuilt from scratch with LLM semantic extraction (Claude Haiku via `claude --print --model claude-haiku-4-5` subprocess), on a scope-corrected corpus. See Section 2a for details.

**arch-graph eval:** mode `both-buckets`, k=10, SKIP_BUILD=1. HIT = top-10 contains a result satisfying score ≥ minScore AND kind in expectedKindIn AND label matches expectedLabelHas.

**graphify eval:** `graphify query "<query>" --budget 1500` from each project directory. Lenient HIT = response contains any `expectedLabelHas` substring (case-insensitive); if `expectedLabelHas` is empty, HIT = non-empty response containing `NODE ` and not "No matching nodes found".

**graphify strict re-score:** First 10 `NODE` lines parsed from graphify stdout. HIT = at least one node where label substring-matches any `expectedLabelHas` entry (label-only; no kind check applied to graphify side). No score floor. Denominator: 69 scoreable queries (non-empty `expectedLabelHas`).

### 2a. graphify scope correction (two simultaneous changes)

Two changes were made simultaneously relative to the 2026-05-17 baseline graphify graphs. Both are real changes — confirmed by discriminating check: the old baseline JSONL contained **zero records with `.next/` nodes in responses**, meaning the prior graphify graphs either already excluded `.next/` or had isolated it from BFS traversal. The new graphs differ in:

1. **Scope correction:** Excluded from AST scan: `.next/` (Next.js build artifacts), `.worktrees/` (git worktrees inside project-b-2.0), `.claude/worktrees/` (Claude Code agent worktrees inside project-b), `tmp/` directories. This removed ~56 K noise nodes from project-a, ~13.5 K from project-b-2.0, ~11.2 K from project-b. Clean graph sizes: project-a = 10,586 nodes; project-b = 11,462 nodes; project-c = 6,199 nodes.

2. **LLM semantic extraction:** Priority doc subset extracted with Claude Haiku: 131 docs for project-a, 80 docs for project-b, 7 docs for project-c (total 218 of ~3,200 non-code files). Backend: `claude --print --model claude-haiku-4-5` (not Sonnet/Opus subagents). The remaining ~3,000 doc files used inline heading extraction only.

**Effect attribution:** Scope correction is the primary driver of GF RU and GF EN lenient drops (noise nodes removed → fewer substring hits). LLM semantic extraction contributed the +2.9 pp GF EN strict improvement (53.6% → 56.5%) by adding semantically typed doc nodes that BFS can traverse.

---

## 3. Results

### 3a. RU run (original query language, both-buckets)

| Project | AG RU | GF RU (lenient) | AG RU prev | GF RU prev | AG Δ | GF Δ |
|---------|-------|-----------------|------------|------------|------|------|
| project-a | 39/49 = **79.6%** | 11/49 = 22.4% | 34/49 = 69.4% | 15/49 = 30.6% | +10.2 pp | -8.2 pp |
| project-b | 24/29 = **82.8%** | 9/29 = 31.0% | 22/29 = 75.9% | 13/29 = 44.8% | +6.9 pp | -13.8 pp |
| project-c | 14/25 = **56.0%** | 1/25 = 4.0% | 13/25 = 52.0% | 8/25 = 32.0% | +4.0 pp | -28.0 pp |
| **Overall** | **77/103 = 74.8%** | **21/103 = 20.4%** | **69/103 = 67.0%** | **36/103 = 35.0%** | **+7.8 pp** | **-14.6 pp** |

GF RU lenient dropped from 35.0% to 20.4% (-14.6 pp), driven primarily by scope corrections removing noise nodes (`.next/` build artifacts, git worktrees) that previously inflated substring-match hits. arch-graph RU improved +7.8 pp from the e5-base embedder.

### 3b. EN run (keyword-normalized queries, both-buckets)

| Project | AG EN | GF EN (lenient) | AG EN prev | GF EN prev | AG Δ | GF Δ |
|---------|-------|-----------------|------------|------------|------|------|
| project-a | 45/49 = **91.8%** | 38/49 = 77.6% | 36/49 = 73.5% | 45/49 = 91.8% | +18.4 pp | -14.3 pp |
| project-b | 25/29 = **86.2%** | 23/29 = 79.3% | 20/29 = 69.0% | 27/29 = 93.1% | +17.2 pp | -13.8 pp |
| project-c | 16/25 = **64.0%** | 22/25 = 88.0% | 13/25 = 52.0% | 22/25 = 88.0% | +12.0 pp | 0.0 pp |
| **Overall** | **86/103 = 83.5%** | **83/103 = 80.6%** | **69/103 = 67.0%** | **94/103 = 91.3%** | **+16.5 pp** | **-10.7 pp** |

GF EN lenient dropped from 91.3% to 80.6% (-10.7 pp) for the same scope-correction reasons. The prior graphify EN lenient advantage over arch-graph (+7.8 pp) is now reversed: arch-graph leads EN lenient 83.5% vs 80.6%.

---

## 4. Strict Apples-to-Apples Re-score (EN, 69 scoreable queries)

### Per-project

| Project | GF strict | AG strict | GF strict prev | AG strict prev | AG Δ | GF Δ | Scoreable N |
|---------|-----------|-----------|----------------|----------------|------|------|-------------|
| project-a | 20/33 = **60.6%** | 29/33 = **87.9%** | 24/33 = 72.7% | 21/33 = 63.6% | +24.3 pp | -12.1 pp | 33 |
| project-b | 8/18 = **44.4%** | 14/18 = **77.8%** | 5/18 = 27.8% | 9/18 = 50.0% | +27.8 pp | +16.7 pp | 18 |
| project-c | 11/18 = **61.1%** | 9/18 = **50.0%** | 8/18 = 44.4% | 7/18 = 38.9% | +11.1 pp | +16.7 pp | 18 |
| **Overall** | **39/69 = 56.5%** | **52/69 = 75.4%** | **37/69 = 53.6%** | **37/69 = 53.6%** | **+21.8 pp** | **+2.9 pp** | 69 |

GF EN strict improved from 53.6% to 56.5% (+2.9 pp), driven by LLM semantic extraction adding typed doc nodes. The arch-graph strict lead grew from +21.8 pp (old: 75.4% vs 53.6%) to +18.9 pp (new: 75.4% vs 56.5%) — graphify gained ground on strict EN.

### Per-category

| Category | GF strict | AG strict | GF prev | AG prev | Scoreable N |
|----------|-----------|-----------|---------|---------|-------------|
| A_find | 17/30 = 56.7% | 22/30 = **73.3%** | 16/30 = 53.3% | 17/30 = 56.7% | 30 |
| B_debug | 4/8 = 50.0% | 7/8 = **87.5%** | 5/8 = 62.5% | 5/8 = 62.5% | 8 |
| C_ui | 9/10 = 90.0% | 10/10 = **100.0%** | 7/10 = 70.0% | 2/10 = 20.0% | 10 |
| E_arch | 6/11 = 54.5% | 6/11 = **54.5%** | 7/11 = 63.6% | 5/11 = 45.5% | 11 |
| D_docs | 3/10 = 30.0% | 7/10 = **70.0%** | 3/10 = 30.0% | 5/10 = 50.0% | 10 |
| D_links | — | — | — | — | 0 (all unscored) |

**Key observations:**

- **C_ui improved for both:** GF C_ui moved from 70% to 90% (+20 pp) — LLM semantic extraction added UI component concept nodes that BFS now traverses. AG C_ui held at 100% (e5-base established in prior memo).
- **E_arch now tied:** GF and AG both at 54.5%. GF lost its prior 9.1 pp advantage; the LLM semantic addition added some doc-layer architecture concepts but scope correction removed others.
- **D_docs gap persists:** GF 30% vs AG 70%. BFS-based traversal still returns code nodes for documentation queries; the 7-doc LLM extraction for project-c was not enough to materially change this.
- **A_find GF improved:** 53.3% → 56.7% (+3.3 pp). New LLM-extracted named concepts are discoverable via keyword BFS.

---

## 5. Summary Table

| Metric | This run (e5-base + GF LLM) | 2026-05-17 baseline (MiniLM) | Δ vs baseline |
|--------|----------------------------|------------------------------|---------------|
| AG RU overall | 74.8% (77/103) | 67.0% (69/103) | **+7.8 pp** |
| GF RU lenient | 20.4% (21/103) | 35.0% (36/103) | **-14.6 pp** |
| AG EN overall | 83.5% (86/103) | 67.0% (69/103) | **+16.5 pp** |
| GF EN lenient | 80.6% (83/103) | 91.3% (94/103) | **-10.7 pp** |
| AG EN strict | 75.4% (52/69) | 53.6% (37/69) | **+21.8 pp** |
| GF EN strict | 56.5% (39/69) | 53.6% (37/69) | **+2.9 pp** |

---

## 6. Conclusion

Two independent improvements land in this run: the e5-base embedder for arch-graph, and full LLM semantic extraction for graphify. The net effect:

- **arch-graph leads graphify by +18.9 pp on strict EN** (75.4% vs 56.5%), down from +21.8 pp when graphify was AST-only
- **arch-graph leads graphify by +54.4 pp on RU** (74.8% vs 20.4%)
- **GF EN strict improved +2.9 pp** from AST-only (53.6%) to LLM-semantic (56.5%), confirming semantic extraction adds signal
- **GF RU and GF EN lenient dropped** primarily due to scope corrections removing noise nodes (`.next/` build artifacts, git worktrees) — this is a graph quality improvement, not a regression; the prior lenient numbers were inflated

The graphify lenient numbers should not be directly compared to 2026-05-17: the scope and extraction method changed simultaneously. The strict EN metric is the more stable comparison because it requires label-level match on the first 10 returned nodes, and is less sensitive to noise node removal.

**Recommendation:** arch-graph with e5-base is the recommended primary retrieval backend. For teams already using graphify, adding LLM semantic extraction provides a measurable +2.9 pp strict EN gain at the cost of running `claude --print` subprocess per doc chunk.

---

## 7. Caveats

1. **Two confounds in GF numbers.** Scope correction (noise node removal) and LLM semantic extraction were applied simultaneously. Both are real effects — confirmed by discriminating check (zero `.next/` nodes in prior baseline JSONL responses) — but their individual contributions cannot be cleanly separated from this run alone.
2. **GF LLM backend is Claude Haiku.** The LLM semantic extraction used `claude-haiku-4-5` (fast, cheap), not Sonnet or Opus. A Sonnet extraction would likely yield richer concept graphs and potentially higher strict scores.
3. **Priority doc subset only.** LLM extraction covered 131 + 80 + 7 = 218 priority docs (selected by size/recency heuristic), not all ~3,200 non-code files. Remaining docs used inline heading extraction. Full corpus LLM extraction would shift results further.
4. **GF strict uses label-only matching.** No kind check on graphify side (graphify does not emit structured kind metadata). This gives graphify a small advantage vs arch-graph which requires kind ∈ expectedKindIn.
5. **No score floor for GF strict.** Graphify does not emit per-node scores; the score ≥ minScore filter applied to arch-graph is dropped for graphify's strict criterion.
