# arch-graph — открытые вопросы и решения

Каждый delegated блок записывает сюда:
- **Blockers** — что заблокировало доведение блока до 0 findings (нужно решение пользователя)
- **Decisions** — решения, которые агент принял сам (для ревью пользователем)
- **Deferred** — что осознанно отложено за рамки блока

Структура: одна секция на блок. Краткие записи. Без воды.

---

## Block A — NestJS DI extractor

**Status**: landed. 5/5 проектов green (recallModules 100%, recallImports/Providers/Exports/Controllers 100%, resolveRate 98.7-100%).

**Decisions (агент сам принял)**:

1. **`di-controller` edge — оставлен в первой версии** (не отложен). Спец говорит "optional, nice-to-have" — но семантика очень дешёвая, и controllers в графе очевидно полезны для "кто слушает HTTP". Эджей мало (~25-110 на проект), отдельный `EdgeKind` оправдан.

2. **`useExisting → providerKind: 'existing'`** (отдельный kind, не `class`). Хоть архитектурно `useExisting` всегда указывает на класс, разница важна для visualization: `useExisting` — это alias-injection, не declaration. Сохраняем nuance в `meta.providerKind`.

3. **`forRoot()` / `forRootAsync()` / `registerQueue()` etc. — все treat as `dynamic` ref kind**, callee root identifier = module class. Args не парсятся (`useFactory: () => ({...})` — body не нужен для архитектуры).

4. **Field-presence ground truth (не entry-count)**. Из 4 возможных GT-уровней (modules, fields, entries, resolve) выбраны 3: modules + fields + resolveRate. Подсчёт array-entries отдельной regex — невозможен без AST из-за multiline, comments, spreads. Это путь к hidden recall regressions; GT нарочно ограничен тем, что regex может надёжно посчитать.

5. **Brace-balanced scan для field-GT — не plain regex**. `BullModule.registerQueueAsync({ imports: [ConfigModule], ... })` инсайд `@Module({...})` имеет nested `imports:` — не наша архитектура. Скан только depth-1 ключей объекта-аргумента `@Module`.

6. **`hasXField` boolean флаги выкинуты** — `fieldLocations.X !== null` — тот же сигнал, без дублирования state.

7. **`flags.hasDynamic<Field>` теперь flip-ит на ЛЮБОЙ unresolved** (spread, conditional, non-array-init, object-no-spread). Раньше — только spread.

**Self-review (pr-review-toolkit недоступен — Task tool не загружен)**: 7 findings найдены и применены (consistent dynamic flags, dead `hasXField` flags removed, `PropertyAccess` без `snippet` truncation, dead `declaringSite` parameter, jsdoc fix для `resolveRate`, и т.п.). Critical/important: zero remaining.

**Deferred**:

- **Shorthand property `@Module({ imports })`** (без `:`) — в 5 проектах не встретилось. Если встретится, extractor пропустит поле, GT validator его посчитает → recall regression. Фикс: разрешить `ShorthandPropertyAssignment` в `findProp` (имя поля = identifier text). Шаблон редкий, gated by recall.

- **Per-ref source loc в diagnostics**. Сейчас `unresolvedRefs[].location` — `@Module` decorator line. Если будут жалобы на UX диагностики — добавить per-element location в `DiModuleRef` / `DiProviderRef`.

- **Provider-array object-spread fallback** (analog `imports`-array spread): `providers: [{ ...sharedProviders }]`. В 5 проектах не встретилось.

- **Cross-package module collisions**. Если две библиотеки имеют `FooModule` — index хранит последний found. Граф схлопывает их в один `module:FooModule` node. Это не bug (имена одинаковые → один логический модуль), но если разные FooModule имеют разные `providers`, edges merge корректно за счёт key=`kind:from->to`. OK для now.

**Metrics (5 проектов)**:

| Project | Modules | Imports | Providers | Exports | Controllers | resolveRate | Graph (DI edges) |
|---|---|---|---|---|---|---|---|
| platform | 123 | 291 | 385 | 173 | 110 | 99.6% | 905 |
| insyra | 56 | 196 | 192 | 115 | 78 | 99.5% | 560 |
| beribuy2 | 8 | 25 | 58 | 6 | 27 | 100.0% | 113 |
| unpacks | 31 | 95 | 67 | 45 | 24 | 100.0% | 228 |
| screenia | 53 | 166 | 119 | 60 | 46 | 98.7% | 373 |

---

## Block B — HTTP inter-service extractor

_В работе._

---

## Block C — TS-import extractor (dependency-cruiser)

_В работе._

---

## Block D — Mermaid output

### Decisions

**Node shapes** (per NodeKind):
- `service` → `id["label"]` (rectangle, primary entity)
- `lib` → `id["label"]` + class `lib` (same rectangle; differentiated by classDef fill)
- `queue` → `id(["label"])` (stadium — async boundary)
- `nats-subject` → `id(("label"))` (circle — pub/sub endpoint)
- `db-table` → `id[("label")]` (cylinder — storage)
- `module` → `id{{"label"}}` (hexagon — DI module)
- `file` → `id["label"]` + class `file`

**Edge syntax** (per EdgeKind):
- sync RPC (`http-call`, `nats-request`, `nats-reply`) → thick arrow `==>|label|`
- async fire-and-forget (`nats-publish`/`subscribe`, `queue-produce`/`consume`, `ts-import`, `lib-usage`, `di-*`) → dotted arrow `-.->|label|`
- DB access (`db-read`/`write`/`access`) → open arrowhead `--o|label|`

**Note on DI dotted arrow**: первоначально использовал `-..->` (more dots) для зрительного де-приоритета, но эта форма ломается в части Mermaid версий — все de-emphasised kinds сейчас используют общий `-.->` + edge-label (`di`, `import`, `lib`) как смысловой различитель.

### Layout

- `flowchart LR` (вертикальный LR — ширина выше высоты, лучше для multi-service графа)
- Один subgraph на NodeKind (`Services`, `Libraries`, `Modules`, `Queues`, `NATS subjects`, `DB tables`, `Files`)
- Ноды внутри subgraph отсортированы по label, edges отсортированы по `(kind, from, to)` — стабильные diff'ы
- `classDef` + bulk `class id1,id2 cls;` — стили в конце файла, не inline (читаемость, дифабельность)

### Truncation policy

- Header comment `%% graph has N nodes, M edges — consider per-service slicing` when `N > 200`
- Полный граф всё равно пишется (Mermaid Live рендерит ~500 нод, наш максимум сейчас — insyra 579 нод; рендерится медленно, но валидно)
- Опциональное slicing'ование через `--mermaid-slice=`:
  - `per-service` → `<out>/mermaid/service-<id>.mermaid` (skip services с 0 рёбрами)
  - `domain:<key>` → `<out>/<key>.mermaid` (keys: `nats`, `bullmq`, `typeorm`, `http`, `di`, `ts-import`, `lib`)

### Validation

Counts (nodes/edges) в `graph.mermaid` совпадают с `graph.json` на всех 5 проектах:

| project   | nodes | edges | bytes  |
|-----------|-------|-------|--------|
| beribuy2  |    45 |    66 |  8 099 |
| screenia  |   139 |   154 | 24 838 |
| platform  |   315 |   408 | 59 894 |
| insyra    |   579 |   638 | 110 765|
| unpacks   |   110 |   117 | 17 840 |

Структурная валидация: все subgraph balanced (`open === close`), все edge endpoints определены среди node decls (0 missing).

### Deferred

- **Per-service для frontend сервисов**: platform/screenia/unpacks имеют фронт-сервисы без extractor coverage (NATS-only бэк, no DI/HTTP yet) → 0 рёбер → файл не создаётся. Корректно для текущего набора extractor'ов; пересмотреть после Block B (HTTP) и Block A (DI).
- **Mermaid parser validation**: пакет `mermaid` отсутствует в `node_modules` (peer-only зависимость), валидация ограничена structural pass'ом. Live rendering проверяется в Mermaid Live Editor / `mmdc` CLI вне scope этого блока.
- **`ts-import` domain visualisation**: ноды `module`/`file` пока не emit'ятся ни одним extractor'ом (нет DI/TS-import) — соответствующие subgraph'ы будут пустыми; рендерятся корректно (просто не появляются).

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

## Block H — Benchmark suite (arch-graph vs graphify)

_Запланирован после Phase 2._

Идея: количественное сравнение **arch-graph** и **graphify** (`~/.claude/skills/graphify/SKILL.md`) на 5 тестовых монорепо:

- **Build cost**: время + диск + токен-эквивалент output'а
- **LLM efficiency**: для каждого test-вопроса — сколько токенов нужно скормить LLM чтобы получить корректный ответ (`tiktoken`-counting через MCP-tool либо raw-graph dump'a)
- **Quality**: precision / recall ответов против ground-truth (готовится вручную для ~15 архитектурных вопросов: "кто публикует X?", "путь от A до B", "что использует libs/Y?")

Реализация — отдельный `bench/` модуль с `bench.ts` runner'ом + `questions.yaml` + per-tool adapter'ами. Отчёт — `bench/report.md` со сводной таблицей.

Честный disclaimer: graphify — generic semantic-graph, arch-graph — domain-specific. Архитектурные вопросы arch-graph выиграет by design; на "объясни эту концепцию" graphify сильнее. Бенчмарк должен показать разрыв на типовых задачах разработчика монорепо.

---

## Общие открытые вопросы (orchestration-level)

- _будет дополнено по ходу_
