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

POC NATS-extractor'а сделан и валидирован на 5 проектах (platform, insyra, beribuy2, unpacks, screenia).

**Результаты**: детекция handlers+senders 100%, classification accuracy 99.3-100%, manual subject correctness 100% на выборке 25 случаев. Цель 95+% достигнута.

Полный отчёт: [`03-poc-validation-results.md`](./03-poc-validation-results.md).
POC код: [`poc/`](./poc/) — работает, отчёты в [`poc/reports/`](./poc/reports/).

---

## Следующий шаг — Phase 1 production

Цель: рабочая команда `arch-graph build` → `arch-graph-out/graph.json` с реальными узлами/рёбрами, не только NATS.

### Что делать (в порядке приоритета)

1. **Переписать POC в production layout** (`arch-graph/src/`, отдельно от `poc/`):
   - Service registry с привязкой call-сайтов к service-нодам (POC даёт file:line, не service)
   - Общая схема `graph.json` из [`02-extractors-design.md`](./02-extractors-design.md)
   - CLI: `arch-graph init`, `arch-graph build`, `arch-graph diagnose`
   - Перенести NATS extractor + ConstantIndex из POC как есть — они валидированы

2. **Добавить остальные extractors** (порядок по сложности, простые первыми):
   - **TypeORM DB-access** (`@InjectRepository(Entity)` + `@Entity('table')`) — самый простой
   - **BullMQ** (`@InjectQueue`, `@Processor`, `BullModule.registerQueue`)
   - **NestJS DI-граф** (`@Module({imports, exports, providers})`)
   - **HTTP inter-service** — сложный из-за URL-резолва; рассмотреть отдельно после первых трёх
   - **dependency-cruiser** для TS import-графа

3. **Merger + output**:
   - Объединить выходы extractor'ов в единый `graph.json`
   - Mermaid output (читаемый для PR-документации)

4. **Validation framework**: перенести POC валидатор как обязательную часть build'а (regression tests при изменении extractor'ов).

### НЕ Phase 1 (отложено)

- MCP server (Phase 2)
- OpenTelemetry/Jaeger runtime layer (Phase 3)
- 2-brain MCP-мост (Phase 4)
- D3 HTML визуализация

---

## Ключевые technical insights из POC (не забыть в production)

1. **ConstantIndex обязателен** — без него resolve rate 0% из-за path aliases. Pre-pass всех `export const/enum/function`.
2. **Per-project конфиг wrapper API** нужен (platform: PlatformConnectionService, JetStreamService, NatsService; insyra: JetStreamService).
3. **Файловый pre-filter** — call-сайт учитывается только если файл импортирует `@nestjs/microservices` или wrapper-класс. Убирает 180 false positives на platform.
4. **`getType()` от ts-morph нестабилен** без полной module resolution → text-based fallback с предусловиями.
5. **Cross-reference resolution в template-строках** — 3 итерации для цепочек типа `\`${SUFFIX}.${SUFFIX2}.>\``.
6. **Destructured BindingElement = dynamic** (не unresolved) — это правильная классификация для параметров.
7. **Ground-truth должен стрипать комментарии** — иначе JSDoc и закомментированный код раздувают false metrics.

---

## Открытые вопросы для обсуждения в начале новой сессии

Не блокеры, но определят детали:

1. **Структура production проекта**: монорепо в `arch-graph/` (с POC в `arch-graph/poc/` archive)? Или совсем отдельный layout? Что куда переносим из POC.
2. **Конфиг проекта**: один `arch-graph.config.ts` (TS) или JSON? POC использует JSON per-project; в production может быть лучше TS для type-safety и autocompletion в wrapperApis.
3. **Какой extractor делать первым после NATS-переноса** — DB или DI? DB даёт сразу много значимых рёбер, DI помогает понимать архитектуру.
4. **Запуск на твоих проектах в watch-mode для dev** — нужен ли file-watch несмотря на изначальное решение "ondemand"? POC показал что full rebuild ~5-7s на platform — приемлемо.

---

## Файлы для контекста (если агент захочет глубже)

- [`00-briefing.md`](./00-briefing.md) — изначальный entry-point всего arch-graph
- [`01-roadmap.md`](./01-roadmap.md) — план фаз, что в каждой
- [`02-extractors-design.md`](./02-extractors-design.md) — детальный дизайн каждого extractor'а с примерами AST
- [`03-poc-validation-results.md`](./03-poc-validation-results.md) — что получилось в POC
- [`poc/src/extractors/nats.extractor.ts`](./poc/src/extractors/nats.extractor.ts) — рабочий NATS resolver
- [`poc/src/extractors/constant-index.ts`](./poc/src/extractors/constant-index.ts) — pre-pass индекс
- [`poc/reports/`](./poc/reports/) — отчёты по 5 проектам с примерами что нашлось/не нашлось

---

## Чего НЕ нужно делать

- Заново валидировать NATS extractor — он валидирован, регрессия проверяется через `poc/`
- Менять архитектуру `02-extractors-design.md` без обсуждения — она подтверждена POC'ом
- Делать MCP server до того как `graph.json` стабилен (минимум 3-4 extractor'а собраны и merger работает)
- Спрашивать заново про стек/wrapper-классы — всё зафиксировано в `poc/config/`
