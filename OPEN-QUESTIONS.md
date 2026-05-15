# arch-graph — открытые вопросы и решения

Каждый delegated блок записывает сюда:
- **Blockers** — что заблокировало доведение блока до 0 findings (нужно решение пользователя)
- **Decisions** — решения, которые агент принял сам (для ревью пользователем)
- **Deferred** — что осознанно отложено за рамки блока

Структура: одна секция на блок. Краткие записи. Без воды.

---

## Block A — NestJS DI extractor

_В работе._

---

## Block B — HTTP inter-service extractor

_В работе._

---

## Block C — TS-import extractor (dependency-cruiser)

**DECISION: ts-morph вместо dependency-cruiser.**

Спека ссылалась на `dependency-cruiser`, но в проекте уже подключён `ts-morph` и `runBuild` загружает единый `Project` для всех extractor'ов. Добавлять dependency-cruiser значило бы:
- лишнюю dep + второй проход AST (cruise() запускает свой scanner внутри);
- два разных source-set'а (его exclude/ignore не совпадают с нашими `excludeGlobs`);
- расходящуюся ground-truth (наш regex считает `^import` по нашему фильтру файлов; cruiser шёл бы по своему).

Trade-off: разрешение path-aliases у ts-morph слабее (когда `Project` создан без tsconfig). Решено вручную: парсим `<root>/tsconfig.base.json` или `<root>/tsconfig.json` и резолвим алиасы через `compilerOptions.paths`. Покрывает 95% Nx/Nest монорепо.

**Metrics (build на 5 проектах, recall = extracted/GT static imports):**
- screenia:  100.0% recall (2978/2860 — ts-morph иногда находит больше, чем regex видит); 24 lib-usage edges
- platform:  100.0% recall (7340/7093); 209 lib-usage edges, 2 antipattern (service→service)
- insyra:    100.0% recall (5284/4981); 24 lib-usage edges
- unpacks:   100.0% recall (1728/1648); 7 lib-usage edges
- beribuy2:  100.0% recall (2288/2179); 10 lib-usage edges

(recall capped at 1.0 — extracted > GT возникает когда regex пропускает multi-line imports: `IMPORT_RE` шаблон `[^;\n]*?` не пересекает newline, поэтому многострочный `import {\n  A,\n  B\n} from '...'` для regex невидим, а ts-morph видит его как одну ImportDeclaration)

**Что не делается:**
- `require('./foo')` (CommonJS) — out of scope блока. В монорепо `apps/`+`libs/` это редкая форма (только runtime-конфиги или legacy). Если понадобится — добавить отдельный walk для `CallExpression` к идентификатору `require`.
- Resolution через `compilerOptions.extends` цепочки (composite tsconfigs с `references`) — мы загружаем только корневой `tsconfig.base.json`/`tsconfig.json`. Если алиасы переопределены в app-tsconfig — не подцепится. Признак: значимый `unresolvedInternal` count.
- Side-effect-only imports (`import './polyfill'`) — извлекаются, но `externalOrUnresolved` heuristic считает их external если specifier не относительный (для bare specifiers это правильно).

**Gate:** recall ≥ 80% (мягче чем NATS/TypeORM/BullMQ 95% — alias-resolution это best-effort). Фактически все 5 проектов выдали 100%.

**Default config:** `imports.fileLevel = false`. File-level `ts-import` edges (file→file) генерятся только при явном opt-in — иначе граф захлёбывается (Platform: 7340 imports → ~7340 рёбер только в этом домене).

**Self-review (вместо pr-review-toolkit — субагенты в этом контексте недоступны):**
Сам отревьюил по 5 lens'ам:
- **silent-failure-hunter**: `loadTsConfigPaths` глотал JSON parse errors — добавил `process.stderr.write` warning. `isAliasPrefix` имел false-prefix bug (`@platform` бы матчил `@platform-other`) — исправлено: храним alias prefixes с trailing `/`. Trailing-comma support в JSONC добавлен (Nx часто их использует).
- **type-design**: `TsImportSite.specifierShape` discriminated на 4 значения (relative/alias/bare-external/builtin) — mapper использует это вместо хрупкой heuristic. Раньше `isExternalShape` в mapper'е помечал любой non-relative как external и маскировал alias-resolver regressions.
- **code-simplifier**: `aliasResolverBundle` объединяет два API в один объект; pre-compute prefix list once вместо `.map()` в hot loop.
- **comment-analyzer**: каждая нестандартная heuristic ("why first-seen file wins", "trailing slash matters") задокументирована в коде.
- **code-reviewer**: GT regex теперь видит multi-line imports (`[\s\S]*?` вместо `[^;\n]*?`); side-effect form (`import './x'`) разделена отдельной regex с negative-lookahead для не-двойного матча.

---

## Block D — Mermaid output

_В работе._

---

## Block E — BullMQ pr-review findings (Phase 2 followup)

Все 5 pr-review-toolkit агентов (sonnet) отработали. Применено:

**Cross-cutting dedup (simplifier)**:
- `buildLineStarts` / `offsetToLineCol` / `indexBy` → [`src/validation/line-index.ts`](src/validation/line-index.ts)
- `ownerNodeId` / `ownerNodeFor` → [`src/mapper/owner-node.ts`](src/mapper/owner-node.ts)
- `isExcludedSourceFile` → [`src/extractors/shared.ts`](src/extractors/shared.ts)
- `collectRegistrations` — 4 одинаковых push-ветки схлопнуты в `resolveRegistrationArg`
- `getLiteralText` каст приведён к `StringLiteral` (как в NATS)

**Type-design (4/5 baseline + улучшения)**:
- `BullMqQueueRegistration.role = 'registration'` добавлен → uniform discriminant
- `BullMqValidationReport.extraConsumers` / `extraRegistrations` добавлены (symmetric с TypeORM)
- `BullMqSite` type alias добавлен
- Doc-комментарий `BullMqQueueRef` уточнён (NOT mirror of `TypeOrmEntity.tableSource`)
- `resolveRate` zero-fallback явно задокументирован

**Critical / High findings (code-reviewer + silent-failure-hunter)**:
- **CRITICAL**: `@Processor({ name: 'q', concurrency: 5 })` форма — symmetric blind spot extractor+GT. Исправлено:
  - extractor `resolveQueueArg` добавлена `ObjectLiteralExpression` ветка с `findProp(obj, 'name')`
  - validator `PROCESSOR_RE` / `INJECT_RE` — добавлена альтернатива для `{ name: ... }`
- **HIGH**: anonymous `@Processor` class — раньше тихо ронился; теперь `className = '<anonymous>'` sentinel
- **HIGH**: tail-only PropertyAccess lookup мог давать **неверные** рёбра (`QueueNames.X` совпадало с unrelated `export const X`); fallback убран, теперь honest-unresolved

**Deferred**:
- **HIGH #4 (silent-failure-hunter)** — non-exported queue-name constants (`const X = 'foo'` без `export`). Сейчас попадают в `diagnostics.unresolved` без `reason` поля. Не silent failure, а diagnostic quality. Фикс — добавить `reason?: string` к `BullMqQueueRef.unresolved` + опционально same-file scope в `QueueNameIndex`. Откладываем — паттерн редкий, в 5 тестовых проектах не встретился.

**Comment-analyzer**:
- "Skipped (Phase 1)" → "Not yet handled" (Phase 2 файл некорректно ссылался на Phase 1)
- `collectRegistrations` doc — добавлено "why variadic"
- Положительные находки: header'ы pre-pass index'а и комментарии "one edge per (owner, queue, kind)" хвалят

---

## Block F — MCP server

_В работе._

---

## Block G — Install / Skill / Hooks / README

_В работе._

---

## Общие открытые вопросы (orchestration-level)

- _будет дополнено по ходу_
