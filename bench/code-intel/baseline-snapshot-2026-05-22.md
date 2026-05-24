# Code-Intel Baseline Snapshot

Date: 2026-05-22T06:43:02.031Z

## Project: app-alpha

| ID | Category | Question | Tool | Result | Details |
|---|---|---|---|---|---|
| APP-A-CI1 | data-flow | How does data from @Body() CreateUserDto reach the password hashing method? | explain_data_flow | FAIL | Missing: UsersService.register, PasswordHasher.hash |
| APP-A-CI2 | impact | Which endpoints break if the 'tenantId' field is removed from AuthHeaderDto? | impact_contract | FAIL | Missing: kind: endpoint, guards/tenant.guard.ts, TenantInterceptor |
| APP-A-CI3 | call-graph | Trace the payment processing call chain from controller down to repository. | trace_scenario | FAIL | Missing: PaymentsService.process, StripeProvider.charge, TransactionsRepository.save |

## Project: app-beta

| ID | Category | Question | Tool | Result | Details |
|---|---|---|---|---|---|
| APP-B-CI1 | symbol | Where is the 'order.created' event handler declared and which DTO does it expect? | resolve_symbol | FAIL | Missing: OrdersHandler.handleCreated, OrderCreatedPayload |
| APP-B-CI2 | data-flow | Where does the CorrelationId in InventoryService logs come from? | explain_data_flow | FAIL | Missing: NatsContext, getCorrelationId, Logger.log |
| APP-B-CI3 | control-flow | Under which condition does AnalyticsService trigger an aggregate cache reset? | explain_branch | FAIL | Missing: forceRefresh === true, this.cache.clear() |

## Project: monorepo-gamma

| ID | Category | Question | Tool | Result | Details |
|---|---|---|---|---|---|
| MONO-G-CI1 | impact | Which React components reference the generated ProductDto.discountPrice field? | impact_contract | FAIL | Missing: ProductCard.tsx, CartSummary.tsx, kind: type-reference |
| MONO-G-CI2 | call-graph | What is the order of cart-validation method calls before checkout? | trace_scenario | FAIL | Missing: checkStock, calculateShipping, validateCoupon |
| MONO-G-CI3 | data-flow | How does the couponCode flow from controller to the final discount application? | explain_data_flow | FAIL | Missing: PriceCalculator.applyDiscount, totalAmount |

