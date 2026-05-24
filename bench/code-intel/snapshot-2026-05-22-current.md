# Code-Intel Project Questions Snapshot

Date: 2026-05-22T12:11:41.503Z

## Summary

Total: 9/9 PASS.

| Project | PASS | Total |
|---|---:|---:|
| app-alpha | 3 | 3 |
| app-beta | 3 | 3 |
| monorepo-gamma | 3 | 3 |

Sidecars: `<tmp>/*/code-intel`.

## Project: app-alpha

Index: 25390 symbols, 26756 calls, 18857 flows, 4889 branches, 23716 impacts. Project resolved ratio: 0.4371.

| ID | Category | Question | Tool | Result | Details |
|---|---|---|---|---|---|
| APP-A-CI1 | call-graph | Compact call chain for UsersController.getSummary? | trace_scenario | PASS |  |
| APP-A-CI2 | impact | Impact of the OverviewQueryDto contract? | impact_contract | PASS |  |
| APP-A-CI3 | symbol | Where is BillingWebhookController declared and what methods does it expose? | resolve_symbol | PASS |  |

## Project: app-beta

Index: 27588 symbols, 42807 calls, 17587 flows, 5857 branches, 31455 impacts. Project resolved ratio: 0.2414.

| ID | Category | Question | Tool | Result | Details |
|---|---|---|---|---|---|
| APP-B-CI1 | call-graph | Call chain from JobController.handleRegisterJob to queue registration? | trace_scenario | PASS |  |
| APP-B-CI2 | impact | Where is the FE contract IAddItemDto used? | impact_contract | PASS |  |
| APP-B-CI3 | symbol | Where is the JobSchedulerService.registerQueueJob method declared? | resolve_symbol | PASS |  |

## Project: monorepo-gamma

Index: 5909 symbols, 5707 calls, 4362 flows, 1009 branches, 7063 impacts. Project resolved ratio: 0.5728.

| ID | Category | Question | Tool | Result | Details |
|---|---|---|---|---|---|
| MONO-G-CI1 | call-graph | Call chain from JobController.registerQueueJob to scheduler? | trace_scenario | PASS |  |
| MONO-G-CI2 | data-flow | How does @Body data flow through JobController.registerQueueJob? | explain_data_flow | PASS |  |
| MONO-G-CI3 | impact | Which DTOs depend on BasePaginationQueryDto? | impact_contract | PASS |  |

