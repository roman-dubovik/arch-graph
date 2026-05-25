# Design: Heritage-aware Code Intelligence (code-intel-heritage-v1)

Date: 2026-05-25
Status: design (not yet implemented)
Branch: `feat/code-intel-heritage-v1` (to be created in new session)

## Goal

Make the code-intel sidecar correctly model TypeScript class inheritance. Currently every class is an isolated symbol with no awareness of `extends`. On real NestJS monorepos (target-monorepo codebase: 48741 symbols, 4485 false-positive "dangerous collisions" in `self_check`), this causes:

- `self_check` reports thousands of bogus structural-name collisions for subclass methods that only decorator-wrap `super.X(...)` calls.
- `find_references('BaseController.createEntity')` returns nothing — `super` calls are not edges in the call graph.
- `trace_scenario('AreaController.createEntity')` stops at the subclass — cannot traverse through `super` into the base body.
- `get_type_definition('AreaController')` shows only own members, not the inherited API surface.
- `impact_contract('AreaCreateDto.email')` misses transitive impact through generic base classes.

After this work each of those queries returns the right answer, and `self_check` only flags real silent-wrong-answer risks.

## Out of scope

- Interface inheritance (`A implements I`) — no body to delegate to, separate concern.
- Mixins, dynamic class composition (`Mixin(Base)(MoreBase)`).
- JavaScript prototype manipulation.
- Decorator-inheritance semantics across class hierarchies — partially handled by existing NestJS extractors, not regressed here.

## Required input data (READ BEFORE STARTING)

Before any implementation, the user pastes the output of the data-gathering prompt (see end of this doc) into:

  `.local-plans/2026-05-25-monorepo-heritage-data.md`

That file contains concrete file paths, code snippets, and patterns from the real target-monorepo monorepo. Implementation choices depend on it (path-alias resolution, generic depth, multi-level inheritance presence, `replaced`-override frequency).

**If that file is missing when the session starts, STOP and ask the user before proceeding.** Don't guess at edge cases.

## Acceptance criteria

### A — Extractor (data model)

**A1.** `CodeIntelSymbol` for `kind: 'class'` adds optional fields:
- `extendsClass?: string` — composite id of the extended class
- `extendsTypeArgs?: string[]` — generic type arguments as written, e.g. `['AreaEntity', 'AreaCreateDto']`

**A2.** `CodeIntelSymbol` for `kind: 'method' | 'field'` adds optional fields:
- `inheritsFrom?: string` — composite id of the base member when the subclass redeclares a member that also exists in the base
- `overrideKind?: 'delegation' | 'augmented' | 'replaced'` — classified from body:
  - `delegation` — body is exactly `return super.X(...)` or `return await super.X(...)` with identity-passthrough of arguments (same param names, no transform)
  - `augmented` — calls `super` but the body has other statements (validation, mapping, logging, try/catch, transformed args)
  - `replaced` — does not reference `super` at all

**A3.** `CodeIntelCall` adds `kind: 'super-call'`. For every `super.X(...)` site, emit one call edge from the subclass method to the resolved base method. The `expression` field stores the literal `super.X(args)` text.

**A4.** Cross-file base class resolution works for:
- Same-package relative imports (`../base/base.controller`)
- tsconfig path aliases (`@workspace/common-backend/*`)
- Monorepo workspace packages (`@org/common`)
- (Bare npm packages out of scope — base class must be in the workspace)

**A5.** Generic type-arg propagation: `extendsTypeArgs` captured even for multi-level chains. When base uses `this.repository: Repository<T>` and subclass instantiates `BaseController<AreaEntity>`, downstream resolvers can substitute `T → AreaEntity`. Use ts-morph type-checker (`--with-types`) for cross-file generic resolution; fall back to text-level capture if the checker can't resolve.

**A6.** Multi-level inheritance: `A extends B extends C` — each subclass points to its direct parent; resolver can climb the chain.

**A7.** Per-class isolation: a heritage-resolution failure on one class goes into `manifest.warnings.skippedFiles` (or new `skippedClasses` if file-level granularity is too coarse — decide based on target-monorepo data) and other classes still extract correctly.

### B — Queries (downstream behavior)

**B1.** `resolve_symbol('<X>.<method>')` — when the result set includes both `delegation` wrappers and a `replaced`/`augmented` real impl, rank real impls higher; delegations carry `note: 'decorator wrapper, delegates to <base id>'`.

**B2.** `get_type_definition('<SubClass>')` returns:
- `members: [...]` — own members (existing)
- `inheritedMembers: [...]` — members inherited from base classes (climbing the `extends` chain) not overridden locally; each labeled `inheritedFrom: '<base id>'`
- For overridden members in `members[]`: `inheritedFrom` and `overrideKind` fields set

**B3.** `find_references('<BaseClass>.<method>')` returns:
- Direct callers in the base file
- All `super-call` sites from subclasses
- HTTP/MCP routing sites pointing at subclass decorator-wrappers (the LLM sees the full reachability set)

**B4.** `find_references('<SubClass>.<method>')` where `overrideKind: 'delegation'` returns:
- Direct decorator-routed callers (HTTP routes, NATS handlers)
- `viaDelegation: true` flag — consumer knows the impl lives elsewhere

**B5.** `trace_scenario('<SubClass>.<method>')` follows `super-call` edges into base, then continues through base body normally.

**B6.** `explain_data_flow(target: '<SubClass>.<method>', param: 'dto')` follows the dto through `super.<method>(dto)` into base, then into base's logic. When base uses `this.repository: Repository<T>` and subclass binds `T = AreaEntity`, resolve to the concrete `AreaRepository`.

**B7.** `impact_contract('<Dto>.<field>')` finds uses including those through delegation chains and generic-typed base methods.

**B8.** `self_check` partition: a `<X>.<method>` collision is **not** `dangerous` when ALL N duplicates satisfy BOTH:
- `inheritsFrom` points to the same base member, AND
- `overrideKind === 'delegation'`

Class-level collisions (two `AreaController` in different files / microservices) **stay** dangerous — that's a real disambiguation problem.

Real collisions (at least one duplicate has `overrideKind: 'augmented' | 'replaced'`) **stay** dangerous.

### C — MCP tool descriptions

**C1.** `get_type_definition` — "Returns both own members and inherited members from base classes (resolved through the `extends` chain). Inherited members carry an `inheritedFrom` reference."

**C2.** `find_references` — "Includes `super-call` sites for base-class members and the routing sites that reach base through decorator-wrapper subclasses."

**C3.** `self_check` — explain that inheritance-based delegation collisions are filtered as expected; document the kept (real) categories.

**C4.** `resolve_symbol` — clarify that for ambiguous class name (e.g., `AreaController` in multiple services), composite `id` disambiguates; for inheritance, both base and subclass entries are returned with relationship labels.

## File-touch matrix

| Phase | File | Touches |
|---|---|---|
| A1, A2 | `src/code-intel/types.ts` | add `extendsClass`, `extendsTypeArgs`, `inheritsFrom`, `overrideKind` fields |
| A1 | `src/code-intel/extractor.ts` | new `extractHeritage()` pass on each class |
| A2 | `src/code-intel/extractor.ts` | body-classifier for `delegation` / `augmented` / `replaced` |
| A3 | `src/code-intel/extractor.ts` | super-call edge emission inside `collectFunctionFacts` |
| A4 | `src/code-intel/extractor.ts` (+ possibly `src/extractors/imports/*`) | cross-file base resolver — reuse existing tsconfig-path-alias machinery |
| A5, A6 | `src/code-intel/extractor.ts` | generic resolution + multi-level chain walk |
| A7 | `src/code-intel/extractor.ts` | per-class try/catch isolation in heritage pass |
| B1 | `src/code-intel/queries.ts` | `resolveSymbol` rank tweak |
| B2 | `src/code-intel/queries.ts` | `getTypeDefinition` inherited-members logic |
| B3, B4 | `src/code-intel/queries.ts` | `findReferences` super-edge inclusion |
| B5–B7 | `src/code-intel/queries.ts` | `traceScenario` / `explainDataFlow` / `impactContract` follow super-edges and resolve generics |
| B8 | `src/code-intel/queries.ts` | `selfCheck` partition with new fields |
| C1–C4 | `src/mcp/server.ts` | tool description updates |
| tests | `src/code-intel/extractor.test.ts` | acceptance tests using sanitized fixtures |
| tests | `src/code-intel/queries.test.ts` | tests for inheritance-aware query behavior |
| fixtures | `src/code-intel/__fixtures__/heritage/*` | minimal NestJS-style fixture monorepo |

## Phases (execution order)

### Wave 1 — Data model + extraction (sequential within wave)

| Task | Owner | Time | Description |
|---|---|---|---|
| 1.1 | sonnet | 3h | A1, A4 — class heritage detection + cross-file base resolution. RED tests first. |
| 1.2 | sonnet | 4h | A2 — method `inheritsFrom` + body classifier for the 3 override kinds. RED tests with 3 body shapes. |
| 1.3 | sonnet | 2h | A3 — super-call edges in calls.jsonl. RED tests. |
| 1.4 | sonnet | 2h | A5, A6 — generics resolution + multi-level chains. |
| 1.5 | haiku | 1h | A7 — per-class try/catch isolation in heritage pass. |

**QG after Wave 1:** tsc green + full suite + real target-monorepo `code-intel build` produces non-empty `extendsClass` / `inheritsFrom` fields on ≥10 sampled symbols (verify with python script over `symbols.jsonl`).

### Wave 2 — Query consumers (mostly parallel)

| Task | Owner | Time | Description |
|---|---|---|---|
| 2.1 | sonnet | 2h | B2 — `get_type_definition` |
| 2.2 | sonnet | 2h | B3, B4 — `find_references` |
| 2.3 | sonnet | 3h | B5–B7 — `trace_scenario` / `explain_data_flow` / `impact_contract` |
| 2.4 | haiku | 1h | B1 — `resolveSymbol` rank |
| 2.5 | haiku | 30min | B8 — `selfCheck` filter |

**QG after Wave 2:** tsc + suite + real target-monorepo `code-intel self-check` returns `status: "ok"` OR `status: "degraded"` with only LEGITIMATE collisions (e.g., truly duplicate `AreaController` across microservices, NOT delegation wrappers).

### Wave 3 — Polish

| Task | Owner | Time | Description |
|---|---|---|---|
| 3.1 | haiku | 30min | C1–C4 — MCP descriptions |
| 3.2 | sonnet | 1h | docs — README "What's new" entry, ROADMAP shipped entry, landing recent-section entry. All claims verified against actual commits. |

### Wave 4 — Verification (mandatory)

- **Phase 5:** pr-review-toolkit (code-reviewer + silent-failure-hunter) on full diff. Re-review after any P0/P1 fix.
- **Phase 6:** fix loop until 0 P0+P1.
- **Phase 7:** advisor gate before merge.
- **Phase 8:** real target-monorepo smoke — `code-intel build && self-check && resolve_symbol AreaController.createEntity && trace_scenario AreaController.createEntity` — verify each query returns the expected new behavior (capture before/after diff).
- **Phase 9:** merge to main (with PR or direct push per session-end conversation).

## Test strategy

### Unit tests (vitest, fast)
Per acceptance criterion A1–A7 and B1–B8 — RED test first. Fixtures use synthetic generic names (`FooController`, `BarService`), no real target-monorepo identifiers.

### Acceptance tests (vitest, full extractor pipeline)
Build a minimal fixture monorepo at `src/code-intel/__fixtures__/heritage/`:

```
__fixtures__/heritage/
  base/
    base.controller.ts        # BaseController<T, CreateDto, UpdateDto> with 5 CRUD methods
    protected.controller.ts   # extends BaseController, adds auth middleware (multi-level)
  area/
    area.entity.ts
    area.dto.ts               # AreaCreateDto, AreaUpdateDto
    area.controller.ts        # extends BaseController<AreaEntity, AreaCreateDto, AreaUpdateDto>
                              # all 5 methods pure-delegation with @Get/@Post decorators
  engagement/
    engagement.controller.ts  # extends BaseController, 3 delegation + 2 augmented
                              # one with logger.log before super, one with validation
  audit/
    audit.controller.ts       # extends ProtectedController extends BaseController (multi-level)
                              # one method `replaced` (no super)
  index.ts                    # barrel
```

Run real extractor against this fixture, assert resulting symbols/calls match expected heritage shape.

### Real-repo smoke (manual + scripted)
After Wave 2, run on real target-monorepo. Document expected diff in a shell script `scripts/verify-heritage-on-monorepo.sh` for anyone with the target-monorepo checkout. Expected outcomes:
- `self_check.warnings.dangerousCollisions.length` drops from ~4485 to <100
- `resolve_symbol('BaseController.createEntity')` returns the base implementation as primary match
- `trace_scenario('AreaController.createEntity')` shows the `super-call` edge into base
- `get_type_definition('AreaController')` shows `inheritedMembers` with proper labels

## Risks

1. **ts-morph generic resolution.** `BaseController<T extends BaseEntity, CreateDto extends BaseDto>` with chained substitution can be tricky. Fallback: if type-checker fails, store raw type-arg text without resolution; downstream tools degrade gracefully (still know "inherits from BaseController", just don't know concrete `T`).

2. **Performance.** Heritage resolution adds per-class type-checker calls. Mitigation: only invoke type-checker when an `extends` clause is present AND the base name is not in the current file. Existing `--with-types` gate is accepted at ~5x slowdown — same penalty acceptable here.

3. **`super.X(transformedArg)` classification.** If subclass changes the argument before passing it: decision is `argument identity-passthrough (same param name, no transform) = delegation`; ANY transform / extra statement = `augmented`. Documented in the classifier code.

4. **Cross-package path-alias resolution.** target-monorepo likely uses `@workspace/common-backend` or similar. Resolver must consult `tsconfig.json` `paths`. We already do this in import-graph extractor; reuse that util — don't write a parallel resolver.

5. **Backward compat.** All new symbol fields are optional → existing consumers ignore them. Schema version stays at `2` (no break). Manifest `warnings` shape stays the same; we just filter `dangerousCollisions` differently.

6. **Sanitization regression risk.** Fixtures must NEVER include real target-monorepo class/file names. Sanitization gate (existing) catches this — re-run after fixture creation.

## Patterns to follow

- TDD: every change ships with RED tests written **first** by the team-lead, then dispatched to implementation agents.
- Sanitization: NO real target-monorepo identifiers in tracked code/tests/fixtures.
- Atomic writes (existing): no change.
- Per-file isolation (existing): heritage pass also wrapped in per-class try/catch.
- Composite IDs (existing): all new cross-refs use composite ids, not short fqns.

## Open questions (answered by target-monorepo data file)

1. How does target-monorepo import its base controller? (Path alias? Bare package? Relative?) → `.local-plans/2026-05-25-monorepo-heritage-data.md` §5
2. Does target-monorepo use multi-level inheritance (`A extends B extends C`)? → §6
3. Does target-monorepo have `replaced` overrides (no super call)? → §3
4. Are there generic-type-arg cases that don't resolve via ts-morph alone? → §7
5. What's the actual structure of the `*Cmd` static fields shown in `dangerousCollisions`? → §8

These shape Phase A's implementation. Without them, implementation has to guess at edge cases — don't.

---

## Appendix — Data-gathering prompt for the user's LLM

Copy this verbatim into Claude Code / Cursor running on the target-monorepo monorepo. Save the LLM's output as `.local-plans/2026-05-25-monorepo-heritage-data.md` in the arch-graph repo before starting the implementation session.

```
Контекст: я разрабатываю инструмент arch-graph — статический extractor TypeScript-кода в граф для NestJS-монорепов. Хочу добавить осознанность наследования: чтобы инструмент понимал, что AreaController extends BaseController<AreaEntity>, и что метод AreaController.createEntity на самом деле делегирует в BaseController.createEntity.

Чтобы спроектировать корректно, мне нужны реальные данные из этого монорепа. Пройдись по коду (Grep + Read, не угадывай) и собери следующие 8 секций. В каждой — конкретные file:line ссылки и code excerpts, НЕ пересказ.

## 1. Base controllers / services

Найди все классы, которые служат базой для других controllers/services. Признаки: имя с префиксом Base*/Abstract*/Generic*, явно generic-параметризованные классы, классы которые расширяются 3+ subclass'ами. Для каждого:
- Полный путь к файлу (от корня монорепа)
- Generic-параметры в объявлении (например `<T extends BaseEntity, CreateDto extends BaseDto, UpdateDto extends BaseDto>`)
- Список публичных/protected методов (имя + сигнатура — возвращаемый тип + параметры)
- Как методы используют generics в теле — покажи 1-2 примера с `this.repository: Repository<T>`, `this.mapper.toEntity(dto)` и т.п.

## 2. Concrete subclasses

Для каждого base из §1 найди 2-3 конкретных subclass:
- Полный путь
- Точная строка `extends ...` (с type args, например `extends BaseController<AreaEntity, AreaCreateDto, AreaUpdateDto>`)
- Как импортируется base — точная строка `import { BaseController } from '...'` (хочу видеть alias)
- Полное тело 3-х переопределённых методов (с декораторами)

## 3. Pattern классификация overrides

Из найденных методов классифицируй каждый по 3 категориям:
- **Pure delegation** — тело это РОВНО `return super.X(...)` или `return await super.X(...)`, аргументы передаются без изменений, никаких других statements кроме super-call
- **Augmented** — вызывает super, но добавляет логику (validation, mapping, logging, try/catch, трансформация аргумента)
- **Replaced** — НЕ вызывает super вообще, своя реализация

Для каждой категории дай 1-2 примера с полным телом метода + file:line.

Грубые оценки: сколько процентов в каждой категории (примерно — посчитай в одном-двух subclass'ах).

## 4. Cross-file class name collisions

Есть ли в монорепе разные файлы с классом одинакового имени? Например, два `AreaController` в разных микросервисах/bff-сервисах.

- Для топ-10 случаев: list file paths

Это НЕ inheritance — это копии или похожие сущности в разных доменах.

## 5. Cross-package inheritance — конкретный пример резолюции импорта

Возьми один subclass из §2 у которого base в другом package. Покажи:
- Файл subclass: path + строка `import { BaseController } from '<X>'`
- Файл base: фактический путь к файлу
- `tsconfig.json` (или ближайший наследуемый): секция `paths` целиком, или scope того alias что используется
- Если monorepo workspace — какая конфигурация (`pnpm-workspace.yaml` / `nx.json` / `lerna.json` / `workspaces` в `package.json`)

## 6. Двойное (или больше) наследование

Есть ли цепочки A extends B extends C? Если да — приведи 1-2 примера с полными путями всех классов и кратким описанием что добавляет каждый уровень. Если нет — напиши явно «нет, цепочки наследования глубиной максимум 2».

## 7. Generic-resolved data flow

Возьми один base class который использует generic в типах полей (`this.repository: Repository<T>`, `this.mapper: Mapper<T, CreateDto>`, и т.п.). Покажи цепочку для одного конкретного subclass:

- Base: где объявлено `this.repository: Repository<T>`
- Subclass: как T инстанцируется (`extends BaseController<AreaEntity, ...>`)
- Concrete: как `Repository<AreaEntity>` получает реальную имплементацию (DI? constructor injection? фабрика?). Покажи `@InjectRepository(AreaEntity)` или эквивалент в module.

Цель: понять, можно ли через ts-morph type-checker дойти от `super.create(dto)` в base до `AreaRepository.save(dto)` в реальной БД-сессии.

## 8. *Cmd / static field pattern

В выводе arch-graph встречаются `AreaController.createEntityCmd`, `AreaController.getEntitiesByIdsCmd`. Что это такое?

- Покажи один controller и **полные** декларации всех его `*Cmd` штук
- Это static fields? Class properties? Const-инициализация декораторов?
- Откуда они берутся — есть ли base class который их объявляет? Или код-генератор?

---

**Формат вывода:** один markdown файл с заголовками §1–§8, каждый раздел содержит конкретный код (с file:line), не пересказ. Я скопирую его целиком.

**ВАЖНО:** 
- НЕ угадывай и НЕ обобщай. Только то что физически нашёл в коде, с цитатами.
- НЕ скрывай реальные имена (`AreaController`, `BaseController`, etc.) — для этой задачи мне нужны реальные данные. Файл будет храниться локально, не в git.
- Если в какой-то секции данных нет (например, нет двойного наследования) — явно напиши «не нашёл, искал по таким-то критериям».
```
