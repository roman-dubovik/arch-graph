# platform — validation report

_2026-05-15T15:48:06.051Z_

## Summary

| Metric | Value | Target |
|---|---|---|
| Recall @ handlers | **100.0%** | ≥ 99% |
| Recall @ senders | **100.0%** | ≥ 95% |
| Classification accuracy (excl. unresolved) | **99.3%** | ≥ 95% |
| Concrete resolve rate (literal+pattern) | 87.1% | informational |
| Total extracted | 139 | |
| Total ground truth | 98 | |
| Missed (in GT, not extracted) | 0 | |
| Extra (extracted, not GT) | 41 | |

## Extra (top 30)

| File | Line | Role | Via | Subject |
|---|---|---|---|---|
| apps/ident/src/ai-qa/ident-mcp-tool-server.service.ts | 73 | receiver | PlatformConnectionService.handleRequest | `pattern:mcp.*.tools.list` |
| apps/ident/src/ai-qa/ident-mcp-tool-server.service.ts | 79 | receiver | PlatformConnectionService.handleRequest | `pattern:mcp.*.tools.call` |
| apps/platform-agent/src/core/nats-agent.service.ts | 103 | receiver | JetStreamService.subscribe | dynamic: param:subject |
| apps/platform-cron/src/services/cron-nats-executor.service.ts | 102 | sender | ClientProxy.send | dynamic: param:pattern |
| apps/platform-cron/src/services/cron-nats-executor.service.ts | 267 | sender | ClientProxy.send | dynamic: param:natsPattern |
| libs/platform/agents/src/nats/nats-central.service.ts | 220 | receiver | JetStreamService.subscribe | dynamic: param:subject |
| libs/platform/app-sdk/src/heartbeat/app-heartbeat-publisher.service.ts | 61 | sender | ClientProxy.emit | `literal:platform.app.shutting-down` |
| libs/platform/app-sdk/src/heartbeat/app-heartbeat-publisher.service.ts | 77 | sender | ClientProxy.emit | `literal:platform.app.heartbeat` |
| libs/platform/app-sdk/src/realtime/realtime.gateway.ts | 69 | sender | ClientProxy.emit | `literal:error` |
| libs/platform/app-sdk/src/realtime/realtime.gateway.ts | 77 | sender | ClientProxy.emit | `literal:error` |
| libs/platform/app-sdk/src/realtime/realtime.gateway.ts | 176 | sender | ClientProxy.emit | `literal:event` |
| libs/platform/app-sdk/src/services/callback-handler.service.ts | 43 | receiver | PlatformConnectionService.handleRequest | `pattern:app.*.callback.handle` |
| libs/platform/app-sdk/src/services/platform-connection.service.ts | 308 | receiver | JetStreamService.subscribe | dynamic: param:subject |
| libs/platform/app-sdk/src/services/platform-event-subscriber.service.ts | 225 | receiver | PlatformConnectionService.subscribe | `pattern:app.*.cron.*` |
| libs/platform/app-sdk/src/services/scenario-evaluation.handler.ts | 122 | receiver | PlatformConnectionService.handleRequest | `pattern:app.*.scenarios.evaluate` |
| libs/platform/app-sdk/src/services/scenario-evaluation.handler.ts | 128 | receiver | PlatformConnectionService.handleRequest | `pattern:app.*.broadcasts.resolve` |
| libs/platform/app-sdk/src/services/scenario-evaluation.handler.ts | 134 | receiver | PlatformConnectionService.handleRequest | `pattern:app.*.scenarios.request-registration` |
| libs/platform/appointment-app-sdk/src/scenarios/appointment-scenario-resolvers.ts | 51 | sender | PlatformConnectionService.request | `literal:platform.miniapp.resolve-url` |
| libs/platform/billing/src/handlers/billing-webhook-nats.handler.ts | 56 | receiver | JetStreamService.subscribe | `literal:platform.billing.webhook.>` |
| libs/platform/messaging/src/handlers/delivery-command-pending.handler.ts | 57 | receiver | JetStreamService.subscribe | `literal:messaging.delivery.command-pending` |
| libs/platform/messaging/src/services/message-ingestion.service.ts | 121 | receiver | NatsService.subscribe | `literal:agent.*.messages.inbound` |
| libs/platform/messaging/src/services/message-sending.service.ts | 318 | receiver | NatsService.subscribe | `literal:agent.*.delivery.confirm` |
| libs/platform/messaging/src/websocket/socket.service.ts | 33 | receiver | JetStreamService.subscribe | `literal:platform.events.message.received` |
| libs/platform/messaging/src/websocket/socket.service.ts | 42 | receiver | JetStreamService.subscribe | `literal:platform.events.message.delivered` |
| libs/platform/messaging/src/websocket/socket.service.ts | 51 | receiver | JetStreamService.subscribe | `literal:platform.events.message.attachment-stored` |
| libs/platform/saas-admin/src/super-admin/super-admin-cron.service.ts | 87 | sender | ClientProxy.send | dynamic: param:pattern |
| libs/platform/scenarios/src/nats/scenario-nats.service.ts | 32 | receiver | NatsService.subscribe | `literal:platform.scenarios.execute` |
| libs/platform/storage/src/processors/file-download.processor.ts | 130 | sender | JetStreamService.publish | `literal:platform.events.message.attachment-stored` |
| libs/platform/storage/src/processors/file-download.processor.ts | 168 | sender | JetStreamService.publish | `literal:platform.events.message.attachment-stored` |
| apps/ident/src/mssql-sync/services/sync-monitoring.service.ts | 72 | sender | PlatformConnectionService.publish | `literal:platform.notifications.sync_agent_offline` |

## Unresolved / dynamic (top 30)

| File | Line | Via | Raw |
|---|---|---|---|
| apps/platform-agent/src/core/nats-agent.service.ts | 103 | JetStreamService.subscribe | dynamic: param:subject |
| apps/platform-agent/src/core/nats-agent.service.ts | 197 | JetStreamService.publish | dynamic: param:subject |
| apps/platform-cron/src/services/cron-circuit-breaker.service.ts | 133 | ClientProxy.emit | dynamic: param:subject |
| apps/platform-cron/src/services/cron-nats-executor.service.ts | 102 | ClientProxy.send | dynamic: param:pattern |
| apps/platform-cron/src/services/cron-nats-executor.service.ts | 151 | ClientProxy.emit | dynamic: param:pattern |
| apps/platform-cron/src/services/cron-nats-executor.service.ts | 267 | ClientProxy.send | dynamic: param:natsPattern |
| apps/platform-cron/src/services/messaging-events-reconciliation.service.ts | 135 | JetStreamService.publish | unresolved (identifier not resolvable): `subject` |
| libs/platform/agents/src/nats/nats-central.service.ts | 220 | JetStreamService.subscribe | dynamic: param:subject |
| libs/platform/agents/src/nats/nats-central.service.ts | 322 | JetStreamService.publish | dynamic: param:subject |
| libs/platform/app-sdk/src/services/platform-connection.service.ts | 308 | JetStreamService.subscribe | dynamic: param:subject |
| libs/platform/appointment-app-sdk/src/sync-bridge/create-sync-bridge-controller.ts | 20 | @EventPattern | dynamic: param:natsSubject |
| libs/platform/saas-admin/src/super-admin/super-admin-cron.service.ts | 87 | ClientProxy.send | dynamic: param:pattern |
| apps/platform-api/src/services/nats-app/app-event-router.service.ts | 200 | NatsService.publish | dynamic: param:subject |
| apps/platform-api/src/services/nats-app/app-event-router.service.ts | 208 | JetStreamService.publish | dynamic: param:subject |
| libs/platform/core/src/infra/health/nats-health-controller.factory.ts | 26 | @MessagePattern | dynamic: param:subject |
| libs/platform/core/src/infra/outbox/services/outbox-publisher.service.ts | 312 | JetStreamService.publish | dynamic: param:subject |
| libs/platform/core/src/infra/outbox/services/outbox-publisher.service.ts | 320 | ClientProxy.emit | dynamic: param:subject |
| libs/platform/core/src/infra/outbox/services/outbox.service.ts | 166 | ClientProxy.emit | dynamic: param:subject |

## Subject kinds breakdown

| Kind | Count |
|---|---|
| literal | 111 |
| dynamic | 17 |
| pattern | 10 |
| unresolved | 1 |
