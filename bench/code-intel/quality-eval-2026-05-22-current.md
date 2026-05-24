# Code-Intel Quality Eval

Date: 2026-05-22T09:35:59.664Z

This is a quality-oriented eval over proof packets, not a smoke string snapshot. Each case has manually chosen `mustContain`, `niceToHave`, and `mustNotContain` checks. `PASS` requires all required and nice evidence, `PARTIAL` means the answer is usable but not complete, and `FAIL` marks missing core evidence or forbidden noise.

Summary: 7 PASS, 0 PARTIAL, 1 FAIL, 8 total.

| Project | PASS | PARTIAL | FAIL | Avg score |
|---|---:|---:|---:|---:|
| app-alpha | 2 | 0 | 0 | 1.00 |
| app-beta | 2 | 0 | 0 | 1.00 |
| monorepo-gamma | 3 | 0 | 1 | 0.75 |

## Cases

| ID | Project | Category | Result | Score | Quality focus | Missing must | Nice hits | Forbidden found |
|---|---|---|---|---:|---|---|---|---|
| APP-A-Q1 | app-alpha | call-graph | PASS | 1.00 | compact project-only trace from controller entrypoint |  | UserSummaryDto, users.controller.ts |  |
| APP-A-Q2 | app-alpha | impact | PASS | 1.00 | DTO impact should include endpoint and field-reference facts |  | EOverviewPeriod, overview-query.dto.ts |  |
| APP-B-Q1 | app-beta | call-graph | PASS | 1.00 | queue handler to scheduler trace should preserve internal chain |  | @MessagePattern, QUEUE_PATTERNS.REGISTER_JOB |  |
| APP-B-Q2 | app-beta | impact | PASS | 1.00 | frontend interface impact should stay scoped to FE action file |  | reason?: string, risk |  |
| MONO-G-Q1 | monorepo-gamma | data-flow | PASS | 1.00 | decorated HTTP body should flow through destructuring into scheduler args |  | Logger.log, cronExpression, serviceName |  |
| MONO-G-Q2 | monorepo-gamma | impact | PASS | 1.00 | base pagination DTO impact should show downstream query DTO inheritance/references |  | base-pagination.query.dto.ts, risk |  |
| MONO-G-Q3 | monorepo-gamma | data-flow | PASS | 1.00 | interprocedural payload flow should continue from public scheduler method into private registration method and persistence/executor sinks |  | Repository.create, executeJob, SchedulerRegistry.addCronJob |  |
| MONO-G-Q4 | monorepo-gamma | control-flow | FAIL | 0.00 | branch lookup should explain which condition selects save-to-db registration path | "found": true, saveToDb, true |  | "branches": [] |
