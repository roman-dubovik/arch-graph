# Architectural Policies & Blueprints (The "Style Guardian")

Status: Design Phase
Target: Make LLMs write code that perfectly matches local conventions without manual prompting.
Reference Complexity: `beribuy-2.0` (Multi-package NestJS + React E-commerce monorepo).

## Core Problem
LLMs write technically correct code that is architecturally wrong for *your* project. They place files in the wrong directories, miss custom decorators (e.g., specific FK macros), and violate layer boundaries (e.g., Controllers talking directly to DBs). 

To fix this, `arch-graph` will extract and enforce **Project Policies**.
## 1. Features & Implementation Strategy (TDD)

### A. Gold Standard & Synthesized Blueprints
**Goal:** Provide the LLM with the best existing patterns.
**Mechanic:** 
- *Selection:* Rank symbols by "quality" (JSDoc, standard decorators).
- *Synthesis (The "Composite" Blueprint):* If no single file is perfect, the tool synthesizes a summary of patterns. Instead of just returning code, it returns a "Pattern Summary":
    - "Standard DTO Pattern: Extends `BaseDto`, uses `@ApiProperty`, fields are `readonly`."
**TDD Approach:**
1. *Write Test:* Fixture where `ServiceA` has docs but no logger, and `ServiceB` has a logger but no docs.
2. *Expectation:* `getBlueprint('service')` returns a synthesized description and the best available code snippet.

### E. Integration Surface (CLI, MCP, Skill)
To make this useful, the policies must be accessible to the agent at every step:
- **CLI:** `arch-graph code-intel check-style <file>` - useful for CI/CD gates.
- **MCP Tools:** 
    - `get_project_policies()`: Returns a list of inferred and explicit rules.
    - `get_blueprint(kind)`: Returns the gold standard/synthesized pattern.
    - `suggest_placement(name, kind)`: Returns the target path.
- **Claude Skill:** Update `SKILL.md` to instruct the agent to *always* call `get_project_policies` before starting a new feature.

## 2. Prerequisites (What must be done BEFORE)

This functionality is a "Layer 2" over the code-intel fact set. It cannot be built in isolation.
1. **Symbol Indexing (Code-Intel Phase 1):** We must have a reliable `symbols.jsonl` with full decorator and JSDoc metadata. Without this, we have no data to mine for policies.
2. **Directory Clustering Logic:** We need the basic `code-intel build` to correctly record absolute and relative paths for all symbols.
3. **Shared Extractor (`shared.ts`):** The unified JSDoc/Comment extractor must be functional to feed the "Quality Ranker".

## 3. Walkthrough on `beribuy-2.0` Complexity...
**Mechanic:** 
- *Explicit:* Read from `arch-graph.config.ts` (e.g., `policies: { forbidLocalInterfaces: true }`).
- *Inferred:* Scan the AST. If 99% of `TypeORM` `@ManyToOne` decorators are accompanied by a custom `@DbForeignKey` decorator, surface this as a rule.
**TDD Approach:**
1. *Write Test:* Fixture with 10 Entities. 9 use `@CustomRelation` alongside `@ManyToOne`. 1 does not.
2. *Expectation:* The `inferPolicies()` function returns an array containing: `"Warning: 90% of @ManyToOne fields also use @CustomRelation."`
3. *Implementation:* Add a frequency counter for decorator pairings in `extractor.ts`.

### C. Placement Engine
**Goal:** Stop LLMs from guessing directory structures.
**Mechanic:** Analyze the path strings of existing symbols. If the LLM wants to create an `AuthService`, the engine looks at other `*Service` nodes and their domains.
**TDD Approach:**
1. *Write Test:* Fixture simulating `beribuy-2.0` structure (`apps/api/src/modules/orders/services/`, `apps/api/src/modules/users/services/`).
2. *Expectation:* `suggestPlacement({ name: 'PaymentService', domain: 'payments' })` MUST return `apps/api/src/modules/payments/services/`.
3. *Implementation:* Build a clustering algorithm over `node.path` filtered by `kind`.

### D. Dependency Guardrails
**Goal:** Prevent layered architecture violations.
**Mechanic:** Expose an MCP tool `validate_architecture_proposal(sourceType: 'Controller', targetType: 'Repository')`.
**TDD Approach:**
1. *Write Test:* Define a strict layer config.
2. *Expectation:* Calling the tool returns `Violation: Controllers must not depend on Repositories directly. Route through a Service.`
3. *Implementation:* Query the structural `graph.json` to prove that 0 edges currently exist between Controllers and Repositories, enforcing it as a hard rule.

## 2. Walkthrough on `beribuy-2.0` Complexity

Imagine an LLM agent is tasked with: *"Add a new Promocode feature to Beribuy."*

**Without Policies (Current State):**
1. LLM creates `src/PromocodeService.ts` (Wrong path).
2. It uses raw TypeORM `@ManyToOne` for the User link (Misses custom DB macros).
3. It creates an interface `IPromocode` inside the service file (Violates global types rule).

**With Policies (New Flow):**
1. **Agent:** `get_blueprint("service")`
   - *arch-graph:* Returns `DiscountService.ts` (The gold standard). LLM sees the structure.
2. **Agent:** `suggest_placement("PromocodeService", "promocodes")`
   - *arch-graph:* `apps/api/src/modules/promocodes/services/`
3. **Agent (while planning DB):** Reads active policies from config/inference.
   - *arch-graph:* "Policy: Always use `@BeribuyRelation` with `@ManyToOne`." "Policy: No local interfaces, put them in `libs/types/`."
4. **Result:** The LLM writes code that perfectly mimics a senior Beribuy developer on the very first try.

## 3. Next Steps
1. Add `policies` configuration block to `arch-graph.config.ts` schema.
2. Build the `QualityRanker` for Blueprints.
3. Build the `DecoratorFrequencyAnalyzer` for inferred rules.
4. Expose as new MCP tools alongside `code-intel`.