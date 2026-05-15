# beribuy2 — validation report

_2026-05-15T15:48:13.113Z_

## Summary

| Metric | Value | Target |
|---|---|---|
| Recall @ handlers | **100.0%** | ≥ 99% |
| Recall @ senders | **100.0%** | ≥ 95% |
| Classification accuracy (excl. unresolved) | **100.0%** | ≥ 95% |
| Concrete resolve rate (literal+pattern) | 91.4% | informational |
| Total extracted | 35 | |
| Total ground truth | 32 | |
| Missed (in GT, not extracted) | 0 | |
| Extra (extracted, not GT) | 3 | |

## Extra (top 30)

| File | Line | Role | Via | Subject |
|---|---|---|---|---|
| apps/be-cron-service/src/services/cron-scheduler.service.ts | 907 | sender | ClientProxy.send | dynamic: param:pattern |
| apps/be-cron-service/src/services/cron-scheduler.service.ts | 946 | sender | ClientProxy.send | `pattern:*.*` |
| libs/nest-shared/src/utils/nats.utils.ts | 26 | sender | ClientProxy.send | dynamic: param:pattern |

## Unresolved / dynamic (top 30)

| File | Line | Via | Raw |
|---|---|---|---|
| apps/be-cron-service/src/services/cron-scheduler.service.ts | 907 | ClientProxy.send | dynamic: param:pattern |
| apps/be-cron-service/src/services/cron-scheduler.service.ts | 999 | ClientProxy.emit | dynamic: param:pattern |
| libs/nest-shared/src/utils/nats.utils.ts | 26 | ClientProxy.send | dynamic: param:pattern |

## Subject kinds breakdown

| Kind | Count |
|---|---|
| literal | 26 |
| pattern | 6 |
| dynamic | 3 |
