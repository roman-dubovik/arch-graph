# insyra — validation report

_2026-05-15T15:48:11.084Z_

## Summary

| Metric | Value | Target |
|---|---|---|
| Recall @ handlers | **100.0%** | ≥ 99% |
| Recall @ senders | **100.0%** | ≥ 95% |
| Classification accuracy (excl. unresolved) | **99.3%** | ≥ 95% |
| Concrete resolve rate (literal+pattern) | 98.0% | informational |
| Total extracted | 544 | |
| Total ground truth | 499 | |
| Missed (in GT, not extracted) | 0 | |
| Extra (extracted, not GT) | 45 | |

## Extra (top 30)

| File | Line | Role | Via | Subject |
|---|---|---|---|---|
| apps/be-cron-service/src/services/cron-nats-executor.service.ts | 93 | sender | ClientProxy.send | dynamic: param:pattern |
| apps/be-cron-service/src/services/cron-nats-executor.service.ts | 282 | sender | ClientProxy.send | dynamic: param:natsPattern |
| libs/nest-shared/src/notification/notification-client.service.ts | 87 | sender | ClientProxy.send | `literal:notification.email.verification` |
| libs/nest-shared/src/notification/notification-client.service.ts | 131 | sender | ClientProxy.send | `literal:notification.email.password-reset` |
| libs/nest-shared/src/notification/notification-client.service.ts | 165 | sender | ClientProxy.send | `literal:notification.send` |
| libs/nest-shared/src/notification/notification-client.service.ts | 257 | sender | ClientProxy.send | `literal:notification.email.waitlist-verification` |
| libs/nest-shared/src/notification/notification-client.service.ts | 299 | sender | ClientProxy.send | `literal:notification.email.waitlist-invite` |
| libs/nest-shared/src/notification/notification-client.service.ts | 342 | sender | ClientProxy.send | `literal:notification.email.waitlist-custom` |
| libs/nest-shared/src/notification/notification-client.service.ts | 383 | sender | ClientProxy.send | `literal:notification.email.welcome` |
| apps/be-insyra/src/modules/cron/cron.controller.ts | 449 | sender | ClientProxy.send | `literal:admin.blog.passport.get-by-platform` |
| apps/be-insyra/src/modules/cron/cron.controller.ts | 1277 | sender | ClientProxy.send | `literal:admin.blog.passport.get-by-platform` |
| apps/be-insyra/src/modules/events/jetstream-events-consumer.service.ts | 42 | receiver | JetStreamService.subscribe | unresolved (unsupported kind: ObjectLiteralExpression): `{
                stream: JETSTREAM_STREAM_CONFIGS.EVENTS.na` |
| apps/be-insyra/src/modules/events/passport-events.handler.ts | 69 | receiver | JetStreamService.subscribe | unresolved (unsupported kind: ObjectLiteralExpression): `{
                    stream: JETSTREAM_STREAM_CONFIGS.EVENT` |
| apps/be-insyra/src/modules/extension/extension-cache.controller.ts | 51 | sender | ClientProxy.send | `literal:admin.blog.passport.get-by-platform` |
| apps/be-insyra/src/modules/extension/extension.service.ts | 79 | sender | ClientProxy.send | `literal:admin.blog.passport.get-by-platform` |
| apps/be-insyra/src/modules/extension/extension.service.ts | 120 | sender | ClientProxy.send | `literal:admin.blog.passports.list` |
| apps/be-insyra/src/modules/extension/extension.service.ts | 192 | sender | ClientProxy.send | `literal:admin.blog.analyze` |
| apps/be-insyra/src/modules/extension/extension.service.ts | 241 | sender | ClientProxy.send | `literal:admin.blog.analysis-status` |
| apps/be-insyra/src/modules/extension/extension.service.ts | 279 | sender | ClientProxy.send | `literal:admin.blog.passport.get-by-platform` |
| libs/nest-shared/src/nats/helpers/nats-request.helper.ts | 85 | sender | ClientProxy.send | dynamic: param:pattern |
| apps/be-insyra/src/modules/admin/services/system-news.service.ts | 122 | sender | ClientProxy.emit | `literal:events.system-news.published` |
| apps/be-insyra/src/modules/user/auth/auth.service.ts | 1161 | sender | ClientProxy.send | `literal:insyra.user.subscription.create-free` |
| apps/be-insyra/src/modules/user/blogs/blogs.service.ts | 102 | sender | ClientProxy.send | `literal:admin.blog.passport.get-by-platform` |
| apps/be-insyra/src/modules/user/blogs/blogs.service.ts | 217 | sender | ClientProxy.send | `literal:admin.blog.passports.list` |
| apps/be-insyra/src/modules/user/blogs/blogs.service.ts | 250 | sender | ClientProxy.send | `literal:admin.blog.passports.list` |
| apps/be-insyra/src/modules/user/blogs/blogs.service.ts | 641 | sender | ClientProxy.send | `literal:admin.blog.import-and-analyze` |
| apps/be-insyra/src/modules/user/blogs/blogs.service.ts | 823 | sender | ClientProxy.send | `literal:admin.blog.passport.get-by-platform` |
| apps/be-insyra/src/modules/user/blogs/blogs.service.ts | 870 | sender | ClientProxy.send | `literal:admin.blog.passport.get-by-id` |
| apps/be-insyra/src/modules/user/blogs/blogs.service.ts | 924 | sender | ClientProxy.send | `literal:admin.blog.passport.get-by-id` |
| apps/be-insyra/src/modules/user/blogs/blogs.service.ts | 1211 | sender | ClientProxy.send | `literal:admin.blog.import-and-analyze` |

## Unresolved / dynamic (top 30)

| File | Line | Via | Raw |
|---|---|---|---|
| apps/be-cron-service/src/services/cron-internal-jobs.service.ts | 291 | ClientProxy.send | unresolved (cannot resolve declaration): `service.pattern` |
| apps/be-cron-service/src/services/cron-nats-executor.service.ts | 93 | ClientProxy.send | dynamic: param:pattern |
| apps/be-cron-service/src/services/cron-nats-executor.service.ts | 154 | ClientProxy.emit | dynamic: param:pattern |
| apps/be-cron-service/src/services/cron-nats-executor.service.ts | 282 | ClientProxy.send | dynamic: param:natsPattern |
| libs/nest-shared/src/health/nats-health-controller.factory.ts | 22 | @MessagePattern | dynamic: param:subject |
| apps/be-ai/src/modules/events/events.service.ts | 77 | JetStreamService.publish | dynamic: param:subject |
| apps/be-ai/src/modules/events/events.service.ts | 97 | ClientProxy.emit | dynamic: param:subject |
| apps/be-insyra/src/modules/events/jetstream-events-consumer.service.ts | 42 | JetStreamService.subscribe | unresolved (unsupported kind: ObjectLiteralExpression): `{
                stream: JETSTREAM_STREAM_CONFIGS.EVENTS.na` |
| apps/be-insyra/src/modules/events/passport-events.handler.ts | 69 | JetStreamService.subscribe | unresolved (unsupported kind: ObjectLiteralExpression): `{
                    stream: JETSTREAM_STREAM_CONFIGS.EVENT` |
| libs/nest-shared/src/nats/helpers/nats-request.helper.ts | 85 | ClientProxy.send | dynamic: param:pattern |
| apps/be-notification/src/modules/internal/services/jetstream-notification-consumer.service.ts | 44 | JetStreamService.subscribe | unresolved (unsupported kind: ObjectLiteralExpression): `{
                stream: JETSTREAM_STREAM_CONFIGS.NOTIFICAT` |

## Subject kinds breakdown

| Kind | Count |
|---|---|
| literal | 521 |
| pattern | 12 |
| dynamic | 7 |
| unresolved | 4 |
