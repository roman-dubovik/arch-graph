# arch-graph

**Static architecture graph for NestJS monorepos.** Extracts NATS pub/sub, BullMQ queues, TypeORM `@InjectRepository` → `@Entity` links, NestJS module DI, HTTP inter-service calls, and TypeScript imports into a single typed graph at `arch-graph-out/graph.json`. Designed so an LLM agent can answer "who publishes on this subject?" or "what depends on this table?" without grepping or guessing.

Sister project: **[graphify](https://github.com/safishamsi/graphify)** is a generic semantic-graph tool (papers, docs, code, mixed media). arch-graph is the opposite end of the trade-off — it knows nothing about general semantics, but it knows NestJS / NATS / BullMQ / TypeORM directly. The edges it produces are deterministic, and the per-build recall gate enforces ≥ 95% recall (≥ 80% for TS imports) against ground truth derived from your own code; any regression below those floors fails `arch-graph build --strict`. Use graphify for "what is this codebase about", arch-graph for "what calls what".

## Install

From a local clone:

```sh
git clone <repo> ~/.arch-graph
bash ~/.arch-graph/scripts/install.sh
```

The installer symlinks `arch-graph` into `~/.local/bin/` (or `ARCH_GRAPH_BIN_DIR` if set). Honors `ARCH_GRAPH_GIT` and `ARCH_GRAPH_HOME` for alternate locations.

**Manual fallback:**

```sh
git clone <repo> ~/.arch-graph
cd ~/.arch-graph
npm install
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
arch-graph init
```

`arch-graph init` is an interactive wizard. It asks a series of questions with sensible defaults, writes `arch-graph.config.ts`, and optionally chains: Claude Code integration install, git hook install, and a first build — all in one command.

Sample session:

```
arch-graph init — interactive setup wizard

? Project id (used as service:<id> prefix) [my-project]: my-project
? Repo root [.]:
? Apps glob (where services live) [apps/*]:
? Libs glob [libs/**]:

? Which domains to extract?
  1. [x] NATS          pub/sub + request/reply
  2. [x] TypeORM       @InjectRepository → @Entity
  3. [x] BullMQ        @InjectQueue / @Processor
  4. [x] NestJS DI     @Module imports/providers/exports
  5. [x] HTTP          HttpService / axios / fetch
  6. [x] TS imports    file→file / service→lib

  Disable any? Enter numbers separated by comma (blank = all enabled):

? Custom NATS wrapper API? (you wrap @nestjs/microservices in your own class) [y/N]: n

? Install Claude Code integration (./CLAUDE.md + skill)? [Y/n]:

? Install git hook?
  1. pre-commit   (graph committed with code) — recommended
  2. post-commit  (graph rebuilt after commit, not in commit)
  3. none
  Choice [1]:

? Strict mode? (fail build if recall drops below domain floor — useful for CI) [y/N]:

? Run first build now? [Y/n]:

✓ wrote arch-graph.config.ts
✓ wrote CLAUDE.md
✓ pre-commit hook installed
... running first build ...
✓ build complete: 847 nodes, 3241 edges
✓ wrote arch-graph-out/
```

Non-interactive (CI) fallback: when stdin is not a TTY, `arch-graph init` writes a template config without asking any questions.

## What you get

| Domain | Coverage (what the extractor recognises) | Per-build recall gate | Measured on our 5 reference NestJS monorepos |
|---|---|---|---|
| **NATS** | publish + subscribe via decorators and configurable wrapper APIs; literal + pattern + dynamic subject resolution | recall ≥ 95% (handlers + senders independent) | 100% recall, 5/5 |
| **TypeORM** | `@InjectRepository(Entity)` → `@Entity` resolution across services / libs | recall ≥ 95% + resolveRate ≥ 95% | 100% / 100%, 5/5 |
| **BullMQ** | `@InjectQueue` producers, `@Processor` consumers, `BullModule.registerQueue` registrations | recall ≥ 95% per role + resolveRate ≥ 95% | 100% / 100%, 5/5 |
| **NestJS DI** | `@Module({ imports, providers, exports, controllers })` with full reference resolution | recall ≥ 95% per field + resolveRate ≥ 95% | 100% / 98.7–100%, 5/5 |
| **HTTP** | `HttpService` / `axios` / `fetch` call sites with URL classification (literal / env-ref / pattern / unresolved → internal service vs external host) | recall ≥ 95% | 100%, 5/5 |
| **TS imports** | static + dynamic `import` sites resolved through `tsconfig.paths`; aggregated service → lib `lib-usage` edges (and optional file-level `ts-import` edges) | recall ≥ 80% (alias resolution is best-effort) | 100%, 5/5 |

"Coverage" is whether an extractor exists for the domain (boolean per row). The recall gate runs on every build against ground truth derived from *your* code — that's what tells you arch-graph is matching reality on the monorepo in front of it. The last column is what we measured against our private reference suite; your numbers depend on how closely your code follows NestJS conventions and what wrapper APIs are declared in `arch-graph.config.ts`.

Each domain emits structured diagnostics for everything it couldn't pin down — dynamic subjects, unresolved queue names, opaque HTTP URLs, missing entity decorators. That list is the honest gap report.

## Build output

`arch-graph build` writes four files to `arch-graph-out/`:

- `graph.json` — nodes + typed edges
- `diagnostics.json` — every unresolved / dynamic call-site with source location
- `validation.json` — per-domain recall, resolveRate, and ground-truth counts
- `graph.mermaid` — full flowchart (add `--mermaid-slice=per-service` or `--mermaid-slice=domain:nats` for focused views)

After each build, the per-domain table is printed to stdout:

```
Domain       Recall  Resolve   Floor   Status
──────────────────────────────────────────────────────────────────────
nats         100.0%      n/a  ≥95.0%   ✓ ok
typeorm      100.0%   100.0%  ≥95.0%   ✓ ok
bullmq       100.0%   100.0%  ≥95.0%   ✓ ok
di           100.0%    98.7%  ≥95.0%   ✓ ok
http         100.0%      n/a  ≥95.0%   ✓ ok
imports      100.0%      n/a  ≥80.0%   ✓ ok
```

If a domain falls below its recall floor the status shows `⚠` with tips. By default `arch-graph build` is **advisory** — it always exits 0 so it never breaks builds unexpectedly. Use `--strict` for CI hard-fail:

```sh
arch-graph build               # advisory: always exit 0, prints table
arch-graph build --strict      # CI: exit 3 if any domain drops below floor
arch-graph build --quiet       # suppress table (used by the pre-commit hook)
```

## CLAUDE.md integration

Make arch-graph always-on in Claude Code sessions:

```sh
arch-graph claude install --skill
```

This writes a delimited section into `./CLAUDE.md` telling Claude to query the graph before answering architecture questions, and installs `~/.claude/skills/arch-graph/SKILL.md` so the `/arch-graph` skill becomes available globally. Re-running is idempotent — it replaces the previous block in place.

```sh
arch-graph claude uninstall   # remove the section
arch-graph install-skill      # install the skill file separately, any time
```

## Git hook

The pre-commit hook (default) rebuilds the graph before each commit that touches `.ts` files and **auto-stages** the output artifacts (`graph.json`, `diagnostics.json`, `validation.json`, `graph.mermaid`) so the graph is always coherent with the code in history.

```sh
arch-graph hook install                        # pre-commit (default, recommended)
arch-graph hook install --mode=post-commit     # post-commit: rebuilds after commit
arch-graph hook status                         # check installed mode
arch-graph hook uninstall                      # remove
```

**Why pre-commit is usually better:** the graph is committed alongside the code that generated it, so every checkout in history is self-consistent. Post-commit rebuilds the graph after the commit has landed — the graph in the commit is one build behind until the hook fires.

The hook is a marker-delimited block. If you already have a hook from another tool, arch-graph appends to it without disturbing existing content. Switching modes strips the old block and writes the new one.

Build errors (config parse, I/O) block the commit. Recall-floor regressions are advisory by default — add `arch-graph build --strict` to the hook body manually if you want CI-style gating pre-commit.

## Query subcommands

Ten CLI commands let you interrogate the graph directly — faster than MCP and more structured than raw `jq`:

| Subcommand | Input | What it returns |
|---|---|---|
| `who-publishes <subject>` | NATS subject | services that publish on it |
| `who-subscribes <subject>` | NATS subject | services that subscribe |
| `queue-producers <queue>` | BullMQ queue name | services that enqueue jobs |
| `queue-consumers <queue>` | BullMQ queue name | services that process jobs |
| `table-users <table>` | TypeORM table name | services with repository access |
| `deps-of <service-id>` | service id | outgoing dependencies by kind |
| `dependents-of <service-id>` | service id | services that depend on this one |
| `module-imports <module>` | NestJS module class | what the module imports |
| `path <from> <to>` | two node ids | shortest directed path |
| `stats` | — | node + edge counts per kind |

Options: `--out <dir>` (default `./arch-graph-out`), `--json` (default), `--table`.
Exit codes: `0` = found, `4` = not found, `1` = bad args / I/O error.

Sample:

```sh
arch-graph who-publishes user.created --table
```

```
role       owner         counterpart    kind          file                     line
---------  ------------  -------------  ------------  -----------------------  ----
publisher  my-api        user.created   nats-publish  apps/api/user.service.ts  42
```

The Claude Code skill calls these subcommands automatically when answering architecture questions — it's cheaper than an MCP round-trip and requires no running server.

## MCP server

Optional — for editors with an MCP client configured:

```sh
arch-graph mcp   # starts the stdio MCP server backed by arch-graph-out/graph.json
```

Exposes 12 tools: `subject_publishers`, `subject_subscribers`, `queue_producers`, `queue_consumers`, `service_dependencies`, `service_dependents`, `module_imports`, `table_users`, `path`, `explain`, `query`, `stats`. For unresolved / dynamic call-sites, read `arch-graph-out/diagnostics.json` directly — there is no MCP tool for it.

The CLI query subcommands are preferred over MCP when both are available (no stdio overhead, no server lifecycle).

## Limitations & honesty

This is a **static** extractor. It does not see runtime configuration, container env values, or dynamically constructed identifiers. The following are deferred or intentionally out of scope:

- **D1** — Dynamic NATS subjects (`subject.${userId}`) are recorded as `unresolved` in `diagnostics.json`, not invented as edges.
- **D2** — gRPC / Kafka / SQS — not yet covered; only NATS + BullMQ + HTTP are wired.
- **D3** — Cross-monorepo links (multi-repo deployments). Single monorepo only today.
- **D4** — Runtime DI overrides (`{ provide: TOKEN, useFactory }` that resolves at runtime). Static analysis sees the factory call, not its output.
- **D5** — Decorator metadata from external libs that doesn't follow the NestJS conventions encoded here.
- **D6** — Inferred type-only edges. Type-level uses are not graph edges; only value-level usages are.

To extend coverage, add an extractor under `src/extractors/<domain>/` and wire it into `src/pipeline/build.ts` and a `mapper/` that emits typed edges. The validation harness in `src/validation/` is the contract — every extractor must produce a ground-truth comparison that gates `arch-graph build` at the configured recall floor.

## Benchmark

Quantitative comparison with graphify across 5 NestJS monorepos lives in `bench/report.md`. Key finding: arch-graph used **7.6× fewer LLM context tokens** than graphify on the run there (688k vs 5.2M tokens across the same 15 questions, same compression aggressiveness, same `cl100k_base` encoder), because it returns typed structured results instead of raw graph dumps. Mean recall under the substring-presence necessary-condition heuristic was 100% (arch-graph) vs 39% (graphify) on that suite — a permissive "did the context even contain the answer" check, not an end-to-end LLM eval. The five reference projects are anonymized as `Project A`–`E`. The yaml in `bench/questions.yaml` has since been extended to 30 questions; re-running needs the private reference monorepos and is not reflected in the numbers above. To reproduce on your own monorepos, drop one `configs/<id>.config.ts` per project and run `bash bench/run.sh` — see `bench/README.md`.

## Compare on your own repo

Skeptical of the numbers above? Reproduce the comparison on your own codebase:

```sh
arch-graph build                                     # build your graph
/graphify /path/to/repo                              # in Claude Code, optionally
arch-graph compare --graphify graphify-out/          # see side-by-side
```

`arch-graph compare` auto-generates 10 questions from real nodes in your graph (NATS subjects, queues, DB tables, services, modules), counts `cl100k_base` tokens for each tool's compact context, and writes a markdown report at `arch-graph-out/compare-report.md`. Without `--graphify` it prints a graph-size-only summary — useful before deciding whether to run graphify.

See `arch-graph compare --help` for flags (`--questions`, `--report`, `--quiet`).

## Development

```sh
npm install
npm run dev -- build --config example.config.ts   # tsx-driven, no build step
npx tsc --noEmit                                  # typecheck
```

`configs/example.config.ts` is a starter template — copy it to `configs/<your-id>.config.ts`, point `root` at your NestJS monorepo, and pass it via `--config`.

### Integration test

Runs a full install→init→build→stats→queries→integrations flow on a synthetic NestJS fixture in a sandboxed `$TMPDIR`. No external dependencies beyond `node` and `jq`.

```
npm run test:integration             # uses the current clone
npm run test:integration:remote      # clones from github fresh
```

## License

MIT — see [LICENSE](LICENSE).
