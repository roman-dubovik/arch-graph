# Code-Intel Project Questions Snapshot

Date: 2026-05-22T12:11:41.503Z

## Summary

Total: 9/9 PASS.

| Project | PASS | Total |
|---|---:|---:|
| project-alpha | 3 | 3 |
| project-beta | 3 | 3 |
| project-gamma | 3 | 3 |

Sidecars: `<tmp>/*/code-intel`.

## Project: project-alpha

Index: 25390 symbols, 26756 calls, 18857 flows, 4889 branches, 23716 impacts. Project resolved ratio: 0.4371.

| ID | Category | Question | Tool | Result | Details |
|---|---|---|---|---|---|
| PLAT-CI1 | call-graph | Какая компактная цепочка вызовов строится для PatientsController.getSummary? | trace_scenario | PASS |  |
| PLAT-CI2 | impact | Какие места затрагивает контракт DashboardQueryDto? | impact_contract | PASS |  |
| PLAT-CI3 | symbol | Где объявлен TbankWebhookController и какие методы он содержит? | resolve_symbol | PASS |  |

## Project: project-beta

Index: 27588 symbols, 42807 calls, 17587 flows, 5857 branches, 31455 impacts. Project resolved ratio: 0.2414.

| ID | Category | Question | Tool | Result | Details |
|---|---|---|---|---|---|
| INSY-CI1 | call-graph | Какая цепочка вызовов идет от CronController.handleRegisterCronJob к регистрации NATS cron? | trace_scenario | PASS |  |
| INSY-CI2 | impact | Где используется FE контракт IAddToSuppressionDto? | impact_contract | PASS |  |
| INSY-CI3 | symbol | Где объявлен метод CronSchedulerService.registerNatsCronJob? | resolve_symbol | PASS |  |

## Project: project-gamma

Index: 5909 symbols, 5707 calls, 4362 flows, 1009 branches, 7063 impacts. Project resolved ratio: 0.5728.

| ID | Category | Question | Tool | Result | Details |
|---|---|---|---|---|---|
| BERI-CI1 | call-graph | Какая цепочка вызовов идет от CronController.registerNatsCronJob к scheduler? | trace_scenario | PASS |  |
| BERI-CI2 | data-flow | Как @Body data проходит в CronController.registerNatsCronJob? | explain_data_flow | PASS |  |
| BERI-CI3 | impact | Какие DTO зависят от BasePaginationQueryDto? | impact_contract | PASS |  |

