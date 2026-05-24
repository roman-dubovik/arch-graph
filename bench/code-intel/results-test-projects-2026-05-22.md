# code-intel smoke on reference projects

Date: 2026-05-22

Projects (paths shown as placeholders; resolved at run time from CLI args or env vars):

- `<reference-project>/app-alpha`
- `<reference-project>/app-beta`
- `<reference-project>/monorepo-gamma/monorepo-gamma-2.0`

All outputs were written under `<tmp>/*`; no graph files were written into the target repositories.

## Build Results

| Project | Build Time | Symbols | Calls | Flows | Branches | Impacts |
|---------|------------|---------|-------|-------|----------|---------|
| app-alpha | ~21s | 25390 | 26756 | 18857 | 4889 | 23711 |
| app-beta | ~24s | 27588 | 42807 | 17587 | 5857 | 31454 |
| monorepo-gamma-2.0 | ~9s | 5909 | 5707 | 4362 | 1009 | 7064 |

## Fixes Driven By This Run

### Impact pass performance and noise

Initial `monorepo-gamma-2.0` run completed but produced `63514` impacts, including `57495` `field-reference` facts. The old heuristic matched any property access with a DTO field name across the entire project.

Fix:

- `collectImpacts` now performs one AST pass instead of `DTO x files x descendants`.
- Field references are accepted only when the property receiver matches the DTO/type by name or TypeScript type text.

Result on `monorepo-gamma-2.0`:

| Metric | Before | After |
|--------|--------|-------|
| Total impacts | 63514 | 7064 |
| Field references | 57495 | 1045 |
| Build time | long/noisy | ~9s |

### Data-flow through destructuring

Real queue handler examples showed that `data` was linked to local destructuring, but destructured aliases were not linked to downstream service calls.

Fix:

- Data-flow now propagates simple local aliases from variable declarations and object/array destructuring.

Validated example:

```text
@Body data
  -> jobName / cronExpression / serviceName / pattern / payload
  -> JobSchedulerService.registerQueueJob arg
```

## Representative Query Checks

| Project | Query | Result |
|---------|-------|--------|
| app-alpha | `trace-scenario --entry UsersController.getSummary --max-depth 2` | Resolved controller method and internal `this.findItemIds(...)` call. |
| app-alpha | `impact-contract OverviewQueryDto --max-results 20` | Found endpoint usage, type references, and `query.period` field access. |
| app-beta | `trace-scenario --entry JobController.handleRegisterJob --max-depth 2` | Resolved queue handler to `JobSchedulerService.registerQueueJob`, then internal registration calls. |
| app-beta | `impact-contract IAddItemDto --max-results 20` | Found FE action type references without unrelated field noise. |
| monorepo-gamma-2.0 | `trace-scenario --entry JobController.registerQueueJob --max-depth 2` | Resolved HTTP handler to `JobSchedulerService.registerQueueJob`, then `_registerQueueJob`. |
| monorepo-gamma-2.0 | `explain-flow --target JobController.registerQueueJob --param data --max-results 12` | Found `@Body data`, destructured aliases, and service call argument flow. |
| monorepo-gamma-2.0 | `impact-contract BasePaginationQueryDto --max-results 20` | Found many extending query DTO contracts and declaration metadata. |

## Residual Gaps

- Resolved call ratio is still low on large apps (`~0.17-0.21`). Most unresolved calls are framework/library/fluent APIs (`this.logger`, `queryRunner`, `useState`, `Date`, `String`, `Math`, query builders). This is acceptable for v1 proof packets but should become a diagnostic category.
- `trace-scenario` currently follows resolved internal calls only. This keeps answers compact, but external/framework calls are omitted rather than summarized.
- Data-flow is still lightweight: aliases and local destructuring are covered, but full interprocedural value propagation is not.

