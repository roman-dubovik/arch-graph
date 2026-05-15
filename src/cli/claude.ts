// CLAUDE.md integration: install / uninstall a delimited section that points
// the agent at arch-graph-out/graph.json and the optional `arch-graph mcp` server.
//
// Idempotent: re-running `install` replaces the existing block between markers.
// `uninstall` strips the block, leaving the rest of CLAUDE.md untouched.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARK_START = '<!-- arch-graph:start -->';
const MARK_END = '<!-- arch-graph:end -->';

// Resolve <package-root>/claude-md.template.md — works whether invoked via tsx
// from src/cli/, compiled from dist/cli/, or symlinked through bin/arch-graph.
function templatePath(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/cli/claude.ts → ../../claude-md.template.md
    // dist/cli/claude.js → ../../claude-md.template.md
    return resolve(here, '..', '..', 'claude-md.template.md');
}

async function loadTemplate(): Promise<string> {
    const p = templatePath();
    if (!existsSync(p)) {
        // Fallback inline template — keeps install working even if the package
        // tree was relocated without copying the template file along.
        return DEFAULT_TEMPLATE;
    }
    return readFile(p, 'utf8');
}

interface ClaudeArgs {
    target: string; // path to CLAUDE.md
    installSkill: boolean; // also drop ~/.claude/skills/arch-graph/SKILL.md
}

export function parseClaudeArgs(argv: string[]): { sub: string; args: ClaudeArgs } {
    const [sub, ...rest] = argv;
    let target = './CLAUDE.md';
    let installSkill = false;
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === '--target' && rest[i + 1]) {
            target = rest[++i]!;
        } else if (a.startsWith('--target=')) {
            target = a.slice('--target='.length);
        } else if (a === '--skill') {
            installSkill = true;
        }
    }
    return { sub: sub ?? '', args: { target: resolve(target), installSkill } };
}

export async function claudeInstall(args: ClaudeArgs): Promise<void> {
    const tmpl = await loadTemplate();
    const block = `${MARK_START}\n${tmpl.trimEnd()}\n${MARK_END}\n`;

    let body = '';
    if (existsSync(args.target)) {
        body = await readFile(args.target, 'utf8');
    } else {
        // Minimal seed so the marker block has somewhere sensible to live.
        body = `# Project memory\n\nThis file holds standing instructions for Claude Code sessions on this project.\n\n`;
        await mkdir(dirname(args.target), { recursive: true });
    }

    // We can't use reference equality (`replaced === body`) to detect "no
    // marker found" — V8 may return the same string ref when the replacement
    // produces an identical result. Check explicitly instead.
    const hasMarkers = body.includes(MARK_START) && body.includes(MARK_END);
    const next = hasMarkers
        ? replaceMarkedSection(body, MARK_START, MARK_END, block)
        : appendBlock(body, block);

    await writeFile(args.target, next, 'utf8');
    process.stdout.write(`✓ wrote arch-graph section to ${args.target}\n`);

    if (args.installSkill) {
        const { installSkill } = await import('./skill.js');
        await installSkill();
    }
}

export async function claudeUninstall(args: ClaudeArgs): Promise<void> {
    if (!existsSync(args.target)) {
        process.stdout.write(`(${args.target} does not exist — nothing to remove)\n`);
        return;
    }
    const body = await readFile(args.target, 'utf8');
    const stripped = stripMarkedSection(body, MARK_START, MARK_END);
    if (stripped === body) {
        process.stdout.write(`(no arch-graph section found in ${args.target})\n`);
        return;
    }
    await writeFile(args.target, stripped, 'utf8');
    process.stdout.write(`✓ removed arch-graph section from ${args.target}\n`);
}

// ---------- marker helpers (exported for reuse by hooks.ts) ----------

/**
 * Replace the content (and surrounding markers) of an existing marked block.
 * Returns the original body unchanged if no block is found.
 */
export function replaceMarkedSection(
    body: string,
    start: string,
    end: string,
    replacement: string,
): string {
    const s = body.indexOf(start);
    if (s < 0) return body;
    const e = body.indexOf(end, s);
    if (e < 0) return body;
    const tail = e + end.length;
    // Swallow one trailing newline if present so we don't accumulate blank lines.
    const eatNl = body[tail] === '\n' ? 1 : 0;
    return body.slice(0, s) + replacement + body.slice(tail + eatNl);
}

/** Strip a marked block entirely, including surrounding whitespace noise. */
export function stripMarkedSection(body: string, start: string, end: string): string {
    const replaced = replaceMarkedSection(body, start, end, '');
    // Collapse any 3+ consecutive newlines that the strip might leave behind.
    return replaced.replace(/\n{3,}/g, '\n\n');
}

/** Append a block to body, separated by a blank line. Adds trailing newline. */
export function appendBlock(body: string, block: string): string {
    const trimmed = body.replace(/\s+$/, '');
    if (trimmed.length === 0) return block;
    return `${trimmed}\n\n${block}`;
}

// Last-resort fallback when claude-md.template.md is missing from the package.
const DEFAULT_TEMPLATE = `## arch-graph

This project uses **arch-graph** — a static analysis tool that extracts the NestJS architecture into \`arch-graph-out/graph.json\`.

**Before answering any architecture question** (e.g. "who publishes on this NATS subject?", "what depends on this table?", "how does service A reach service B?"), check:

1. \`arch-graph-out/graph.json\` — the structural graph (nodes: services, NATS subjects, BullMQ queues, TypeORM entities, NestJS modules, HTTP endpoints; edges: publishes, subscribes, depends-on, imports-module, http-call, ts-import).
2. \`arch-graph-out/diagnostics.json\` — unresolved / dynamic call-sites the extractor couldn't pin down.

If \`arch-graph mcp\` is available, prefer the MCP server (richer query API: shortest paths, neighbors, full-text node search). Otherwise read \`graph.json\` directly.

**After touching any \`.ts\` file**, re-run \`arch-graph build\` so the graph stays fresh (or rely on the post-commit hook installed via \`arch-graph hook install\`).

**What the graph contains** (per extractor):
- NATS publish / subscribe sites with resolved subject patterns
- BullMQ producers / consumers / queue registrations
- TypeORM \`@InjectRepository\` → \`@Entity\` resolution
- NestJS \`@Module\` imports / providers / exports / controllers
- HTTP \`HttpService\` / \`axios\` / \`fetch\` call-sites with URL classification (internal service vs external host vs env-ref)
- TypeScript file → file static imports (resolved through \`tsconfig.paths\` aliases)

**Honesty rules**:
- Edges are *extracted*, not runtime-observed. A subscriber registered with a dynamic subject is recorded as \`unresolved\` in \`diagnostics.json\`, not invented.
- If \`graph.json\` is older than the newest \`.ts\` file in the repo, treat it as stale and re-run \`arch-graph build\` before answering.
`;
