# Coverage Baseline & Expectations
Date: 2026-05-16
Status: BASELINE — measured against Variant 3 (current semantic sidecar)

## Why this doc exists

Before extending arch-graph (FE extractor / Variant 2), we measured the current state on three real user projects with 26 real-history queries. This document fixes:
1. **The baseline** — what Variant 3 alone delivers, per project, per query category.
2. **The expected uplift** — what FE Level 1 and Variant 2 should each add.
3. **Acceptance bar for future work** — anything below the expected uplift is a regression vs. plan.

## Measurement methodology

- **Model**: `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, 384-dim, multilingual.
- **What is embedded**: each graph node label + kind + AST snippet (signature + first ~400 chars).
- **Test corpus**: 26 queries from user's real conversation history, classified into 5 categories.
  - A. Find functionality (e.g. «ручки СРМ — найди»)
  - B. Debug (e.g. «mssql агент ошибки логи»)
  - C. UI fix (e.g. «обрезать в 3 точки», «дровер справа»)
  - D. Deploy/commit — excluded (semantic layer cannot help here by design)
  - E. Architecture (e.g. «как работает синк MSSQL»)
- **Scoring**: top-5 inspected by hand against known correct file/component.
  - ★★★★★ — top-1 or top-2 is exactly correct
  - ★★★★ — exact answer in top-5
  - ★★★ — partial / related answer in top-5
  - ★★ — adjacent, score >0.5 but not directly the answer
  - ☆ — miss, top-5 unrelated
- **Pass threshold** for «hit»: ≥ ★★★★

## Baseline (Variant 3 only)

### Graph & sidecar sizes

| Project | TS files | Graph nodes | Edges | Sidecar | Build time |
|---|---|---|---|---|---|
| **platform** | 2,054 | 699 | 1,141 | 5.5 MB | 90 s |
| **insyra**  | ~1,800 | 897 | ~1,400 | 7.0 MB | 110 s |
| **beribuy 2.0** | ~500 | 144 | ~250 | 1.1 MB | 25 s |

### Hit rate by category (Variant 3 baseline)

| Project | A. Find | B. Debug | C. UI | E. Arch | **Overall hit** |
|---|---|---|---|---|---|
| platform | 60% (3/5) | 100% (3/3) | 30% (1/3 partial) | 75% (3/4) | **60% (9/15)** |
| insyra | 67% (4/6, 1 miss FE) | — | 17% (FE only) | — | **~50%** |
| beribuy 2.0 | — | — | — | — | **40% (2/5)** |

### Cross-project patterns confirmed

- **Score ≥ 0.55** → almost always exact hit (★★★★+).
- **Score < 0.40** → almost always miss.
- **NestJS canonical patterns** (Controller, Service, Module, Processor) → indexed exceptionally well.
- **DB tables, queues, NATS subjects** → high quality matches.
- **Multi-lingual queries (Russian)** → no quality drop vs. English.

### Known limitations (categories not addressed by Variant 3)

| Limitation | Affected categories | Why |
|---|---|---|
| Frontend components not in graph | C (UI) — 30% hit | arch-graph indexes only backend (NestJS / NATS / BullMQ / TypeORM / HTTP / TS imports). No `.tsx`/`.jsx` AST extraction. |
| REST endpoints (`@Get`/`@Post`) not nodes | A on REST-heavy projects (beribuy 2.0) | Existing "HTTP" extractor handles inter-service calls (caller → service), not endpoint definitions. |
| Config fields not nodes | Q like "redirect_url" | `@Config(...)` properties are not extracted as graph nodes. |
| Cross-cutting concepts (multi-tenancy) | E partial | Concept spread across 50+ files; no single anchor node. |
| Frontend routes / pages | A on FE-heavy queries | No router-pattern extractor. |
| Implementation details (CSS, text content) | C deep | Undecidable from AST alone. |

## Expected uplift per extension

### Extension A — FE Level 1 (React + Next pages/components/routes)

**Adds nodes**:
- `fe-page` — files in `pages/`, `app/`, `routes/` (Next-style or React Router)
- `fe-component` — `.tsx`/`.jsx` exporting a function/class returning JSX
- `fe-route` — Next router patterns (`pages/users/[id].tsx`, `app/users/[id]/page.tsx`)
- `fe-hook` — custom hooks (`useX`)

**Adds edges**:
- `fe-page` → `fe-component` (imports/uses)
- `fe-component` → `fe-component` (composition)
- `fe-route` → `fe-page` (routing)

**Expected node count growth**: +500-1500 per FE-heavy monorepo.

**Expected hit rate uplift**:

| Project | Baseline | + FE L1 | Δ |
|---|---|---|---|
| platform | 60% | **75-80%** | +15-20% |
| insyra | 50% | **70-75%** | +20-25% |
| beribuy 2.0 | 40% | **45%** | +5% (little FE) |

**Specific queries that should flip from ☆/★★ to ★★★+**:
- Q4 «карты в напоминаниях» → `fe-component:ReminderMap` (if exists)
- Q9 «3 точки в чатах» → `fe-component:ChatListItem`
- Q10 «дровер по клиенту» → `fe-component:ClientDrawer`
- Q11 «колонка статус» → `fe-component:ClientsTable` / `StatusColumn`
- Insyra Q «клиент таблица фронтенд» → fe-admin components

**Acceptance bar**:
- ≥ 70% hit rate on category C in platform after FE L1.
- ≥ 4 out of the 5 listed queries above must reach ★★★+.

### Extension B — Variant 2 (full): endpoint + module + config + scoped-marker extractors

**Adds nodes**:
- `endpoint` — each `@Get/@Post/@Patch/@Delete/@All` decorator → node with method, pattern, attachedTo controller class
- `config-field` — each property of a class decorated with `@Config()` or appearing in `ConfigService.get(...)` lookup → node
- `scoped-marker` — `@Scope(Scope.REQUEST)`, `@Inject(REQUEST)`, tenant context providers → node
- `db-entity-field` — fields of `@Entity()` classes → optional (heavy, may skip in v1)

**Adds edges**:
- `endpoint` → controller class (`attachedTo`)
- `endpoint` → service/repository call chain (best-effort, via existing DI)
- `endpoint` → `db-table` via repository (transitive through DI)
- `config-field` → consumer service/provider (`reads`)
- `scoped-marker` → host class

**Expected node count growth**: +800-1500 nodes (mostly endpoints for REST-heavy projects).

**Expected hit rate uplift**:

| Project | Baseline | + Var 2 full | Δ |
|---|---|---|---|
| platform | 60% | **75-80%** | +15-20% |
| insyra | 50% | **65-70%** | +15-20% |
| beribuy 2.0 | 40% | **65-70%** | +25-30% (endpoint-heavy) |

**Specific queries that should flip**:
- Q2 «redirect_url» → `config-field:OAUTH_REDIRECT_URL` (★★★★+)
- Q14 «multi-tenant tenant» → `scoped-marker:tenantContext` (★★★)
- platform Q3 «ручки СРМ» now gives exact `endpoint:GET /api/schedule` instead of just ServiceClass
- beribuy «корзина checkout», «оплата товара» — endpoint nodes appear if those handlers exist
- Most A-category queries should improve from top-3 service to top-1 endpoint+controller pair.

**Acceptance bar**:
- ≥ 80% hit rate on category A in platform after Var 2.
- ≥ 65% hit rate on beribuy 2.0 (currently 40%, sensitive to endpoints).
- Q2-equivalent config-field queries reach ★★★★+ on platform.

### Combined: FE L1 + Var 2

**Expected hit rate**:

| Project | Baseline | + FE L1 + Var 2 | Δ |
|---|---|---|---|
| platform | 60% | **85-90%** | +25-30% |
| insyra | 50% | **85%** | +35% |
| beribuy 2.0 | 40% | **70%** | +30% |

This is the target for the parallel-track implementation that follows this baseline.

## What we do NOT expect (out-of-scope, intentional)

- **CSS/Tailwind class extraction** — out of scope; semantically not the point.
- **Component text content** (literal strings in templates) — out of scope.
- **Runtime data flow** — handler logic tracing into backend is FE Level 3, not in this round.
- **Angular / Svelte / Vue** — only React + Next for FE Level 1. Other frameworks deferred.
- **Cross-monorepo edges** — D3 explicit non-goal from existing arch-graph charter.

## How regressions are caught

Each extension lands with:
1. **Per-extractor recall test** against a ground-truth set (≥ 95% recall, project-wide).
2. **One canonical hit test** per category — fails CI if score drops below 0.55 on golden queries.
3. **Re-run the 26-query suite** at the end of each extension and compare hit rates vs. this baseline.

## Maintenance

This document is the contract. When implementing FE L1 and Var 2:
- If actual uplift is **lower** than the expected range above for any project → revisit the implementation (likely missing patterns).
- If actual uplift is **higher** → great, but document why so we don't lose the trick.
- After both extensions ship, this doc gets a "Post-implementation" section comparing measured vs. expected.
