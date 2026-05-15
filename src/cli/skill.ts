// Writes ~/.claude/skills/arch-graph/SKILL.md.
//
// The template lives at <package-root>/skill/SKILL.md. We just copy it —
// the skill is text, no interpolation needed. If the source template is
// missing (e.g. the package layout was changed), we fall back to a
// hard-coded body so the install never silently produces an empty file.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function sourcePath(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', '..', 'skill', 'SKILL.md');
}

export function skillDestPath(): string {
    return resolve(homedir(), '.claude', 'skills', 'arch-graph', 'SKILL.md');
}

export async function installSkill(): Promise<void> {
    const src = sourcePath();
    const dest = skillDestPath();
    await mkdir(dirname(dest), { recursive: true });

    let body: string;
    let usedFallback = false;
    if (existsSync(src)) {
        body = await readFile(src, 'utf8');
    } else {
        body = FALLBACK_SKILL;
        usedFallback = true;
    }
    await writeFile(dest, body, 'utf8');
    if (usedFallback) {
        // Don't fail silently: the user-facing skill is meaningfully smaller
        // than the canonical one (jq recipes, MCP guidance, freshness rules
        // are all in the full template). Tell them so they can investigate.
        process.stderr.write(
            `⚠ skill template not found at ${src}; wrote built-in fallback (no jq recipes / MCP guidance).\n` +
                `  Re-clone or re-install arch-graph if you want the full SKILL.md.\n`,
        );
    }
    process.stdout.write(`✓ skill installed: ${dest}\n`);
}

const FALLBACK_SKILL = `---
name: arch-graph
description: "NestJS-monorepo static architecture graph — query who publishes on NATS subjects, what depends on a table, paths between services. Use when user asks any architecture question about a NestJS codebase."
trigger: /arch-graph
---

# /arch-graph

Static architecture graph for NestJS monorepos. See \`arch-graph-out/graph.json\`. If missing or stale, run \`arch-graph build\`.
`;
