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

import { existsSync, readFileSync } from 'node:fs';
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
import { listProjects, unregisterProject } from './project-registry.js';

// ─── argument parsing ────────────────────────────────────────────────────────

export interface UninstallArgs {
    /** explicit scope selection from flags. Empty → interactive (TTY) or dry-run (non-TTY). */
    scopes: Set<UninstallScope>;
    /**
     * Single-project override. When non-null, the wizard treats this path as
     * the ONLY project to consider — registry is ignored. Default (null) means
     * "scan the project registry".
     */
    repoOverride: string | null;
    /** skip the global confirmation prompt (still respects scope selection). */
    yes: boolean;
    /**
     * Explicit acknowledgement that a non-TTY project-scope sweep over MULTIPLE
     * registered projects is intentional. Without this, multi-project sweep
     * from a non-TTY context (CI, `--yes`) is refused with an actionable
     * error — see runUninstallWizard. Has no effect in TTY interactive mode.
     * Optional in the type so old callers don't have to set it explicitly;
     * undefined === false at the wizard.
     */
    allProjects?: boolean;
}

export type UninstallScope = 'project' | 'mcp' | 'global';

export function parseUninstallArgs(argv: string[]): UninstallArgs {
    const scopes = new Set<UninstallScope>();
    let repoOverride: string | null = null;
    let yes = false;
    let allProjects = false;

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
        } else if (a === '--all-projects') {
            allProjects = true;
        } else if (a === '--repo' && argv[i + 1]) {
            repoOverride = argv[++i]!;
        } else if (a.startsWith('--repo=')) {
            repoOverride = a.slice('--repo='.length);
        }
    }

    return { scopes, repoOverride: repoOverride ? resolve(repoOverride) : null, yes, allProjects };
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

export interface ProjectEntry {
    path: string;
    inv: ProjectInventory;
}

export interface Inventory {
    /**
     * One entry per project considered. In single-project mode (--repo X)
     * this is always exactly one item. In registry mode, it's every known
     * project (from `listProjects()`) plus cwd if not already registered.
     * Projects with no artefacts are still listed (so the user sees them
     * being skipped); the registry self-prunes them later.
     */
    projects: ProjectEntry[];
    global: GlobalInventory;
    mcp: McpInventory;
}

/**
 * Build the full inventory across all in-scope projects. In repoOverride mode,
 * just the one project. Otherwise: every registry entry plus cwd if cwd has
 * artefacts and isn't already in the registry.
 */
export async function buildInventory(
    repoOverride: string | null,
    cwd: string,
    installDir: string,
    binDir: string,
): Promise<Inventory> {
    const projects: ProjectEntry[] = [];

    if (repoOverride) {
        const inv = await inventoryProject(repoOverride);
        projects.push({ path: repoOverride, inv });
    } else {
        // Registry-driven. We do NOT opportunistically scan cwd:
        // - if cwd is in the registry, it's listed below.
        // - if cwd has stray files but isn't registered, removing them based
        //   on filename alone is a data-loss risk (e.g. a co-located `arch-graph-out/`
        //   directory written manually by a user, or a stale registry entry
        //   whose path got reused for an unrelated project).
        // Users with pre-registry installs are pointed at `--repo .` via the
        // empty-state hint in renderInventory.
        const known = await listProjects();
        for (const p of known) {
            const inv = await inventoryProject(p);
            projects.push({ path: p, inv });
        }
    }

    const [global, mcp] = await Promise.all([inventoryGlobal(installDir, binDir), inventoryMcp()]);
    return { projects, global, mcp };
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
    // Provenance check: only flag `arch-graph-out/` for removal if it
    // contains our own output file. Without this, a directory that happens
    // to be named `arch-graph-out/` in an unrelated project (or a stale
    // registry entry whose path got reused) would be `rm -rf`'d on uninstall.
    if (existsSync(out) && existsSync(resolve(out, 'graph.json'))) {
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

    if (inv.projects.length === 0) {
        lines.push('Project artefacts: (no projects registered)');
        lines.push('  hint: if this project pre-dates the registry, run `arch-graph uninstall --repo .`');
    } else if (inv.projects.length === 1) {
        // Single-project rendering — same shape as before for back-compat.
        const { path, inv: p } = inv.projects[0]!;
        lines.push(`Project artefacts in ${path}:`);
        if (!hasAnyProject(p)) {
            lines.push('  – none found');
        } else {
            renderProjectArtefacts(lines, p);
        }
    } else {
        lines.push(`Project artefacts (${inv.projects.length} known projects):`);
        for (const { path, inv: p } of inv.projects) {
            if (!hasAnyProject(p)) {
                lines.push(`  ${path}  – (clean)`);
                continue;
            }
            lines.push(`  ${path}:`);
            renderProjectArtefacts(lines, p, '    ');
        }
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

function renderProjectArtefacts(out: string[], p: ProjectInventory, prefix = '  '): void {
    if (p.config) out.push(`${prefix}✓ ${p.config}`);
    if (p.outDir) out.push(`${prefix}✓ ${p.outDir.path}  (${humanSize(p.outDir.sizeBytes)})`);
    if (p.claudeMdWithBlock) out.push(`${prefix}✓ ${p.claudeMdWithBlock}  (arch-graph section)`);
    if (p.hookWithBlock) out.push(`${prefix}✓ ${p.hookWithBlock.path}  (${p.hookWithBlock.mode} block)`);
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

/**
 * Why this is `string | true` for installDir validation:
 * - 'missing-package-json' — no file at <installDir>/package.json
 * - 'parse-error'          — package.json exists but isn't valid JSON
 * - 'wrong-name'           — JSON parses, but name !== 'arch-graph'
 * - true                   — passes the check
 *
 * Distinct strings let `removeGlobalInstall` emit a targeted error that
 * tells the user EXACTLY why we refused, rather than a one-size-fits-all
 * "no arch-graph package.json found" message.
 */
type InstallCheck = 'missing-package-json' | 'parse-error' | 'wrong-name' | true;

function checkArchGraphInstall(installDir: string): InstallCheck {
    const pkgPath = resolve(installDir, 'package.json');
    if (!existsSync(pkgPath)) return 'missing-package-json';
    let pkg: unknown;
    try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
        return 'parse-error';
    }
    if (pkg && typeof pkg === 'object' && (pkg as Record<string, unknown>).name === 'arch-graph') {
        return true;
    }
    return 'wrong-name';
}

/**
 * Result of attempting the global uninstall step. Distinct shapes for
 * "we refused at the sentinel" vs "the script/rm actually ran" so the
 * caller doesn't print a redundant "exited with code 1" warning on top
 * of our already-explanatory refusal message.
 */
export type RemoveGlobalResult =
    | { kind: 'refused'; reason: InstallCheck; stderr: string }
    | { kind: 'done'; exitCode: number; stdout: string; stderr: string };

export function removeGlobalInstall(installDir: string): RemoveGlobalResult {
    // Refuse to touch anything that doesn't look like an arch-graph install.
    // The most common foot-gun: an old/leaked `ARCH_GRAPH_HOME` pointing at a
    // user's $HOME, or at a directory that contained an arch-graph install
    // years ago and now holds unrelated work.
    const check = checkArchGraphInstall(installDir);
    if (check !== true) {
        const detail = check === 'missing-package-json'
            ? `no package.json found at ${installDir}/package.json`
            : check === 'parse-error'
                ? `${installDir}/package.json is not valid JSON`
                : `${installDir}/package.json has name ≠ "arch-graph"`;
        return {
            kind: 'refused',
            reason: check,
            stderr:
                `⚠ arch-graph: refusing to remove ${installDir} — ${detail}.\n` +
                `  Set ARCH_GRAPH_HOME correctly, or delete the install dir manually.\n`,
        };
    }

    const script = resolve(installDir, 'scripts', 'uninstall.sh');
    if (!existsSync(script)) {
        // Older install without uninstall.sh — fall back to direct rm. This
        // shouldn't happen for fresh installs but keeps the wizard usable on
        // legacy layouts. Still gated by the sentinel check above.
        const linkAndSkill: string[] = [];
        const skill = resolve(homedir(), '.claude', 'skills', 'arch-graph');
        if (existsSync(skill)) linkAndSkill.push(skill);
        const r = spawnSync('rm', ['-rf', installDir, ...linkAndSkill], { encoding: 'utf8' });
        return { kind: 'done', exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    }
    const r = spawnSync('bash', [script, '--yes'], { encoding: 'utf8' });
    return { kind: 'done', exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
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

    const inv = await buildInventory(args.repoOverride, process.cwd(), installDir, binDir);

    output.write(renderInventory(inv) + '\n\n');

    const projectsWithArtefacts = inv.projects.filter((p) => hasAnyProject(p.inv));

    // ── Determine which scopes to run ────────────────────────────────────────
    let scopes: Set<UninstallScope>;
    let interactive = false;

    if (args.scopes.size > 0) {
        scopes = args.scopes;
    } else if (args.yes) {
        // --yes without explicit scopes ⇒ everything that's present
        scopes = new Set();
        if (projectsWithArtefacts.length > 0) scopes.add('project');
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

    // ── Multi-project blast-radius gate ─────────────────────────────────────
    // Non-TTY 'project' scope across ≥2 registered projects requires an
    // explicit --all-projects acknowledgement OR --repo X. Without this,
    // a CI script that used to do `arch-graph uninstall --yes` for one repo
    // would now silently sweep every other project in the registry.
    if (
        scopes.has('project') &&
        !interactive &&
        !args.repoOverride &&
        !args.allProjects &&
        projectsWithArtefacts.length >= 2
    ) {
        process.stderr.write(
            `⚠ arch-graph: ${projectsWithArtefacts.length} projects in registry have artefacts; refusing to sweep all of them without\n` +
            `  explicit --all-projects (or use --repo <path> for a single project).\n` +
            `  This guard exists so older scripts that ran \`arch-graph uninstall --yes\` for one repo don't\n` +
            `  silently clean every other repo on the registry. The projects above show the sweep target.\n`,
        );
        process.exit(2);
    }

    // ── Execute in safe order: project → mcp → global ────────────────────────
    if (scopes.has('project')) {
        if (projectsWithArtefacts.length === 0) {
            output.write('(no project artefacts to remove)\n');
        } else {
            for (const { path, inv: pinv } of projectsWithArtefacts) {
                output.write(`\n→ ${path}\n`);
                await removeProjectArtefacts(pinv);
                await unregisterProject(path);
            }
        }
    }

    if (scopes.has('mcp') && inv.mcp.projectsWithEntry.length > 0) {
        await removeMcpRegistrations(inv.mcp);
    } else if (scopes.has('mcp')) {
        output.write('(no MCP registrations to remove)\n');
    }

    let hadError = false;

    if (scopes.has('global') && hasAnyGlobal(inv.global)) {
        const result = removeGlobalInstall(installDir);
        if (result.kind === 'refused') {
            // Sentinel refused — emit only the structured refusal message,
            // not a generic "exited with code 1" on top.
            process.stderr.write(result.stderr);
            hadError = true;
        } else {
            if (result.stdout) output.write(result.stdout);
            if (result.stderr) process.stderr.write(result.stderr);
            if (result.exitCode !== 0) {
                process.stderr.write(`⚠ global uninstall exited with code ${result.exitCode}\n`);
                hadError = true;
            }
        }
    } else if (scopes.has('global')) {
        output.write('(no global install to remove)\n');
    }

    if (hadError) {
        output.write('\n⚠ done with errors — see messages above. Some scopes were not removed.\n');
        process.exit(1);
    }

    output.write('\n✓ done.\n');
}

async function askForScopes(inv: Inventory): Promise<Set<UninstallScope>> {
    const rl = createInterface({ input, output, terminal: true });
    const scopes = new Set<UninstallScope>();
    const projectsWithArtefacts = inv.projects.filter((p) => hasAnyProject(p.inv));

    try {
        if (projectsWithArtefacts.length > 0) {
            const label = projectsWithArtefacts.length === 1
                ? '? Remove project artefacts?'
                : `? Remove project artefacts from all ${projectsWithArtefacts.length} projects above?`;
            if (await askYesNo(rl, label, true)) scopes.add('project');
        }
        if (inv.mcp.projectsWithEntry.length > 0) {
            if (await askYesNo(rl, '? Remove MCP registrations?', true)) scopes.add('mcp');
        }
        if (hasAnyGlobal(inv.global)) {
            output.write('\n⚠  Global removal deletes the CLI itself. After this,\n');
            output.write('   `arch-graph` will be gone from PATH. Per-project files in\n');
            output.write('   any unlisted repos must be cleaned manually.\n\n');
            if (await askYesNo(rl, '? Remove global install?', false)) scopes.add('global');
        }
    } finally {
        rl.close();
    }

    return scopes;
}
