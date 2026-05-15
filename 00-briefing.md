# arch-graph — briefing для новой сессии

Этот файл — точка входа. Если ты агент в новой сессии и пользователь дал ссылку на этот файл, прочитай его целиком и продолжи обсуждение с **«Открытых вопросов»** в конце.

---

## Mission в одной строке

Построить code-search инструмент под персональный TypeScript-микросервисный стек с NATS-общением: точный import-граф + NATS pub/sub связи + опционально runtime trace + MCP query interface для LLM-агентов.

## TL;DR контекста

- Пользователь работает с TS-микросервисами, общение через NATS
- Параллельно проектируется memory-система **2-brain** (`/Users/romandubovik/Documents/Projects/2-brain/`)
- В обсуждении 2-brain возник вопрос code-search для проектов, рассмотрели **graphify** — не покрывает критичных осей под этот стек
- Решили: **arch-graph как отдельный самостоятельный проект**, не часть 2-brain
- Связь с 2-brain — опциональный MCP-мост в Phase 3 2-brain, но это вторично

## Откуда пришли (контекст из 2-brain)

Полный контекст обсуждения зафиксирован в:
- [`/Users/romandubovik/Documents/Projects/2-brain/04-code-search-and-openclaw-takeaways.md`](../2-brain/04-code-search-and-openclaw-takeaways.md) — раздел 2 «Code search»

Краткое содержание тех выводов:

**graphify** ([github skill в `~/.claude/skills/graphify/`](file://~/.claude/skills/graphify/SKILL.md)) — общий инструмент, строит knowledge graph из произвольного корпуса (код+доки+статьи+картинки), сохраняет в `graphify-out/graph.json`, имеет MCP интерфейс. Хорошо работает на концептах и документации.

**Не покрывает критичные оси под TS+NATS**:
- Точный TS import-граф (нужен AST, не текстовый extractor)
- TS-specific семантика: типы, интерфейсы, generics, decorators
- **NATS pub/sub связи между сервисами** — это runtime pattern, в коде это строковые литералы
- HTTP/gRPC inter-service по internal URL
- Реальная частота вызовов (что hot, что cold)

Для пользователя критично хотя бы NATS и точный import-граф.

## Стек пользователя

Из CLAUDE.md и контекста сессий:
- **TypeScript** — основной язык backend
- **NATS** — messaging между микросервисами
- **Микросервисная архитектура** — несколько сервисов общаются через NATS subjects
- **Возможно Nest.js** (упоминался DI-граф в открытых вопросах) — нужно уточнить у пользователя

Возможные дополнительные runtime-связи (нужно подтвердить):
- HTTP/gRPC inter-service
- DI-граф (Nest providers / tokens)

## Что уже рассмотрено

### Готовые инструменты для TS import-графа

| Инструмент | Силы | Слабости |
|---|---|---|
| **dependency-cruiser** (npm) | AST-based, поддержка ESM/CJS/TS, декларативные правила архитектуры, output: JSON/DOT/HTML/mermaid, ~5K stars, очень зрелый | Только import-граф, не runtime |
| **madge** (npm) | Простой, быстрый, circular detection | Менее богатый, чем dep-cruiser |
| **ts-morph** | Программный API над TS Compiler API, полный доступ к AST, type info, references | Не сам граф — средство построения; нужно писать extractor |
| **Arkit** | Симпатичные architecture diagrams | Менее гибкий |

### NATS pub/sub — готового инструмента нет

Это runtime pattern, в коде — строки. Варианты:

**A. AST scanner на ts-morph (рекомендуется как baseline)**:
- Ищем call expressions `.publish(...)`, `.subscribe(...)`, `.request(...)`
- Резолвим subject через type inference (для случая `nc.publish(config.userCreatedSubject, ...)`)
- Edges: `service-A —publishes→ subject-X ←subscribes— service-B`
- Сложности: dynamic subjects (template strings) — частично резолвятся, иногда `dynamic` placeholder

**B. Конвенция через типизированные subjects**:
- Если у пользователя свой типизированный NATS-клиент (типа `Subject<"user.created", UserCreatedPayload>`) — scanner ходит по типам, не по строкам
- Нужно уточнить: используется ли такая конвенция

**C. OpenTelemetry runtime tracing**:
- NATS-клиент инструментируется → real edges с frequency, latency, errors
- Backend: Jaeger / Tempo / Honeycomb
- Дополняет статику, не заменяет
- Требует OpenTelemetry SDK на всех сервисах

### Рекомендованный стек

```
1. Static deps graph:        dependency-cruiser → JSON
2. NATS communication:        custom ts-morph scanner → JSON
3. Runtime communication:     OpenTelemetry traces (опц.) → Jaeger/Tempo
4. Merge layer:               один graph.json из всех источников
5. Query interface:           MCP server: query/path/explain + token budget
```

graphify опционально как 6-й слой для документации и README.

## Открытые вопросы для следующей сессии

Решить эти **до** написания кода, по приоритету:

### 1. Какой набор edges нужен в графе

Минимально: **NATS pub/sub + TS import-граф**. Это и так уже два разных extractor-а.

Дополнительно (нужно решить):
- HTTP/gRPC inter-service вызовы (axios/fetch/grpc-client к internal URLs)
- DI-граф (если Nest.js — providers, modules, tokens, injection edges)
- DB-связи (какой сервис читает/пишет в какие таблицы — через ORM конфиги)
- Event bus поверх NATS (если есть кастомные обёртки типа CQRS event handlers)

**Question for user**: «Помимо NATS pub/sub и import-графа — какие связи критичны? HTTP-вызовы между сервисами? DI Nest.js? БД-доступы?»

### 2. Является ли стек Nest.js или vanilla TS

DI-граф имеет смысл только если Nest.js или подобный фреймворк с decorators-based injection. Если vanilla TS / Fastify / Express — DI-graph отдельно строить не нужно.

**Question for user**: «Используется ли Nest.js? Если нет — какой фреймворк?»

### 3. Существует ли типизированный NATS-клиент

Это сильно влияет на сложность NATS-extractor-а. Типизированный клиент = ходим по типам, dynamic клиент = ходим по строкам и template literals.

**Question for user**: «Как у вас выглядит NATS-клиент? Голый `nats.js` connect/publish? Своя обёртка? Типизированные subjects?»

### 4. Live-update (watch) vs ondemand

- **Watch mode**: при изменении кода — auto-rebuild графа. Хорошо для разработки, плохо для CI/большой кодбазы
- **Ondemand**: ручной `arch-graph build` или CI hook. Проще и предсказуемо

**Question for user**: «Хочешь чтобы граф обновлялся при изменении кода в realtime, или ondemand?»

### 5. Output форматы

Что нужно:
- **graph.json для query** — обязательно (machine-readable для MCP)
- **Mermaid/Graphviz** для PR-документации?
- **D3 интерактивный HTML** для глазного просмотра?
- **GraphML / Neo4j** для тяжёлой аналитики?

**Question for user**: «Что важнее — query-API для LLM или визуал для глаз? Или оба?»

### 6. Runtime tracing — нужно ли в Phase 1

OpenTelemetry instrumentation — не блокер, но если уже есть Jaeger в стеке — можно сразу merge. Если нет — отложить до того момента, когда static уже работает.

**Question for user**: «Используется ли уже OpenTelemetry в проектах? Есть ли Jaeger/Tempo?»

### 7. Open-source или внутренний

- **Internal**: проще, можно хардкодить под конкретные конвенции
- **OSS**: больше дисциплины, конфигурация через файл, поддержка multiple paтternов

**Question for user**: «Это будет open-source или internal-only? Если OSS — какой scope: только NATS, или universal messaging (NATS+Kafka+RabbitMQ)?»

### 8. Связь с 2-brain (опциональная)

В 2-brain Phase 3 планируется MCP-мост `memory.code_context(query)` который проксирует к arch-graph если он есть в проекте. Это:
- Бесплатное преимущество для пользователей обоих инструментов
- Не блокирует разработку ни одного из них
- Phase 3 = после ~3-4 месяцев работы над 2-brain

**Question for user**: «Подтвердить что эта связь нужна, или arch-graph живёт полностью независимо без MCP-моста к 2-brain?»

## Конкретное предложение для старта новой сессии

Когда ты начинаешь новую сессию по arch-graph:

1. **Прочитай этот файл целиком**
2. **Опционально загляни в** [`2-brain/04-code-search-and-openclaw-takeaways.md`](../2-brain/04-code-search-and-openclaw-takeaways.md) для полного контекста
3. **Начни диалог с пользователем** с вопросов из раздела «Открытые вопросы» — по одному, не вываливая все сразу
4. **После ответов на 8 вопросов** — формируй mini-roadmap (Phase 1 = baseline arch-graph), сохраняй в этой же папке как `01-roadmap.md`
5. **Не пиши код** до полного согласования архитектуры

Тебе НЕ нужно с нуля:
- Анализировать graphify (уже сделано в файле 04 у 2-brain)
- Сравнивать dependency-cruiser / madge / ts-morph (рекомендация уже есть выше)
- Обосновывать необходимость отдельного проекта (решено)

Тебе нужно:
- Понять конкретный TS+NATS стек пользователя в деталях
- Сформировать roadmap под этот стек
- Зафиксировать решения в файлах рядом с этим

## Как пользователю стартовать новую сессию

В новом чате (Claude Code / Claude Desktop / любом другом агенте) написать:

```
Прочитай /Users/romandubovik/Documents/Projects/arch-graph/00-briefing.md
и продолжаем оттуда.
```

Этого хватает. Briefing self-contained, агент получит весь нужный контекст.

---

## Текущее состояние папки

```
arch-graph/
└── 00-briefing.md   ← этот файл (entry point)
```

Будущие файлы:
```
arch-graph/
├── 00-briefing.md
├── 01-roadmap.md          ← после ответов на open questions
├── 02-extractors-design.md ← detailed дизайн NATS-extractor + dep-cruiser integration
├── 03-mcp-interface.md     ← API для LLM-агентов
└── src/                    ← когда дойдёт до кода
```
