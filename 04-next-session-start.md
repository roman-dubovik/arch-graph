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

**Phase 1 production NATS — закончен и валидирован.** 5/5 проектов bit-exact match с POC.

| Проект | recallH | recallS | classify | resolve | graph nodes | edges |
|---|---|---|---|---|---|---|
| platform | 100% | 100% | 99.3% | 87.1% | 132 | 121 |
| insyra | 100% | 100% | 99.3% | 98.0% | 492 | 533 |
| beribuy2 | 100% | 100% | 100% | 91.4% | 21 | 32 |
| unpacks | 100% | 100% | 100% | 97.8% | 89 | 89 |
| screenia | 100% | 100% | 100% | 97.9% | 95 | 92 |

Production CLI работает:
```bash
cd arch-graph
npx tsx src/cli/index.ts build --config configs/insyra.config.ts --out arch-graph-out/insyra
```

Каждый build выдаёт три файла:
- `graph.json` — общая схема Node/Edge
- `diagnostics.json` — unresolved/dynamic/unowned call-sites
- `validation.json` — regression-gate (recall, classification)

POC оставлен в [`poc/`](./poc/) как regression baseline; numbers идентичны bit-to-bit.

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

1. **TypeORM DB extractor** — самый простой, даёт плотный слой service→table рёбер
   - `@InjectRepository(Entity)` → property → call-sites
   - `@Entity('table')` или snake_case от имени класса
   - Phase 1: edge `db-access`; Phase 2: split на read/write
2. **BullMQ extractor**
   - `@InjectQueue(NAME)` → producer
   - `@Processor(NAME)` → consumer
   - `BullModule.registerQueue({ name })` → owner
3. **NestJS DI extractor** (`@Module({imports, exports, providers})`)
4. **HTTP inter-service** — сложный из-за URL-резолва; рассмотреть отдельно
5. **dependency-cruiser** для TS import-графа (заодно решает libs/→service attribution)

После каждого нового extractor'а: regression-gate уже встроен в `arch-graph build`. Расширить validator на новый домен либо ввести отдельный смоук-тест.

---

## НЕ Phase 1 (отложено)

- Mermaid output (зафиксируем после того как соберём 3+ extractor'а)
- MCP server (Phase 2)
- OpenTelemetry/Jaeger runtime layer (Phase 3)
- 2-brain MCP-мост (Phase 4)
- D3 HTML визуализация
- watch-mode (отказались — rebuild 3-7s на крупных проектах достаточен)

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

1. **TypeORM vs BullMQ vs DI первым** — после Phase 1 NATS все три на очереди. По плотности значимых рёбер: TypeORM > BullMQ > DI. По простоте AST: BullMQ ≈ DI > TypeORM (TypeORM требует track property → call-site flow). Рекомендация — **TypeORM**, как в roadmap.
2. **Mermaid output** — нужен ли prototype уже сейчас, чтобы визуально проверять graph.json? Или дождёмся 3+ extractor'а?
3. **dependency-cruiser** — подключать сейчас (решает libs/→service attribution для NATS) или вместе с DI extractor'ом?

---

## Файлы для контекста

- [`00-briefing.md`](./00-briefing.md) — изначальный entry-point
- [`01-roadmap.md`](./01-roadmap.md) — план фаз
- [`02-extractors-design.md`](./02-extractors-design.md) — детальный дизайн каждого extractor'а
- [`03-poc-validation-results.md`](./03-poc-validation-results.md) — POC validation
- [`src/extractors/nats/extractor.ts`](./src/extractors/nats/extractor.ts) — рабочий resolver
- [`src/extractors/nats/constant-index.ts`](./src/extractors/nats/constant-index.ts) — pre-pass индекс
- [`src/pipeline/build.ts`](./src/pipeline/build.ts) — оркестрация
- [`src/mapper/nats-to-graph.ts`](./src/mapper/nats-to-graph.ts) — call-sites → graph
- [`configs/`](./configs/) — per-project TS-конфиги
- [`poc/reports/`](./poc/reports/) — golden master отчёты POC

---

## Чего НЕ нужно делать

- Заново валидировать NATS extractor — bit-exact match POC ↔ production на 5 проектах
- Менять архитектуру `02-extractors-design.md` без обсуждения — она подтверждена POC и production
- Делать MCP server до того как `graph.json` стабилен (минимум 3-4 extractor'а собраны)
- Спрашивать заново про стек/wrapper-классы — всё в `configs/`
