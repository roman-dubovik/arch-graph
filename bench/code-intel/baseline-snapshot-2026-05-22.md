# Code-Intel Baseline Snapshot

Date: 2026-05-22T06:43:02.031Z

## Project: project-alpha

| ID | Category | Question | Tool | Result | Details |
|---|---|---|---|---|---|
| PLAT-CI1 | data-flow | Как данные из @Body() CreateUserDto попадают в метод хеширования пароля? | explain_data_flow | ❌ FAIL | Missing: UsersService.register, PasswordHasher.hash |
| PLAT-CI2 | impact | Какие эндпоинты перестанут работать, если удалить поле 'tenantId' из AuthHeaderDto? | impact_contract | ❌ FAIL | Missing: kind: endpoint, guards/tenant.guard.ts, TenantInterceptor |
| PLAT-CI3 | call-graph | Проследи цепочку вызовов при обработке платежа от контроллера до репозитория. | trace_scenario | ❌ FAIL | Missing: PaymentsService.process, StripeProvider.charge, TransactionsRepository.save |

## Project: project-beta

| ID | Category | Question | Tool | Result | Details |
|---|---|---|---|---|---|
| INSY-CI1 | symbol | Где объявлен обработчик события 'order.created' и какой DTO он ожидает? | resolve_symbol | ❌ FAIL | Missing: OrdersHandler.handleCreated, OrderCreatedPayload |
| INSY-CI2 | data-flow | Откуда берется CorrelationId в логах при обработке сообщения в InventoryService? | explain_data_flow | ❌ FAIL | Missing: NatsContext, getCorrelationId, Logger.log |
| INSY-CI3 | control-flow | При каком условии в AnalyticsService срабатывает сброс кеша агрегатов? | explain_branch | ❌ FAIL | Missing: forceRefresh === true, this.cache.clear() |

## Project: project-gamma

| ID | Category | Question | Tool | Result | Details |
|---|---|---|---|---|---|
| BERI-CI1 | impact | Какие React-компоненты используют поле 'discountPrice' из сгенерированного ProductDto? | impact_contract | ❌ FAIL | Missing: ProductCard.tsx, CartSummary.tsx, kind: type-reference |
| BERI-CI2 | call-graph | В каком порядке вызываются методы валидации корзины перед оформлением заказа? | trace_scenario | ❌ FAIL | Missing: checkStock, calculateShipping, validateCoupon |
| BERI-CI3 | data-flow | Как промокод (couponCode) проходит от контроллера до применения скидки в итоговой сумме? | explain_data_flow | ❌ FAIL | Missing: PriceCalculator.applyDiscount, totalAmount |

