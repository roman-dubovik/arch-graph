# arch-graph vs. LSP: Why Architecture Intelligence Matters

Modern AI coding tools often leverage **LSP (Language Server Protocol)** to provide context to LLMs. While powerful for local navigation, LSP has fundamental limits that `arch-graph` is designed to overcome.

## Summary: Macro vs. Micro

| Feature | LSP (Microscope) | arch-graph (Radar) |
| :--- | :--- | :--- |
| **Primary Goal** | Syntax & Type correctness in a file/package. | **Architectural intent** & System-wide ripple effects. |
| **Deep Semantic Awareness** | Sees "Method Call". | Sees "NATS Message Publish" or "DB Persistence Sink". |
| **Cross-Boundary Tracing** | Limited to language/workspace boundaries. | Bridges **Backend (NestJS) ➔ OpenAPI ➔ Frontend (React)**. |
| **Token Efficiency** | Raw reference lists (often huge). | **Deterministic Proof Packets** (compressed summaries). |
| **Performance** | JIT parsing (can lag on massive repos). | **Pre-computed Sidecars (JSONL)** (sub-millisecond queries). |

## Key Differentiators

### 1. High-Level Semantic Extraction
LSP understands that a variable `users` is an array. `arch-graph` understands that `UsersService.create` is a **Critical Write Path** that interacts with a specific database table and is triggered by a specific HTTP POST route. We promote "code facts" to "architecture facts."

### 2. Context Summarization & Surgical Reads
When an LLM asks "Who uses this DTO?", an LSP might return 500 lines of code across 50 files. `arch-graph` performs deterministic analysis to return a **Proof Packet**: "This DTO defines the contract for the `/payments` endpoint and is consumed by 3 frontend components. Risk: HIGH." 

Furthermore, with **Surgical Read** support, `arch-graph` provides exact line ranges (`line` to `endLine`) for every symbol.
- **Before:** LLM reads a 1000-line file to find 1 method (10,000 tokens).
- **After:** LLM calls `get_file_outline`, sees the 20-line range for the method, and reads only that snippet (300 tokens).
This 30x reduction in context usage prevents LLM "context drowning" and drastically reduces costs.

### 3. Asynchronous & Multi-Repo Awareness
In modern microservices, logic often jumps between services via NATS, RabbitMQ, or BullMQ. LSP stops at the `client.emit()` call. `arch-graph` traces the string-based pattern matching to find the actual handler in a completely different service, providing the LLM with the **full execution story**.

### 4. Zero-Lag LLM Experience
By moving the heavy AST heavy lifting to a `pre-commit` indexer, `arch-graph` provides the LLM with instant answers. The agent doesn't wait for a language server to "index" or "warm up"; it queries a highly optimized flat-file database of architectural facts.

## Conclusion
LSP is for **writing lines of code**. `arch-graph` is for **designing and evolving systems**. By using both, an LLM agent transforms from a syntax-assistant into a true technical partner.
