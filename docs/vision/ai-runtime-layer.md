# Vision: arch-graph AI Runtime Layer

Transforming `arch-graph` from a set of tools into a "Self-Injected AI Operating System" for your repository.

## 1. Core Philosophy: Active Context vs. Passive Instruction
Stop bloating `CLAUDE.md`, `.cursorrules`, or system prompts with static instructions. Instead, use **Active Injection**:
- **Zero-Friction Entry:** Agents "wake up" with a project map in their context via auto-run hooks.
- **JIT Guidance:** Tools tell the agent what to do next in their response payload.
- **Surgical Precision:** Move from "reading files" to "querying facts" and reading specific line ranges.

## 2. Multi-Agent Ecosystem Support
The `arch-graph setup-ai` command will allow users to select their preferred environments, automatically installing the correct "bridging" files:

| Environment | Mechanism | File Target |
| :--- | :--- | :--- |
| **Claude Code** | Session Hooks & Skills | `.claude/hooks/SessionStart`, `.claude/skills/` |
| **Cursor / Windsurf** | Project Rules | `.cursorrules` / `.windsurfrules` |
| **Codex / Gemini** | Global Instruction | `CLAUDE.md` (optimized pointer) |
| **Generic IDEs** | Context Sidecar | `MEMORY.md` or `.ai-context.json` |

## 3. The 3-Layer Orientation Model

### Level 0: The Empire Map (`get_orientation`)
- **Tokens:** ~300.
- **Goal:** High-level topology (apps/libs), index health, and active project policies.
- **Trigger:** Auto-run at session start.

### Level 1: Surgical Discovery (`get_file_outline`)
- **Tokens:** ~200 per module.
- **Goal:** Map a specific file/module. Returns exact `line` to `endLine` ranges for every symbol.
- **Outcome:** Agent knows exactly where to look without reading code.

### Level 2: Controlled Evolution (`validate_proposal`)
- **Tokens:** ~400.
- **Goal:** Pre-flight check for architectural violations.
- **Outcome:** Blocks bad code (layer violations, cross-app leaks) before it is written.

## 4. Implementation Strategy (TDD)

### Step 1: Integrated Installation (`install.sh` & `arch-graph init`)
- **Global Level:** The global install script (`scripts/install.sh`) will ask for preferred global agent settings (e.g., global `CLAUDE.md` or `~/.cursorrules`).
- **Project Level:** Running `arch-graph init` will detect global settings or prompt for project-specific agent configurations, scaffolding the necessary `.claude/hooks` or local `.cursorrules`.
- A dedicated `setup-ai` command is only needed to add/modify agent configs later.

### Step 2: JIT Instruction Engine (Concise Response Enrichment)
- **Constraint:** Hints MUST be extremely concise (1-2 sentences max) to avoid context bloat.
- **Feature:** Every MCP response includes an `agentHint` field to guide the LLM's next action (e.g., `hint: "Use get_file_outline to find line ranges before reading files."`).

### Step 3: Integrity & Self-Healing
- **Test:** Break the index and call a tool. Verify it returns a "Repair needed" instruction.
- **Feature:** Tools automatically check index health and provide CLI fix commands in the error payload.

## 5. Risk & Benefit Assessment

- **Benefit:** **Massive Token Savings.** By removing static instructions and full-file reads, we save up to 90% of context costs on large repos like `app-alpha`.
- **Benefit:** **Architectural Consistency.** Guardrails and Policies are enforced at the tool level, making them unavoidable for the AI.
- **Risk:** **Fragmented IDE Support.** 
    - *Mitigation:* The "Pointer Strategy" in `CLAUDE.md` acts as a universal fallback for all agents.
- **Risk:** **Tool Chain Overhead.**
    - *Mitigation:* Incremental builds keep indexing under 2 seconds, making pre-commit/start hooks unnoticeable.
