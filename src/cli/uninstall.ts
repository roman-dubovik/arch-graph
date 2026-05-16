// Interactive teardown wizard for `arch-graph uninstall`.
//
// Symmetric counterpart to `arch-graph init` — walks the user through removing
// every artefact arch-graph creates, in the right order (project → MCP → global)
// so the CLI is still on PATH when project-level commands run.
//
// Three scopes:
//   • project — config / out dir / CLAUDE.md section / git hook
//   • mcp     — `arch-graph` entry in ~/.claude.json projects.<cwd>.mcpServers
//   • global  — ~/.arch-graph, ~/.local/bin/arch-graph, ~/.claude/skills/arch-graph
//
// Modes:
//   • TTY, no flags → interactive wizard
//   • non-TTY, no flags → print inventory + instructions, exit 0 (dry-run)
//   • --project / --mcp / --global / --all → execute the named scope(s) without prompts
//   • --yes → confirms ALL scopes (alias for --all with no prompts)
//
// `--global` triggers `bash <install-dir>/scripts/uninstall.sh --yes` which is
// self-contained (POSIX shell, no node deps) and therefore safe to run even if
// node_modules disappears mid-flight.
//
// MCP detection reads ~/.claude.json directly rather than shelling out to the
// `claude` CLI — keeps the dep boundary clean (some users install arch-graph
// without Claude Code itself).

import { existsSync } from 'node:fs';
import { readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

import { MARK_START as CLAUDE_MARK_START, MARK_END as CLAUDE_MARK_END } from './claude.js';
import {
    MARK_START as HOOK_MARK_START,
    MARK_END as HOOK_MARK_END,
    preCommitHookPath,
    postCommitHookPath,
} from './hooks.js';
import { stripMarkedSection } from './marker-block.js';

// ─── argument parsing ────────────────────────────────────────────────────────

export interface UninstallArgs {
    /** explicit scope selection from flags. Empty → interactive (TTY) or dry-run (non-TTY). */
    scopes: Set<UninstallScope>;
    /** path to the project to clean — defaults to cwd. */
    project: string;
    /** skip the global confirmation prompt (still respects scope selection). */
    yes: boolean;
}

export type UninstallScope = 'project' | 'mcp' | 'global';

export function parseUninstallArgs(argv: string[]): UninstallArgs {
    const scopes = new Set<UninstallScope>();
    let project = '.';
    let yes = false;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === '--project') scopes.add('project');
        else if (a === '--mcp') scopes.add('mcp');
        else if (a === '--global') scopes.add('global');
        else if (a === '--all') {
            scopes.add('project');
            scopes.add('mcp');
            scopes.add('global');
        } else if (a === '--yes' || a === '-y') {
            yes = true;
        } else if (a === '--repo' && argv[i + 1]) {
            project = argv[++i]!;
        } else if (a.startsWith('--repo=')) {
            project = a.slice('--repo='.length);
        }
    }

    return { scopes, project: resolve(project), yes };
}

// ─── inventory types ─────────────────────────────────────────────────────────

export interface ProjectInventory {
    config: string | null;
    outDir: { path: string; sizeBytes: number } | null;
    claudeMdWithBlock: string | null;
    hookWithBlock: { path: string; mode: 'pre-commit' | 'post-commit' } | null;
}

export interface GlobalInventory {
    installDir: { path: string; sizeBytes: number } | null;
    symlinkPath: string | null;
    /** True only if the symlink actually points into installDir — we won't
     * delete a user-managed binary that happens to share the path. */
    symlinkIsOurs: boolean;
    symlinkTarget: string | null;
    skillDir: string | null;
}

export interface McpInventory {
    /** Path to ~/.claude.json if it exists and contains arch-graph in any project scope. */
    configPath: string | null;
    /** Which project keys hold an arch-graph entry. Empty if none. */
    projectsWithEntry: string[];
}

export interface Inventory {
    project: ProjectInventory;
    global: GlobalInventory;
    mcp: McpInventory;
}

// ─── inventory ────────────────────────────────────────────────────────────────

export async function inventoryProject(repo: string): Promise<ProjectInventory> {
    const inv: ProjectInventory = {
        config: null,
        outDir: null,
        claudeMdWithBlock: null,
        hookWithBlock: null,
    };

    const cfg = resolve(repo, 'arch-graph.config.ts');
    if (existsSync(cfg)) inv.config = cfg;

    const out = resolve(repo, 'arch-graph-out');
    if (existsSync(out)) {
        const size = await dirSize(out);
        inv.outDir = { path: out, sizeBytes: size };
    }

    const cmd = resolve(repo, 'CLAUDE.md');
    if (existsSync(cmd)) {
        const body = await readFile(cmd, 'utf8');
        if (body.includes(CLAUDE_MARK_START)) inv.claudeMdWithBlock = cmd;
    }

    // Hook detection — prefer pre-commit if both somehow have a block (status
    // reports separately, but uninstall sweeps both).
    for (const mode of ['pre-commit', 'post-commit'] as const) {
        const p = mode === 'pre-commit' ? preCommitHookPath(repo) : postCommitHookPath(repo);
        if (!existsSync(p)) continue;
        const body = await readFile(p, 'utf8');
        if (body.includes(HOOK_MARK_START)) {
            inv.hookWithBlock = { path: p, mode };
            break;
        }
    }

    return inv;
}

export async function inventoryGlobal(installDir: string, binDir: string): Promise<GlobalInventory> {
    const inv: GlobalInventory = {
        installDir: null,
        symlinkPath: null,
        symlinkIsOurs: false,
        symlinkTarget: null,
        skillDir: null,
    };

    if (existsSync(installDir)) {
        const size = await dirSize(installDir);
        inv.installDir = { path: installDir, sizeBytes: size };
    }

    const link = resolve(binDir, 'arch-graph');
    if (existsSync(link)) {
        inv.symlinkPath = link;
        try {
            const target = await readSymlink(link);
            inv.symlinkTarget = target;
            inv.symlinkIsOurs = target !== null && target.startsWith(installDir + '/');
        } catch {
            // Not a symlink — leave symlinkIsOurs=false so we don't auto-delete.
        }
    }

    const skill = resolve(homedir(), '.claude', 'skills', 'arch-graph');
    if (existsSync(skill)) inv.skillDir = skill;

    return inv;
}

export async function inventoryMcp(): Promise<McpInventory> {
    const inv: McpInventory = { configPath: null, projectsWithEntry: [] };
    const cfg = resolve(homedir(), '.claude.json');
    if (!existsSync(cfg)) return inv;

    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(cfg, 'utf8'));
    } catch {
        // Don't fail the wizard on a corrupt config — just report "none found".
        return inv;
    }

    if (typeof parsed !== 'object' || parsed === null) return inv;
    const obj = parsed as Record<string, unknown>;
    const projects = obj.projects;
    if (typeof projects !== 'object' || projects === null) return inv;

    inv.configPath = cfg;
    for (const [key, val] of Object.entries(projects as Record<string, unknown>)) {
        if (typeof val !== 'object' || val === null) continue;
        const mcp = (val as Record<string, unknown>).mcpServers;
        if (typeof mcp !== 'object' || mcp === null) continue;
        if ('arch-graph' in mcp) inv.projectsWithEntry.push(key);
    }

    return inv;
}

// ─── inventory rendering ──────────────────────────────────────────────────────

export function renderInventory(inv: Inventory): string {
    const lines: string[] = [];

    lines.push('Project artefacts in ' + (inv.project.config ? dirname(inv.project.config) : '(cwd)') + ':');
    if (!hasAnyProject(inv.project)) {
        lines.push('  – none found');
    } else {
        if (inv.project.config)
            lines.push(`  ✓ ${inv.project.config}`);
        if (inv.project.outDir)
            lines.push(`  ✓ ${inv.project.outDir.path}  (${humanSize(inv.project.outDir.sizeBytes)})`);
        if (inv.project.claudeMdWithBlock)
            lines.push(`  ✓ ${inv.project.claudeMdWithBlock}  (arch-graph section)`);
        if (inv.project.hookWithBlock)
            lines.push(`  ✓ ${inv.project.hookWithBlock.path}  (${inv.project.hookWithBlock.mode} block)`);
    }

    lines.push('');
    lines.push('MCP registrations in ~/.claude.json:');
    if (inv.mcp.projectsWithEntry.length === 0) {
        lines.push('  – none found');
    } else {
        for (const proj of inv.mcp.projectsWithEntry) {
            lines.push(`  ✓ ${proj}`);
        }
    }

    lines.push('');
    lines.push('Global install:');
    if (!hasAnyGlobal(inv.global)) {
        lines.push('  – none found');
    } else {
        if (inv.global.installDir)
            lines.push(`  ✓ ${inv.global.installDir.path}  (${humanSize(inv.global.installDir.sizeBytes)})`);
        if (inv.global.symlinkPath) {
            const marker = inv.global.symlinkIsOurs ? '' : '  ⚠ external target, will be left alone';
            lines.push(`  ✓ ${inv.global.symlinkPath} → ${inv.global.symlinkTarget ?? '(broken)'}${marker}`);
        }
        if (inv.global.skillDir)
            lines.push(`  ✓ ${inv.global.skillDir}  (global Claude Code skill)`);
    }

    return lines.join('\n');
}

function hasAnyProject(p: ProjectInventory): boolean {
    return !!(p.config || p.outDir || p.claudeMdWithBlock || p.hookWithBlock);
}

function hasAnyGlobal(g: GlobalInventory): boolean {
    return !!(g.installDir || g.symlinkPath || g.skillDir);
}

// ─── actions ─────────────────────────────────────────────────────────────────

export async function removeProjectArtefacts(inv: ProjectInventory): Promise<void> {
    if (inv.claudeMdWithBlock) {
        const body = await readFile(inv.claudeMdWithBlock, 'utf8');
        const stripped = stripMarkedSection(body, CLAUDE_MARK_START, CLAUDE_MARK_END);
        await writeFile(inv.claudeMdWithBlock, stripped, 'utf8');
        output.write(`✓ removed arch-graph section from ${inv.claudeMdWithBlock}\n`);
    }

    if (inv.hookWithBlock) {
        const { path } = inv.hookWithBlock;
        const body = await readFile(path, 'utf8');
        const stripped = stripMarkedSection(body, HOOK_MARK_START, HOOK_MARK_END);
        const meaningful = stripped
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith('#'))
            .join('');
        if (meaningful.length === 0) {
            await unlink(path);
            output.write(`✓ removed empty hook ${path}\n`);
        } else {
            await writeFile(path, stripped, 'utf8');
            output.write(`✓ removed arch-graph block from ${path}\n`);
        }
    }

    if (inv.config) {
        await rm(inv.config, { force: true });
        output.write(`✓ removed ${inv.config}\n`);
    }

    if (inv.outDir) {
        await rm(inv.outDir.path, { recursive: true, force: true });
        output.write(`✓ removed ${inv.outDir.path}\n`);
    }
}

export async function removeMcpRegistrations(inv: McpInventory): Promise<void> {
    if (!inv.configPath || inv.projectsWithEntry.length === 0) return;

    const body = await readFile(inv.configPath, 'utf8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        output.write(`⚠ ~/.claude.json is not valid JSON — leaving it alone\n`);
        return;
    }
    const root = parsed as Record<string, unknown>;
    const projects = root.projects as Record<string, Record<string, unknown>> | undefined;
    if (!projects) return;

    for (const key of inv.projectsWithEntry) {
        const proj = projects[key];
        if (!proj) continue;
        const mcp = proj.mcpServers as Record<string, unknown> | undefined;
        if (!mcp) continue;
        if ('arch-graph' in mcp) {
            delete mcp['arch-graph'];
            output.write(`✓ removed MCP entry from ~/.claude.json projects.${key}\n`);
        }
    }

    await writeFile(inv.configPath, JSON.stringify(root, null, 2) + '\n', 'utf8');
}

export function removeGlobalInstall(installDir: string): { exitCode: number; stdout: string; stderr: string } {
    const script = resolve(installDir, 'scripts', 'uninstall.sh');
    if (!existsSync(script)) {
        // Older install without uninstall.sh — fall back to direct rm. This
        // shouldn't happen for fresh installs but keeps the wizard usable on
        // legacy layouts.
        const linkAndSkill: string[] = [];
        const skill = resolve(homedir(), '.claude', 'skills', 'arch-graph');
        if (existsSync(skill)) linkAndSkill.push(skill);
        const r = spawnSync('rm', ['-rf', installDir, ...linkAndSkill], { encoding: 'utf8' });
        return {
            exitCode: r.status ?? 1,
            stdout: r.stdout,
            stderr: r.stderr,
        };
    }
    const r = spawnSync('bash', [script, '--yes'], { encoding: 'utf8' });
    return {
        exitCode: r.status ?? 1,
        stdout: r.stdout,
        stderr: r.stderr,
    };
}

// ─── default install dir resolution ──────────────────────────────────────────

/**
 * Resolve <package-root> from this module's location. Mirrors the pattern in
 * claude.ts and skill.ts so the CLI works whether invoked via tsx from src/cli/,
 * compiled from dist/cli/, or symlinked through bin/arch-graph.
 */
export function defaultInstallDir(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/cli/uninstall.ts → ../../
    // dist/cli/uninstall.js → ../../
    return resolve(here, '..', '..');
}

export function defaultBinDir(): string {
    return process.env.ARCH_GRAPH_BIN_DIR || resolve(homedir(), '.local', 'bin');
}

// ─── filesystem helpers ──────────────────────────────────────────────────────

async function readSymlink(path: string): Promise<string | null> {
    const { readlink } = await import('node:fs/promises');
    try {
        return await readlink(path);
    } catch {
        return null;
    }
}

async function dirSize(path: string): Promise<number> {
    // `du -sk` is faster than walking with fs.stat() for big install dirs
    // (which can include node_modules). Falls back to stat() on platforms
    // where du isn't available.
    const r = spawnSync('du', ['-sk', path], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
        const kb = parseInt(r.stdout.split(/\s+/)[0] ?? '0', 10);
        if (!isNaN(kb)) return kb * 1024;
    }
    try {
        const s = await stat(path);
        return s.size;
    } catch {
        return 0;
    }
}

function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// ─── readline helpers ────────────────────────────────────────────────────────

type Rl = Awaited<ReturnType<typeof createInterface>>;

async function askYesNo(rl: Rl, prompt: string, defaultYes: boolean): Promise<boolean> {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const answer = await rl.question(`${prompt} [${hint}]: `);
    const trimmed = answer.trim().toLowerCase();
    if (!trimmed) return defaultYes;
    return trimmed === 'y' || trimmed === 'yes';
}

// ─── main entry point ────────────────────────────────────────────────────────

export async function runUninstallWizard(args: UninstallArgs): Promise<void> {
    const installDir = process.env.ARCH_GRAPH_HOME || defaultInstallDir();
    const binDir = defaultBinDir();

    const inv: Inventory = {
        project: await inventoryProject(args.project),
        global: await inventoryGlobal(installDir, binDir),
        mcp: await inventoryMcp(),
    };

    output.write(renderInventory(inv) + '\n\n');

    // ── Determine which scopes to run ────────────────────────────────────────
    let scopes: Set<UninstallScope>;
    let interactive = false;

    if (args.scopes.size > 0) {
        scopes = args.scopes;
    } else if (args.yes) {
        // --yes without explicit scopes ⇒ everything that's present
        scopes = new Set();
        if (hasAnyProject(inv.project)) scopes.add('project');
        if (inv.mcp.projectsWithEntry.length > 0) scopes.add('mcp');
        if (hasAnyGlobal(inv.global)) scopes.add('global');
    } else if (!process.stdin.isTTY) {
        // Non-TTY, no flags ⇒ dry-run mode
        output.write(
            'Dry-run only. Re-run with one of:\n' +
            '  --project       remove project artefacts above\n' +
            '  --mcp           remove MCP registrations\n' +
            '  --global        remove global install\n' +
            '  --all           remove everything (or --yes shorthand)\n',
        );
        return;
    } else {
        // Interactive TTY wizard
        interactive = true;
        scopes = await askForScopes(inv);
    }

    if (scopes.size === 0) {
        output.write('Nothing selected. Exiting.\n');
        return;
    }

    if (interactive) output.write('\nProceeding...\n');

    // ── Execute in safe order: project → mcp → global ────────────────────────
    if (scopes.has('project') && hasAnyProject(inv.project)) {
        await removeProjectArtefacts(inv.project);
    } else if (scopes.has('project')) {
        output.write('(no project artefacts to remove)\n');
    }

    if (scopes.has('mcp') && inv.mcp.projectsWithEntry.length > 0) {
        await removeMcpRegistrations(inv.mcp);
    } else if (scopes.has('mcp')) {
        output.write('(no MCP registrations to remove)\n');
    }

    if (scopes.has('global') && hasAnyGlobal(inv.global)) {
        const result = removeGlobalInstall(installDir);
        if (result.stdout) output.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.exitCode !== 0) {
            process.stderr.write(`⚠ global uninstall exited with code ${result.exitCode}\n`);
        }
    } else if (scopes.has('global')) {
        output.write('(no global install to remove)\n');
    }

    output.write('\n✓ done.\n');
}

async function askForScopes(inv: Inventory): Promise<Set<UninstallScope>> {
    const rl = createInterface({ input, output, terminal: true });
    const scopes = new Set<UninstallScope>();

    try {
        if (hasAnyProject(inv.project)) {
            if (await askYesNo(rl, '? Remove project artefacts?', true)) scopes.add('project');
        }
        if (inv.mcp.projectsWithEntry.length > 0) {
            if (await askYesNo(rl, '? Remove MCP registrations?', true)) scopes.add('mcp');
        }
        if (hasAnyGlobal(inv.global)) {
            output.write('\n⚠  Global removal deletes the CLI itself. After this,\n');
            output.write('   `arch-graph` will be gone from PATH. Per-project files in\n');
            output.write('   OTHER repos must be cleaned manually.\n\n');
            if (await askYesNo(rl, '? Remove global install?', false)) scopes.add('global');
        }
    } finally {
        rl.close();
    }

    return scopes;
}
