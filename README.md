# arch-graph

**Static architecture graph for NestJS monorepos.** Extracts NATS pub/sub, BullMQ queues, TypeORM `@InjectRepository` → `@Entity` links, NestJS module DI, HTTP inter-service calls, and TypeScript imports into a single typed graph at `arch-graph-out/graph.json`. Designed so an LLM agent can answer "who publishes on this subject?" or "what depends on this table?" without grepping or guessing.

Sister project: **[graphify](https://github.com/safishamsi/graphify)** is a generic semantic-graph tool (papers, docs, code, mixed media). arch-graph is the opposite end of the trade-off — it knows nothing about general semantics, but it knows NestJS / NATS / BullMQ / TypeORM directly, so the edges it produces are deterministic and (per validation gates) ≥ 95% recall on the patterns it covers. Use graphify for "what is this codebase about", arch-graph for "what calls what".

## Install

One-line install (clones to `~/.arch-graph`, symlinks `~/.local/bin/arch-graph`):

```sh
# Once the repo is on a public host:
curl -sSL https://… /install.sh | sh    # TODO: update once published

# Today, from a local clone:
git clone <your-clone-url> /tmp/arch-graph
bash /tmp/arch-graph/scripts/install.sh
```

The installer also honors `ARCH_GRAPH_GIT` (clone source) and `ARCH_GRAPH_HOME` / `ARCH_GRAPH_BIN_DIR` if you want different locations.

**Manual fallback:**

```sh
git clone <repo> ~/.arch-graph
cd ~/.arch-graph
npm install              # or: pnpm install --frozen-lockfile
mkdir -p ~/.local/bin
ln -s ~/.arch-graph/bin/arch-graph ~/.local/bin/arch-graph
# make sure ~/.local/bin is on PATH
```

Requires **Node ≥ 20**. The CLI runs through `tsx` — no `tsc` build step needed.

Verify:

```sh
arch-graph --help
```

## Quick start

```sh
cd path/to/your/nestjs-monorepo
arch-graph init          # writes arch-graph.config.ts
$EDITOR arch-graph.config.ts   # set id / root / appsGlob / libsGlob
arch-graph build         # writes arch-graph-out/
```

Outputs land in `arch-graph-out/`:

- `graph.json` — nodes (services, NATS subjects, BullMQ queues, TypeORM entities, NestJS modules, HTTP endpoints, libs) + edges (publishes, subscribes, depends-on, http-call, module-import/provide/export, ts-import, lib-usage).
- `diagnostics.json` — every unresolved / dynamic call-site, with source location.
- `validation.json` — per-domain recall, resolveRate, and ground-truth counts. Build fails (exit code 3) if any enabled domain drops below its gate.
- `graph.mermaid` — full flowchart. Add `--mermaid-slice=per-service` or `--mermaid-slice=domain:nats` for focused views.

## What you get

| Domain | Coverage | Gate | Measured on 5 monorepos |
|---|---|---|---|
| **NATS** | publish + subscribe via decorators and configurable wrapper APIs; literal + pattern + dynamic subject resolution | recall ≥ 95% (handlers + senders independent) | 100% recall, 5/5 |
| **TypeORM** | `@InjectRepository(Entity)` → `@Entity` resolution across services / libs | recall ≥ 95% + resolveRate ≥ 95% | 100% / 100%, 5/5 |
| **BullMQ** | `@InjectQueue` producers, `@Processor` consumers, `BullModule.registerQueue` registrations | recall ≥ 95% per role + resolveRate ≥ 95% | 100% / 100%, 5/5 |
| **NestJS DI** | `@Module({ imports, providers, exports, controllers })` with full reference resolution | recall ≥ 95% per field + resolveRate ≥ 95% | 100% / 98.7–100%, 5/5 |
| **HTTP** | `HttpService` / `axios` / `fetch` call sites with URL classification (literal / env-ref / pattern / unresolved → internal service vs external host) | recall ≥ 95% | 100%, 5/5 |
| **TS imports** | static + dynamic `import` sites resolved through `tsconfig.paths`; aggregated service → lib `lib-usage` edges (and optional file-level `ts-import` edges) | recall ≥ 80% (alias resolution is best-effort) | 100%, 5/5 |

Each domain emits structured diagnostics for everything it couldn't pin down — dynamic subjects, unresolved queue names, opaque HTTP URLs, missing entity decorators. That list is the honest gap report.

## CLAUDE.md integration

Make arch-graph always-on in Claude Code sessions on this repo:

```sh
arch-graph claude install --skill
# --skill also writes ~/.claude/skills/arch-graph/SKILL.md
```

This writes a delimited section into `./CLAUDE.md` telling the agent to consult `arch-graph-out/graph.json` before answering codebase questions, to prefer the MCP server if available, and to re-run `arch-graph build` after touching `.ts` files. Re-running `install` is idempotent — it replaces the previous block in place.

```sh
arch-graph claude uninstall   # remove the section
```

The skill file installs to `~/.claude/skills/arch-graph/SKILL.md` and is triggered by `/arch-graph` or any architecture question on a NestJS codebase. Install it separately at any time:

```sh
arch-graph install-skill
```

## Git post-commit hook

Auto-rebuild after every commit that touches a `.ts` file:

```sh
arch-graph hook install     # installs .git/hooks/post-commit
arch-graph hook status      # check
arch-graph hook uninstall   # remove
```

The hook is a small marker-delimited block — if you already have a `post-commit` hook from another tool, arch-graph appends to it without disturbing the existing content. The check is `git diff-tree --no-commit-id --name-only -r HEAD | grep -E '\.ts$'`, which works on the initial commit too. Re-installing replaces the block in place; uninstalling removes only the marked block.

## MCP server

If the MCP server is installed (`arch-graph mcp` — see the MCP block in `OPEN-QUESTIONS.md`), prefer it over reading `graph.json` directly. It exposes typed tools (`subject-publishers`, `subject-subscribers`, `service-dependencies`, `paths-between`, `unresolved-sites`) so agents can ask targeted questions instead of dumping the whole graph.

Without MCP, `graph.json` is a single file you can read directly. See the `## arch-graph` section of `CLAUDE.md` after `arch-graph claude install` for `jq` recipes.

## Limitations & honesty

This is a **static** extractor. It does not see runtime configuration, container env values, or dynamically constructed identifiers. The following are deferred or intentionally out of scope (see `05-deferred-patterns.md` and `OPEN-QUESTIONS.md`):

- **D1** — Dynamic NATS subjects (`subject.${userId}`) are recorded as `unresolved` in `diagnostics.json`, not invented as edges.
- **D2** — gRPC / Kafka / SQS — not yet covered; only NATS + BullMQ + HTTP are wired.
- **D3** — Cross-monorepo links (multi-repo deployments). Single monorepo only today.
- **D4** — Runtime DI overrides (`{ provide: TOKEN, useFactory }` that resolves at runtime). Static analysis sees the factory call, not its output.
- **D5** — Decorator metadata from external libs that doesn't follow the NestJS conventions encoded here.
- **D6** — Inferred type-only edges. Type-level uses are not graph edges; only value-level usages are.

To extend coverage, add an extractor under `src/extractors/<domain>/` and wire it into `src/pipeline/build.ts` and a `mapper/` that emits typed edges. The validation harness in `src/validation/` is the contract — every extractor must produce a ground-truth comparison that gates `arch-graph build` at the configured recall floor.

## Benchmark

Quantitative comparison with graphify across 5 reference monorepos (build cost, LLM token efficiency per architectural question, precision/recall on a ground-truth Q&A set) lives in `bench/report.md` once Block H lands.

## Development

```sh
npm install
npm run dev -- build --config <project>.config.ts   # tsx-driven, no build step
npx tsc --noEmit                                    # typecheck
```

Sample configs under `configs/` are the 5 monorepos the validation gates are measured against. The `poc/` directory is the original POC and is not part of the published surface.
