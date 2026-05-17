# arch-graph Baseline Eval — 2026-05-17

**Worktree**: `/Users/romandubovik/Documents/Projects/arch-graph/.worktrees/feat-semantic`  
**CLI**: `/Users/romandubovik/Documents/Projects/arch-graph/.worktrees/feat-semantic/src/cli/index.ts`  
**k**: 5  
**skip_build**: 1  
**Run at**: Sun May 17 07:56:27 MSK 2026

> **Context**: This run is against `feat/semantic` (Variant 3 baseline only).
> FE-L1 and Var2 are in sibling worktrees and not merged yet.
> Expected thresholds are the *post-FE-L1+Var2 uplift targets*,
> so ⚠ rows are expected at this stage.

## Results Table

| project | category | hits/total | hit-rate | expected | status |
|---------|----------|-----------|---------|---------|--------|
| platform | A_find | 4/5 | 80% | 80% | ✅ |
| platform | B_debug | 2/3 | 66% | 100% | ⚠ |
| platform | C_ui | 0/3 | 0% | 65% | ⚠ |
| platform | E_arch | 3/4 | 75% | 85% | ⚠ |
| **platform** | **overall** | **9/15** | **60%** | **85%** | **⚠** |
| insyra | A_find | 4/5 | 80% | 85% | ⚠ |
| insyra | C_ui | 0/1 | 0% | 50% | ⚠ |
| **insyra** | **overall** | **4/6** | **66%** | **85%** | **⚠** |
| beribuy2 | A_find | 2/5 | 40% | 65% | ⚠ |
| **beribuy2** | **overall** | **2/5** | **40%** | **65%** | **⚠** |

## Per-Query Detail

> HIT = top-5 contains a result satisfying score + kind + label filters.  
> MISS = no result in top-5 satisfies all filters.

### platform

| id | category | status | top-5 summary |
|----|----------|--------|----------------|
| P1 | A_find | HIT | 0.663 fe-component:ScheduleGrid | 0.635 provider:ScheduleService | 0.624 endpoint:PATCH /booking/:id/reschedule | 0.62 provider:ScheduleController | 0.617 provider:ScheduledReceptionMapperService |
| P2 | A_find | HIT | 0.577 endpoint:POST /mssql-sync/agents/:id/regenerate-token | 0.574 fe-route:/mssql-sync/SyncAgentDetailPage | 0.555 endpoint:POST /mssql-sync/agents/:id/revoke-token | 0.545 endpoint:DELETE /mssql-sync/agents/:id | 0.531 db-entity-field:ident_sync_agents/redirect_url |
| P3 | A_find | HIT | 0.68 endpoint:PATCH /mssql-sync/agents/:id | 0.68 endpoint:GET /mssql-sync/agents/:id/download | 0.671 endpoint:POST /mssql-sync/agents/:id/revoke-token | 0.666 endpoint:POST /mssql-sync/agents/:id/regenerate-token | 0.664 endpoint:GET /mssql-sync/agents/:id/settings |
| P4 | A_find | MISS | 0.573 fe-page:PlanCard | 0.569 fe-page:DiscountsCard | 0.55 fe-page:StatsDashboard | 0.549 fe-page:SummaryCard | 0.544 fe-route:/analytics/components/calls-summary-cards |
| P5 | A_find | HIT | 0.722 provider:EMAIL_SENDER | 0.712 fe-component:EmailLogsPage | 0.711 fe-page:EmailLogsPage | 0.706 queue:email | 0.694 fe-page:EmailDomainSettings |
| P6 | B_debug | MISS | 0.668 endpoint:POST /mssql-sync/agents/:id/revoke-token | 0.66 endpoint:GET /mssql-sync/agents/:agentId/executions | 0.657 endpoint:PATCH /mssql-sync/agents/:id | 0.655 endpoint:POST /mssql-sync/agents | 0.651 endpoint:GET /mssql-sync/agents/:id |
| P7 | B_debug | HIT | 0.591 provider:TelegramChannelHandler | 0.579 endpoint:POST /app/auth/telegram-widget | 0.566 provider:TelegramService | 0.558 provider:TelegramBotRegistry | 0.556 provider:TelegramMiniAppAuthHandler |
| P8 | B_debug | HIT | 0.559 db-table:appointment_time_slots | 0.557 db-entity-field:appointment_time_slots/is_busy | 0.547 db-entity-field:appointment_time_slots/date | 0.538 fe-component:TimeSlotGrid | 0.528 db-entity-field:appointment_time_slots/branch_id |
| P9 | C_ui | MISS | 0.679 endpoint:POST /chat-groups | 0.671 endpoint:POST /chats/:chatId/messages/:messageId/pin | 0.635 endpoint:POST /templates | 0.634 endpoint:POST /notifications/mutes | 0.631 endpoint:POST /chat-groups/:id/chats |
| P10 | C_ui | MISS | 0.545 endpoint:PUT /email/templates/:id | 0.535 endpoint:POST /boards/from-template/:key | 0.534 provider:AutoReplyController | 0.514 endpoint:POST /users | 0.503 endpoint:POST /app/auth/session |
| P11 | C_ui | MISS | 0.573 endpoint:POST /boards/:id/columns | 0.562 endpoint:PATCH /boards/:id/columns/:colId | 0.525 endpoint:POST /branches | 0.496 endpoint:PATCH /boards/:id/columns/reorder | 0.491 endpoint:DELETE /boards/:id/columns/:colId |
| P12 | E_arch | HIT | 0.718 endpoint:PATCH /mssql-sync/agents/:id | 0.701 endpoint:POST /mssql-sync/agents/:id/revoke-token | 0.695 endpoint:PATCH /mssql-sync/agents/:agentId/task-overrides/:id | 0.694 endpoint:POST /mssql-sync/agents | 0.694 endpoint:PATCH /mssql-sync/agents/:id/settings |
| P13 | E_arch | HIT | 0.594 provider:ServicesService | 0.578 nats-subject:admin.cron.services-health | 0.544 nats-subject:admin.cron.jobs | 0.525 provider:ServiceMapperService | 0.519 provider:ProfessionBridgeHandler |
| P14 | E_arch | MISS | 0.499 fe-component:PaletteItem | 0.476 fe-component:Separator | 0.468 fe-component:Separator | 0.462 fe-component:MultipleChoiceQuestion | 0.459 fe-component:AttachmentItem |
| P15 | E_arch | HIT | 0.674 service:platform-miniapp | 0.667 endpoint:POST /app/auth/telegram-widget | 0.666 fe-component:TelegramIcon | 0.665 provider:TelegramMiniAppAuthHandler | 0.652 provider:TelegramChannelHandler |

### insyra

| id | category | status | top-5 summary |
|----|----------|--------|----------------|
| I1 | A_find | HIT | 0.696 fe-component:InstagramScraperQueue | 0.689 provider:InstagramScrapingProcessor | 0.65 provider:InstagramQueueService | 0.637 provider:InstagramDataService | 0.629 db-entity-field:blog_profile_snapshots/followers |
| I2 | A_find | HIT | 0.694 db-entity-field:stripe_payments/status | 0.69 db-entity-field:stripe_payments/external_transaction_id | 0.686 db-entity-field:stripe_payments/currency | 0.685 db-entity-field:stripe_payments/amount | 0.68 provider:PaymentProviderFactory |
| I3 | A_find | MISS | 0.505 fe-component:AvatarUpload | 0.498 fe-route:/topic-evolution | 0.497 fe-component:AvatarUpload | 0.476 fe-component:AnalyticsSkeleton | 0.468 fe-component:Avatar |
| I4 | A_find | HIT | 0.708 db-entity-field:notification_email_suppressions/id | 0.703 db-entity-field:notification_email_suppressions/email | 0.694 db-entity-field:notification_logs/recipientEmail | 0.693 db-entity-field:notification_email_events/email | 0.693 db-entity-field:notification_email_events/notificationLogId |
| I5 | A_find | HIT | 0.575 fe-component:AdminHeader | 0.571 provider:FollowersTrendService | 0.557 fe-component:AdminHeader | 0.545 nats-subject:admin.webhooks.detail | 0.542 fe-component:AdminUsersPage |
| I6 | C_ui | MISS | 0.633 db-table:insyra_sessions | 0.625 db-table:insyra_password_resets | 0.609 db-table:insyra_api_clients | 0.608 db-table:insyra_users | 0.606 db-table:insyra_waitlist |

### beribuy2

| id | category | status | top-5 summary |
|----|----------|--------|----------------|
| B1 | A_find | MISS | 0.471 provider:CacheService | 0.463 db-table:companies | 0.44 db-table:employees | 0.408 fe-page:CompaniesList | 0.405 provider:ScheduleFactory |
| B2 | A_find | MISS | 0.477 fe-component:Od | 0.435 fe-component:MuiRte | 0.396 fe-component:PromocodesRightHelper | 0.386 fe-component:PromocodeEdit | 0.386 lib:libs/fe-sdk |
| B3 | A_find | HIT | 0.485 nats-subject:SEND_SECURITY_ALERT | 0.448 fe-route:/external-promocodes/form | 0.441 nats-subject:guard.parse-log | 0.42 provider:PromocodeValidationService | 0.415 fe-route:/promocodes/form |
| B4 | A_find | MISS | 0.365 provider:CacheService | 0.364 fe-component:Card | 0.345 fe-component:SummaryCards | 0.345 fe-component:SummaryCards | 0.343 fe-component:DeliveryIcon |
| B5 | A_find | HIT | 0.572 provider:UserAuthConfig | 0.568 provider:UserService | 0.561 fe-component:AppPermissionProvider | 0.537 db-entity-field:users/surname | 0.518 db-entity-field:users/email |

## Missed Queries (MISS detail)

Queries that did NOT hit, with top-5 results:

- **P4** [platform/A_find] "карты в напоминаниях о записи"
  - top-5: 0.573 fe-page:PlanCard | 0.569 fe-page:DiscountsCard | 0.55 fe-page:StatsDashboard | 0.549 fe-page:SummaryCard | 0.544 fe-route:/analytics/components/calls-summary-cards
- **P6** [platform/B_debug] "mssql агент синк ошибки логи"
  - top-5: 0.668 endpoint:POST /mssql-sync/agents/:id/revoke-token | 0.66 endpoint:GET /mssql-sync/agents/:agentId/executions | 0.657 endpoint:PATCH /mssql-sync/agents/:id | 0.655 endpoint:POST /mssql-sync/agents | 0.651 endpoint:GET /mssql-sync/agents/:id
- **P9** [platform/C_ui] "обрезать последнее сообщение в списке чатов в 3 точки"
  - top-5: 0.679 endpoint:POST /chat-groups | 0.671 endpoint:POST /chats/:chatId/messages/:messageId/pin | 0.635 endpoint:POST /templates | 0.634 endpoint:POST /notifications/mutes | 0.631 endpoint:POST /chat-groups/:id/chats
- **P10** [platform/C_ui] "дровер справа при клике по клиенту в админке"
  - top-5: 0.545 endpoint:PUT /email/templates/:id | 0.535 endpoint:POST /boards/from-template/:key | 0.534 provider:AutoReplyController | 0.514 endpoint:POST /users | 0.503 endpoint:POST /app/auth/session
- **P11** [platform/C_ui] "колонка статус выровнять по правому краю"
  - top-5: 0.573 endpoint:POST /boards/:id/columns | 0.562 endpoint:PATCH /boards/:id/columns/:colId | 0.525 endpoint:POST /branches | 0.496 endpoint:PATCH /boards/:id/columns/reorder | 0.491 endpoint:DELETE /boards/:id/columns/:colId
- **P14** [platform/E_arch] "что такое тенант ident мульти-тенантность"
  - top-5: 0.499 fe-component:PaletteItem | 0.476 fe-component:Separator | 0.468 fe-component:Separator | 0.462 fe-component:MultipleChoiceQuestion | 0.459 fe-component:AttachmentItem
- **I3** [insyra/A_find] "AI сценарии генерация контента"
  - top-5: 0.505 fe-component:AvatarUpload | 0.498 fe-route:/topic-evolution | 0.497 fe-component:AvatarUpload | 0.476 fe-component:AnalyticsSkeleton | 0.468 fe-component:Avatar
- **I6** [insyra/C_ui] "клиент таблица колонка фронтенд"
  - top-5: 0.633 db-table:insyra_sessions | 0.625 db-table:insyra_password_resets | 0.609 db-table:insyra_api_clients | 0.608 db-table:insyra_users | 0.606 db-table:insyra_waitlist
- **B1** [beribuy2/A_find] "корзина оформление заказа checkout"
  - top-5: 0.471 provider:CacheService | 0.463 db-table:companies | 0.44 db-table:employees | 0.408 fe-page:CompaniesList | 0.405 provider:ScheduleFactory
- **B2** [beribuy2/A_find] "промокод скидка"
  - top-5: 0.477 fe-component:Od | 0.435 fe-component:MuiRte | 0.396 fe-component:PromocodesRightHelper | 0.386 fe-component:PromocodeEdit | 0.386 lib:libs/fe-sdk
- **B4** [beribuy2/A_find] "платежи оплата товара"
  - top-5: 0.365 provider:CacheService | 0.364 fe-component:Card | 0.345 fe-component:SummaryCards | 0.345 fe-component:SummaryCards | 0.343 fe-component:DeliveryIcon

## Notes

- Expected thresholds reflect **post FE-L1+Var2 uplift targets**.
- Variant-3 baseline is ~60% / ~50% / ~40% overall — all ⚠ are intentional.
- Re-run after merging `feat/fe-l1` and `feat/var2-extractors` to measure uplift.

[eval] 
[eval] Results saved to: /Users/romandubovik/Documents/Projects/arch-graph/.worktrees/feat-semantic/scripts/eval/results-2026-05-17.md
[eval] All thresholds met. Exit 0.
