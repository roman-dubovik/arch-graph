# arch-graph — старт следующей сессии

Прочитай это, потом 01–03 при необходимости. Не повторяй уже решённое.

---

## Команда для старта в новом чате

```
Прочитай /Users/romandubovik/Documents/Projects/arch-graph/04-next-session-start.md
и продолжаем оттуда.
```

---

## Где мы остановились

**Phase 1 production NATS + TypeORM — закончен и валидирован.**

NATS — 5/5 проектов bit-exact match с POC. TypeORM — 5/5 с recallInj/recallEnt = 100%.

| Проект | NATS recallH/S | classify/resolve | TypeORM inj/ent/resolve | graph (nodes/edges) |
|---|---|---|---|---|
| platform | 100/100 | 99.3/87.1 | 475/144/100% (resolve 100%) | 287 / 359 |
| insyra | 100/100 | 99.3/98.0 | 273/88/100% (resolve 100%) | 571 / 618 |
| beribuy2 | 100/100 | 100/91.4 | 34/25/100% (resolve 100%) | 45 / 61 |
| unpacks | 100/100 | 100/97.8 | 61/18/100% (resolve 100%) | 107 / 107 |
| screenia | 100/100 | 100/97.9 | 119/36/100% (resolve 98.3%) | 130 / 140 |

Production CLI работает:
```bash
cd arch-graph
npx tsx src/cli/index.ts build --config configs/insyra.config.ts --out arch-graph-out/insyra
```

Каждый build выдаёт три файла:
- `graph.json` — общая схема Node/Edge (multi-domain: NATS + TypeORM)
- `diagnostics.json` — `{nats, typeorm}` sections (unresolved/dynamic/unowned + counts)
- `validation.json` — `{nats, typeorm}` per-domain regression-gate (recall + resolve rate)

POC оставлен в [`poc/`](./poc/) как regression baseline для NATS; numbers идентичны bit-to-bit.
Regression gate exit-code 3 теперь срабатывает если recall < 95% в **любом** домене (NATS handlers/senders или TypeORM injections/entities).

---

## Зафиксированные решения (Phase 1)

1. **Layout**: `src/` рядом с `poc/`. POC — read-only golden master для regression.
2. **Config — TS** с `defineConfig` + jiti-loader. JSON всё ещё поддержан (fallback). Per-project конфиги в [`configs/`](./configs/) (5 шт).
3. **graph.json scope**:
   - `literal` / `pattern` subject → реальные `nats-subject` ноды + edges
   - `dynamic` / `unresolved` → НЕ в graph, всё в `diagnostics.json`
4. **Ownership**: apps/X → `service:X` нода. libs/Y → `lib:Y` нода (factual; dep-cruiser в Phase 2 пристёгнет consuming services). Внешние файлы → `unowned` в diagnostics.
5. **Validator работает на `NatsCallSite[]` до mapper'а** — это hard regression gate в `arch-graph build` (exit code 3 если recall < 95%).
6. **CLI**: `init` | `build` | `diagnose` — все три как первоклассные команды.

---

## Production layout

```
arch-graph/
├── src/
│   ├── core/                  types, config-loader, service-registry
│   ├── extractors/nats/       extractor + constant-index (перенос из POC)
│   ├── validation/            handlers, senders, validator, strip-comments
│   ├── mapper/                NatsCallSite → {nodes, edges}
│   ├── output/                graph.json/diagnostics.json/validation.json writers
│   ├── pipeline/              build orchestration
│   ├── cli/                   CLI entry-point
│   └── index.ts               package entry (defineConfig + types + runBuild)
├── configs/                   per-project TS configs (5 шт, мигрированы из POC JSON)
├── poc/                       read-only regression baseline
└── arch-graph-out/            (gitignored) build outputs
```

---

## Следующий шаг — Phase 1 continued: остальные extractors

В порядке возрастания сложности:

1. ~~**TypeORM DB extractor**~~ ✅ done — 962 InjectRepository sites, 311 Entities across 5 projects, recall 100%/100%
2. **BullMQ extractor** — следующий по плотности рёбер
   - `@InjectQueue(NAME)` → producer
   - `@Processor(NAME)` → consumer
   - `BullModule.registerQueue({ name })` → owner
3. **NestJS DI extractor** (`@Module({imports, exports, providers})`)
4. **HTTP inter-service** — сложный из-за URL-резолва; рассмотреть отдельно
5. **dependency-cruiser** для TS import-графа (заодно решает libs/→service attribution)

После каждого нового extractor'а: regression-gate уже встроен в `arch-graph build`. Расширить validator на новый домен либо ввести отдельный смоук-тест.

### Известный edge case TypeORM (Phase 2 candidate)

`export { NotificationSuppression as EmailSuppression }` — re-export aliases в `libs/<scope>/entities/index.ts`.
EntityIndex индексирует декларацию класса по его собственному имени; если `@InjectRepository(EmailSuppression)` ссылается на alias, entity класс не находится. В screenia 2 sites из 119 (1.7%) попадают сюда. План: добавить второй pass над `ExportSpecifier`-ами в entity-index.

---

## НЕ Phase 1 (отложено)

- Mermaid output (зафиксируем после того как соберём 3+ extractor'а)
- MCP server (Phase 2)
- OpenTelemetry/Jaeger runtime layer (Phase 3)
- 2-brain MCP-мост (Phase 4)
- D3 HTML визуализация
- watch-mode (отказались — rebuild 3-7s на крупных проектах достаточен)

---

## Design guideline для следующих extractors

**Service seeding в mapper.** Сейчас NATS mapper seed-ит все services из ownership (даже без рёбер), TypeORM — только тех, к кому есть injection sites. `assembleGraph` мержит частичные nodes через `{...a, ...b}`, поэтому пока порядок `[natsMapped, typeormMapped]` сохраняет `path` от NATS. При добавлении BullMQ/DI правило: **либо все mappers seed-ят services, либо merge должен быть устойчив к порядку**. Перед BullMQ зафиксировать.

---

## Ключевые technical insights из POC (актуальны для следующих extractors)

1. **ConstantIndex обязателен** — без него resolve rate 0% из-за path aliases. Pre-pass всех `export const/enum/function`. Уже есть в production: [`src/extractors/nats/constant-index.ts`](./src/extractors/nats/constant-index.ts).
2. **Per-project конфиг wrapper API** нужен (platform: PlatformConnectionService, JetStreamService, NatsService; insyra: JetStreamService).
3. **Файловый pre-filter** — call-сайт учитывается только если файл импортирует домен-маркер (для NATS это `@nestjs/microservices` или wrapper-класс). Убирает 180 false positives.
4. **`getType()` от ts-morph нестабилен** без полной module resolution → text-based fallback с предусловиями.
5. **Cross-reference resolution в template-строках** — 3 итерации для цепочек.
6. **Destructured BindingElement = dynamic** (не unresolved) — параметры функций.
7. **Ground-truth должен стрипать комментарии** — иначе JSDoc раздувает false metrics.

---

## Открытые вопросы для обсуждения в начале новой сессии

1. **BullMQ vs DI следующим** — рекомендация: **BullMQ** (плотнее, чётче семантика producer/consumer).
2. **Mermaid output** — сейчас, после двух extractor'ов (NATS+TypeORM), уже есть смысл подумать о визуализации. Альтернатива — подождать BullMQ+DI.
3. **dependency-cruiser** — подключать с DI extractor'ом или раньше (для libs/→service attribution в текущих доменах)?
4. **Entity alias resolution** (screenia edge case) — закладывать как часть BullMQ/DI или отдельной мелкой задачей сразу?

---

## Файлы для контекста

- [`00-briefing.md`](./00-briefing.md) — изначальный entry-point
- [`01-roadmap.md`](./01-roadmap.md) — план фаз
- [`02-extractors-design.md`](./02-extractors-design.md) — детальный дизайн каждого extractor'а
- [`03-poc-validation-results.md`](./03-poc-validation-results.md) — POC validation
- [`src/extractors/nats/extractor.ts`](./src/extractors/nats/extractor.ts) — рабочий NATS resolver
- [`src/extractors/nats/constant-index.ts`](./src/extractors/nats/constant-index.ts) — pre-pass индекс констант
- [`src/extractors/typeorm/extractor.ts`](./src/extractors/typeorm/extractor.ts) — @InjectRepository extractor
- [`src/extractors/typeorm/entity-index.ts`](./src/extractors/typeorm/entity-index.ts) — pre-pass индекс @Entity
- [`src/pipeline/build.ts`](./src/pipeline/build.ts) — оркестрация (multi-domain)
- [`src/mapper/nats-to-graph.ts`](./src/mapper/nats-to-graph.ts) — NATS call-sites → graph
- [`src/mapper/typeorm-to-graph.ts`](./src/mapper/typeorm-to-graph.ts) — TypeORM injection-sites → graph
- [`src/validation/typeorm-validator.ts`](./src/validation/typeorm-validator.ts) — ground-truth grep + comparator
- [`configs/`](./configs/) — per-project TS-конфиги
- [`poc/reports/`](./poc/reports/) — golden master отчёты POC

---

## Чего НЕ нужно делать

- Заново валидировать NATS extractor — bit-exact match POC ↔ production на 5 проектах
- Менять архитектуру `02-extractors-design.md` без обсуждения — она подтверждена POC и production
- Делать MCP server до того как `graph.json` стабилен (минимум 3-4 extractor'а собраны)
- Спрашивать заново про стек/wrapper-классы — всё в `configs/`
