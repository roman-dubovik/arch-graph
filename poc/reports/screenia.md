# screenia — validation report

_2026-05-15T15:48:20.228Z_

## Summary

| Metric | Value | Target |
|---|---|---|
| Recall @ handlers | **100.0%** | ≥ 99% |
| Recall @ senders | **100.0%** | ≥ 95% |
| Classification accuracy (excl. unresolved) | **100.0%** | ≥ 95% |
| Concrete resolve rate (literal+pattern) | 97.9% | informational |
| Total extracted | 94 | |
| Total ground truth | 87 | |
| Missed (in GT, not extracted) | 0 | |
| Extra (extracted, not GT) | 7 | |

## Extra (top 30)

| File | Line | Role | Via | Subject |
|---|---|---|---|---|
| libs/nest-shared/src/notification/notification-client.service.ts | 87 | sender | ClientProxy.send | `literal:notification.email.verification` |
| libs/nest-shared/src/notification/notification-client.service.ts | 131 | sender | ClientProxy.send | `literal:notification.email.password-reset` |
| libs/nest-shared/src/notification/notification-client.service.ts | 165 | sender | ClientProxy.send | `literal:notification.send` |
| libs/nest-shared/src/notification/notification-client.service.ts | 257 | sender | ClientProxy.send | `literal:notification.email.waitlist-verification` |
| libs/nest-shared/src/notification/notification-client.service.ts | 299 | sender | ClientProxy.send | `literal:notification.email.waitlist-invite` |
| libs/nest-shared/src/notification/notification-client.service.ts | 342 | sender | ClientProxy.send | `literal:notification.email.waitlist-custom` |
| libs/nest-shared/src/notification/notification-client.service.ts | 383 | sender | ClientProxy.send | `literal:notification.email.welcome` |

## Unresolved / dynamic (top 30)

| File | Line | Via | Raw |
|---|---|---|---|
| apps/be-cron-service/src/services/outbox-drain.service.ts | 29 | ClientProxy.emit | dynamic: param:subject |
| apps/be-cron-service/src/services/subscription-lifecycle.cron.ts | 34 | ClientProxy.send | dynamic: param:pattern |

## Subject kinds breakdown

| Kind | Count |
|---|---|
| literal | 92 |
| dynamic | 2 |
