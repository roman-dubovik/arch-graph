# Competitive benchmark — arch-graph vs 5 adjacent tools

_Run date: 2026-05-16_

We re-ran the same 10 auto-generated questions per project on 4 reference
NestJS monorepos (Projects A, B, C, D) for each tool, scored using the
same substring-presence heuristic.

**TL;DR — 40 questions, 4 projects (re-run 2026-05-16 post-Tier-1-2-3):**

| Tool | Mode | Avg tokens | Mean recall |
|---|---|---:|---:|
| arch-graph | static | 39,779 | **100%** |
| graphify | LLM-driven | 569,924 | 39% |
| @nestjs/devtools-integration | runtime | 65,395 | 9.2% |
| nestjs-spelunker | runtime | 13,535 | 10.6% |
| @riaskov/nst-graph-visualizer | runtime (despite "static" docs) | ~125 (partial) | 1.3% |
| dependency-cruiser | static, generic | ~660,344 | 40.8%† |

**† Substring-noise warning:** dependency-cruiser's 40.8% is **not** real
architectural facts. By default `depcruise apps libs` walks only `.js/.mjs`
— TypeScript isn't parsed on a typical pnpm monorepo. The "matches" are
file paths like `caniuse-lite/broadcastchannel.js` coincidentally containing
substrings of ground-truth labels. On every per-category cut (NATS, BullMQ,
TypeORM, module-imports), dep-cruiser scores 0%.

---

## Per-tool detail

### @nestjs/devtools-integration (official, runtime)

| Project | Tokens | Mean recall | Status |
|---|---:|---:|---|
| A project-a | 178,520 | 6.5% | success (after env stubs) |
| B project-b | 50,688 | 10.2% | success (after env stubs) |
| C screenia | 20,567 | 10.0% | success (with dual-@nestjs/core fix) |
| D project-c | 11,808 | 10.0% | success (with dual-@nestjs/core fix) |

**Recall by category (aggregated across 4 projects):**

| Category | devtools |
|---|---:|
| module-imports | **87.5%** |
| deps-of | 2.0% |
| nats-publishers / subscribers | 0% |
| queue-producers / consumers | 0% |
| table-users | 0% |

**Key engineering findings:**

- `NestFactory.create(AppModule, { snapshot: true })` requires app
  bootstrap. We stubbed DB / NATS / JWT / Redis env vars to make
  every project's `getOrThrow` guards pass. In a real CI without
  those secrets, **3 of 4 projects would fail at boot**.
- Screenia / project-c hit a `TypeOrmCoreModule` DI error caused by
  two copies of `@nestjs/core` (runner's vs project's). Fixed by
  promoting the project's `node_modules` to the front of Node's
  module resolution.
- The `SerializedGraph` schema is class-token-based — it doesn't
  carry NATS subjects, BullMQ queue names, or DB table names as
  edges. The 0% recall on cross-cutting questions is structural.

**Honest framing:** devtools is NestJS's own DI introspection,
authoritative on what `NestFactory` actually wires up. arch-graph
infers from decorators — devtools is correct when conditional DI
wiring matters. They answer different questions.

### nestjs-spelunker (runtime, DI-only)

| Project | Modules | Edges | Tokens | Mean recall |
|---|---:|---:|---:|---:|
| A project-a | 95 | 2,163 | 29,049 | 10.0% |
| B project-b | 62 | 1,346 | 17,620 | 10.0% |
| C screenia | 53 | 477 | 6,093 | 12.5% |
| D project-c | 20 | 95 | 1,379 | 10.0% |

**Recall by category:** 100% on `module-imports`, 0% on every other
category — spelunker sees the `@Module()` import graph and nothing
else.

**Engineering finding:** `NestFactory.createApplicationContext()`
fails because `onModuleInit` hooks hit live dependencies (external
auth 503s, Redis ECONNREFUSED). The workaround was to bypass
lifecycle hooks by directly invoking NestJS internals:
`DependenciesScanner.scan()` + `InstanceLoader.createInstancesOfDependencies()`,
then pass the container to `SpelunkerModule.explore()`. With that
harness, 4 of 4 projects succeed — but the harness itself is non-trivial
and per-project (path-alias setup, monorepo `tsconfig-paths/register`).

**Honest framing:** spelunker is the cheapest token-wise — it captures
only one architectural layer. Complementary niche, not a substitute.

### @riaskov/nst-graph-visualizer

Note on naming: research listed `@riaskov/nestjs-graph-visualizer`;
the actual npm package is `@riaskov/nst-graph-visualizer@1.0.2`.
Published without a compiled `dist/` directory — required local
`tsup` build before invocation.

| Project | Modules loaded | Tokens | Mean recall | Status |
|---|---|---:|---:|---|
| A project-a | 2/5 (partial) | 494 | 5.2% | partial |
| B project-b | 0/4 | 0 | 0% | failed |
| C screenia | 0/5 | 0 | 0% | failed |
| D project-c | 0/4 | 0 | 0% | failed |

**Engineering finding:** Documented as static AST, but in practice
does runtime reflection (`require()`s the root module and reads
`@Module` metadata). On 3 of 4 projects, the main app module
couldn't load — `ReferenceError: Cannot access 'X' before
initialization` from TypeORM entity barrel files with
bidirectional `forwardRef` relations creating CJS require cycles.

This is a **common production pattern** in NestJS+TypeORM codebases.
True-static-AST tools (arch-graph via ts-morph) don't have this
failure mode because they don't execute the module.

**Honest framing:** mismatched expectation — "static" should mean
no execution. The label-space mismatch (riaskov outputs class
names, our ground-truth uses lib paths) is a separate scoring
limitation.

### dependency-cruiser (static, generic)

Version 17.4.0. Reference baseline for plain TypeScript imports.

| Project | Tokens | Nominal recall | Reality |
|---|---:|---:|---|
| A project-a | 1,211,092 | 7.7% | `broadcast` matches `caniuse-lite/broadcastchannel.js`, `audit` matches `rxjs/audit.js` |
| B project-b | 20,422 | 60% | matches `be-project-b` in `apps/be-project-b/webpack.config.js -> path` |
| C screenia | 7,092 | 45.4% | same — webpack config paths contain project name |
| D project-c | 1,402,764 | 50% | OOM-trimmed run, remaining matches are paths |

**Per-category recall:** 0% on every NestJS-specific category.
The nominal recall is purely **substring noise** from incidental
file-path matches.

**Engineering findings:**
- `dependency-cruiser apps libs` in directory mode walks only
  `.js / .mjs` files. TypeScript isn't parsed without explicit
  `--ts-config <path>`.
- On larger monorepos (project-b, screenia), the full scan hit
  Node OOM at 4GB heap. Required `--exclude "node_modules|dist|build|coverage"`.
- Even with TypeScript parsing enabled, dep-cruiser doesn't
  resolve `tsconfig.paths` aliases (`@project-a/core` → `libs/project-a/core`)
  without explicit configuration.

**Honest framing:** dep-cruiser is excellent at what it's designed
for — file-level imports, framework-agnostic, mature. On
NestJS-specific architecture questions, it scores 0% by construction
(it doesn't see decorators). The 40.8% number is the heuristic's
failure mode, not dep-cruiser's fault.

---

## Methodology — reading the substring heuristic

Recall here is a **necessary-condition** heuristic: "does the tool's
output even contain the ground-truth label". It captures whether an
LLM handed this context could *in principle* answer the question.

Where it misleads:

1. **File-path coincidences.** A tool that extracts zero
   NestJS-architecture facts (like dep-cruiser) can still score
   double-digit recall purely from project names appearing in
   imported file paths. The **per-category breakdown** (NATS / BullMQ /
   TypeORM / DI / imports) is the more honest cut — every other
   tool's strength shows up as a single category spike, not as
   uniform recall.

2. **Label-space mismatch.** When the tool's output uses different
   identifier conventions than arch-graph (riaskov uses class names;
   our ground-truth uses lib paths), substring matching produces
   spurious zeros even when the answer is structurally present.
   This biases against tools that work at a different abstraction
   level than arch-graph — kept anyway because it reflects
   real-world ground-truth derivation (you have *your* questions,
   not the tool's).

3. **Bilateral fairness caveat.** Questions are auto-derived from
   arch-graph's own graph nodes. Arch-graph scores 100% **by
   construction**. The interesting axis is everyone else's recall
   on the same labels — that's what this bench measures.

## What this benchmark *is* and *isn't*

- **It is:** a fair side-by-side on the questions arch-graph is
  built to answer (NestJS architectural relationships, cited to
  file:line).
- **It isn't:** a verdict on which tool is "best". Each tool wins
  inside its native scope; arch-graph is built for the
  *intersection* the others structurally don't cover.

## Reproducing

Each tool's run logs, raw graph outputs, and per-question scoring
JSON live under `/tmp/arch-graph-runs/competitive-bench/` on the
maintainer's machine. The methodology (auto-generated questions
seeded on `graph.buildAt`, substring scoring on ground-truth labels
from arch-graph's own query helpers) is implemented in
`src/cli/compare-command.ts` — running `arch-graph compare
--graphify path/to/graphify-out` on your own repo reproduces the
same scoring pipeline against graphify.

For the runtime tools (devtools, spelunker), reproducing on your
own repo requires writing a per-project bootstrap harness — see
the per-tool engineering findings above for the patterns we used.
