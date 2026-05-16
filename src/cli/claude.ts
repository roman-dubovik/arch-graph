// CLAUDE.md integration: install / uninstall a delimited section that points
// the agent at arch-graph-out/graph.json and the optional `arch-graph mcp` server.
//
// Idempotent: re-running `install` replaces the existing block between markers.
// `uninstall` strips the block, leaving the rest of CLAUDE.md untouched.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendBlock, replaceMarkedSection, stripMarkedSection } from './marker-block.js';
import { registerProject } from './project-registry.js';

export const MARK_START = '<!-- arch-graph:start -->';
export const MARK_END = '<!-- arch-graph:end -->';

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
        // tree was relocated without copying the template file along. We warn
        // explicitly because the canonical template is significantly richer
        // (edge-kind tables, jq recipes, honesty rules) than this fallback.
        process.stderr.write(
            `⚠ claude-md template not found at ${p}; using built-in fallback (no jq recipes / edge-kind table).\n` +
                `  Re-clone or re-install arch-graph if you want the full block.\n`,
        );
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
    await registerProject(dirname(args.target));
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
    if (!body.includes(MARK_START)) {
        // Reference-equality on the strip result is unreliable (V8 may dedupe
        // identical strings), so check the marker explicitly instead.
        process.stdout.write(`(no arch-graph section found in ${args.target})\n`);
        return;
    }
    const stripped = stripMarkedSection(body, MARK_START, MARK_END);
    await writeFile(args.target, stripped, 'utf8');
    process.stdout.write(`✓ removed arch-graph section from ${args.target}\n`);
}

// Last-resort fallback when claude-md.template.md is missing from the package.
const DEFAULT_TEMPLATE = `## arch-graph

This project uses **arch-graph** — a static analysis tool that extracts the NestJS architecture into \`arch-graph-out/graph.json\`.

**Before answering any architecture question** (e.g. "who publishes on this NATS subject?", "what depends on this table?", "how does service A reach service B?"), check:

1. \`arch-graph-out/graph.json\` — the structural graph (nodes: services, NATS subjects, BullMQ queues, TypeORM entities, NestJS modules, HTTP endpoints; edges: \`nats-publish\`/\`nats-subscribe\`/\`nats-request\`/\`nats-reply\`, \`queue-produce\`/\`queue-consume\`, \`db-read\`/\`db-write\`/\`db-access\`, \`di-import\`/\`di-provides\`/\`di-exports\`/\`di-controller\`, \`http-call\`/\`http-external\`, \`ts-import\`, \`lib-usage\`).
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
