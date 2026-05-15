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

## Общие открытые вопросы (orchestration-level)

- _будет дополнено по ходу_
