# code-intel smoke on reference projects

Date: 2026-05-22

Projects:

- `<user-home>/Documents/Projects/project-alpha`
- `<user-home>/Documents/Projects/project-beta`
- `<user-home>/Documents/Projects/project-gamma/project-gamma-2.0`

All outputs were written under `<tmp>/*`; no graph files were written into the target repositories.

## Build Results

| Project | Build Time | Symbols | Calls | Flows | Branches | Impacts |
|---------|------------|---------|-------|-------|----------|---------|
| project-alpha | ~21s | 25390 | 26756 | 18857 | 4889 | 23711 |
| project-beta | ~24s | 27588 | 42807 | 17587 | 5857 | 31454 |
| project-gamma-2.0 | ~9s | 5909 | 5707 | 4362 | 1009 | 7064 |

## Fixes Driven By This Run

### Impact pass performance and noise

Initial `project-gamma-2.0` run completed but produced `63514` impacts, including `57495` `field-reference` facts. The old heuristic matched any property access with a DTO field name across the entire project.

Fix:

- `collectImpacts` now performs one AST pass instead of `DTO x files x descendants`.
- Field references are accepted only when the property receiver matches the DTO/type by name or TypeScript type text.

Result on `project-gamma-2.0`:

| Metric | Before | After |
|--------|--------|-------|
| Total impacts | 63514 | 7064 |
| Field references | 57495 | 1045 |
| Build time | long/noisy | ~9s |

### Data-flow through destructuring

Real cron handler examples showed that `data` was linked to local destructuring, but destructured aliases were not linked to downstream service calls.

Fix:

- Data-flow now propagates simple local aliases from variable declarations and object/array destructuring.

Validated example:

```text
@Body data
  -> jobName / cronExpression / serviceName / pattern / payload
  -> CronSchedulerService.registerNatsCronJob arg
```

## Representative Query Checks

| Project | Query | Result |
|---------|-------|--------|
| project-alpha | `trace-scenario --entry PatientsController.getSummary --max-depth 2` | Resolved controller method and internal `this.findClientIds(...)` call. |
| project-alpha | `impact-contract DashboardQueryDto --max-results 20` | Found endpoint usage, type references, and `query.period` field access. |
| project-beta | `trace-scenario --entry CronController.handleRegisterCronJob --max-depth 2` | Resolved NATS handler to `CronSchedulerService.registerNatsCronJob`, then internal registration calls. |
| project-beta | `impact-contract IAddToSuppressionDto --max-results 20` | Found FE action type references without unrelated field noise. |
| project-gamma-2.0 | `trace-scenario --entry CronController.registerNatsCronJob --max-depth 2` | Resolved HTTP handler to `CronSchedulerService.registerNatsCronJob`, then `_registerNatsCronJob`. |
| project-gamma-2.0 | `explain-flow --target CronController.registerNatsCronJob --param data --max-results 12` | Found `@Body data`, destructured aliases, and service call argument flow. |
| project-gamma-2.0 | `impact-contract BasePaginationQueryDto --max-results 20` | Found many extending query DTO contracts and declaration metadata. |

## Residual Gaps

- Resolved call ratio is still low on large apps (`~0.17-0.21`). Most unresolved calls are framework/library/fluent APIs (`this.logger`, `queryRunner`, `useState`, `Date`, `String`, `Math`, query builders). This is acceptable for v1 proof packets but should become a diagnostic category.
- `trace-scenario` currently follows resolved internal calls only. This keeps answers compact, but external/framework calls are omitted rather than summarized.
- Data-flow is still lightweight: aliases and local destructuring are covered, but full interprocedural value propagation is not.

