# Implementation Plan: AI Layer Plugin (`setup-ai`)

Status: Planning
Approach: TDD (Test-Driven Development)
Goal: Unified setup and active context injection for multi-agent ecosystems.

## 1. Step 1: Integrated Setup (`install.sh` & `arch-graph init`)

**Technical Goals:**
- Integrate AI environment selection (Claude, Cursor, Gemini) into the global `scripts/install.sh`.
- Integrate project-level AI scaffolding into `src/cli/init.ts` (respecting global defaults).
- Scaffold `.claude/hooks/SessionStart.sh` and optimize `CLAUDE.md`.
- Keep an optional `arch-graph setup-ai` command for late additions.

**TDD (src/cli/init.test.ts):**
- [ ] *Test 1:* `arch-graph init --agent claude` creates `.claude/hooks/SessionStart.sh` with correct summary commands.
- [ ] *Test 2:* `arch-graph init --agent cursor` creates `.cursorrules` containing surgical read instructions.

## 2. Step 2: Response Enrichment (Concise JIT Context)

**Technical Goals:**
- Add an extremely concise `agentHint` (max 1 sentence) to all `queries.ts` result types to avoid context bloat.

**TDD (src/code-intel/queries.test.ts):**
- [ ] *Test 3:* `getOrientation` result contains a hint pointing to `get_file_outline`.
- [ ] *Test 4:* `resolveSymbol` result contains a concise hint about surgical reads using `line` and `endLine`.

## 3. Step 3: Integrity Self-Healing

**Technical Goals:**
- Extend `self_check` to return CLI commands for fixing issues.
- Tools must call `self_check` internally and prepend warnings to their output.

**TDD (src/code-intel/queries.test.ts):**
- [ ] *Test 6:* If index is stale, any tool call must include a warning: "⚠️ Stale data. Run 'arch-graph build'".

## 4. Final Validation Suite (Test Projects)

After implementation, run the following benchmark on the synthetic reference projects (`app-alpha`, `app-beta`, `monorepo-gamma`):

1. **Setup:** `arch-graph setup-ai --all`
2. **Onboarding:** Call `get_orientation`. Verify it identifies apps/libs correctly.
3. **Surgical Cycle:**
   - Call `suggest_placement` for a new service.
   - Call `get_file_outline` for the suggested directory.
   - Use ranges to read a sibling service.
4. **Guardrail Check:** Propose an illegal import (Controller -> Repository). Verify `validate_proposal` blocks it.

---

## Technical Dependencies
- Requires `src/code-intel/` to be complete (Implemented).
- Requires `src/cli/hooks.ts` refactoring to support agent hooks.
- Requires `src/mcp/server.ts` update to expose enriched payloads.
