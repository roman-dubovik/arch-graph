# unpacks — validation report

_2026-05-15T15:48:15.497Z_

## Summary

| Metric | Value | Target |
|---|---|---|
| Recall @ handlers | **100.0%** | ≥ 99% |
| Recall @ senders | **100.0%** | ≥ 95% |
| Classification accuracy (excl. unresolved) | **100.0%** | ≥ 95% |
| Concrete resolve rate (literal+pattern) | 97.8% | informational |
| Total extracted | 91 | |
| Total ground truth | 90 | |
| Missed (in GT, not extracted) | 0 | |
| Extra (extracted, not GT) | 1 | |

## Extra (top 30)

| File | Line | Role | Via | Subject |
|---|---|---|---|---|
| libs/nest-shared/src/nats/helpers/nats-request.helper.ts | 85 | sender | ClientProxy.send | dynamic: param:pattern |

## Unresolved / dynamic (top 30)

| File | Line | Via | Raw |
|---|---|---|---|
| apps/be-ai/src/modules/events/events.service.ts | 78 | ClientProxy.emit | dynamic: param:subject |
| libs/nest-shared/src/nats/helpers/nats-request.helper.ts | 85 | ClientProxy.send | dynamic: param:pattern |

## Subject kinds breakdown

| Kind | Count |
|---|---|
| literal | 85 |
| pattern | 4 |
| dynamic | 2 |
