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
