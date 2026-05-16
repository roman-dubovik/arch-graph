// Tests for the `arch-graph uninstall` wizard.
//
// Coverage strategy: pure functions (parse / inventory / render / remove-*)
// hammered with hermetic tmp-dir fixtures. The interactive wizard runner
// (`runUninstallWizard`) is exercised via the non-TTY paths only — TTY prompt
// flow is left to manual + integration testing.

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import {
    parseUninstallArgs,
    inventoryProject,
    inventoryGlobal,
    inventoryMcp,
    renderInventory,
    removeProjectArtefacts,
    removeMcpRegistrations,
    removeGlobalInstall,
    defaultBinDir,
    defaultInstallDir,
    runUninstallWizard,
} from './uninstall.js';
import { MARK_START as CLAUDE_MARK_START, MARK_END as CLAUDE_MARK_END } from './claude.js';
import { MARK_START as HOOK_MARK_START, MARK_END as HOOK_MARK_END } from './hooks.js';

// ─── parseUninstallArgs ──────────────────────────────────────────────────────

describe('parseUninstallArgs', () => {
    it('no flags → empty scopes, project=cwd', () => {
        const a = parseUninstallArgs([]);
        expect(a.scopes.size).toBe(0);
        expect(a.yes).toBe(false);
        expect(a.project).toBe(resolve('.'));
    });

    it('--project / --mcp / --global → individual scopes', () => {
        const a = parseUninstallArgs(['--project', '--mcp', '--global']);
        expect([...a.scopes].sort()).toEqual(['global', 'mcp', 'project']);
    });

    it('--all → all three scopes', () => {
        const a = parseUninstallArgs(['--all']);
        expect([...a.scopes].sort()).toEqual(['global', 'mcp', 'project']);
    });

    it('--yes / -y short forms', () => {
        expect(parseUninstallArgs(['--yes']).yes).toBe(true);
        expect(parseUninstallArgs(['-y']).yes).toBe(true);
    });

    it('--repo <path> and --repo=<path> both work', () => {
        expect(parseUninstallArgs(['--repo', '/tmp/x']).project).toBe('/tmp/x');
        expect(parseUninstallArgs(['--repo=/tmp/y']).project).toBe('/tmp/y');
    });

    it('unknown flags are ignored (forward-compat)', () => {
        const a = parseUninstallArgs(['--bogus']);
        expect(a.scopes.size).toBe(0);
    });
});

// ─── inventoryProject ────────────────────────────────────────────────────────

describe('inventoryProject', () => {
    it('empty project → all-nulls inventory', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        try {
            const inv = await inventoryProject(dir);
            expect(inv).toEqual({
                config: null,
                outDir: null,
                claudeMdWithBlock: null,
                hookWithBlock: null,
            });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('detects config + out + CLAUDE.md block + pre-commit hook', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        try {
            await writeFile(join(dir, 'arch-graph.config.ts'), 'export default {};\n');
            await mkdir(join(dir, 'arch-graph-out'));
            await writeFile(join(dir, 'arch-graph-out', 'graph.json'), '{}');
            await writeFile(
                join(dir, 'CLAUDE.md'),
                `# Project\n\n${CLAUDE_MARK_START}\nbody\n${CLAUDE_MARK_END}\n`,
            );
            await mkdir(join(dir, '.git', 'hooks'), { recursive: true });
            await writeFile(
                join(dir, '.git', 'hooks', 'pre-commit'),
                `#!/bin/sh\n${HOOK_MARK_START}\nexit 0\n${HOOK_MARK_END}\n`,
            );

            const inv = await inventoryProject(dir);
            expect(inv.config).toBe(resolve(dir, 'arch-graph.config.ts'));
            expect(inv.outDir).not.toBeNull();
            expect(inv.outDir!.path).toBe(resolve(dir, 'arch-graph-out'));
            expect(inv.outDir!.sizeBytes).toBeGreaterThanOrEqual(0);
            expect(inv.claudeMdWithBlock).toBe(resolve(dir, 'CLAUDE.md'));
            expect(inv.hookWithBlock).toEqual({
                path: resolve(dir, '.git', 'hooks', 'pre-commit'),
                mode: 'pre-commit',
            });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('CLAUDE.md without block → not flagged', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        try {
            await writeFile(join(dir, 'CLAUDE.md'), '# Project\n\nunrelated content\n');
            const inv = await inventoryProject(dir);
            expect(inv.claudeMdWithBlock).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('detects post-commit hook when pre-commit absent', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        try {
            await mkdir(join(dir, '.git', 'hooks'), { recursive: true });
            await writeFile(
                join(dir, '.git', 'hooks', 'post-commit'),
                `#!/bin/sh\n${HOOK_MARK_START}\nfoo\n${HOOK_MARK_END}\n`,
            );
            const inv = await inventoryProject(dir);
            expect(inv.hookWithBlock?.mode).toBe('post-commit');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('hook file without block → not flagged', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        try {
            await mkdir(join(dir, '.git', 'hooks'), { recursive: true });
            await writeFile(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
            const inv = await inventoryProject(dir);
            expect(inv.hookWithBlock).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

// ─── inventoryGlobal ─────────────────────────────────────────────────────────

describe('inventoryGlobal', () => {
    it('empty world → all nulls', async () => {
        const inv = await inventoryGlobal('/nonexistent/install', '/nonexistent/bin');
        expect(inv.installDir).toBeNull();
        expect(inv.symlinkPath).toBeNull();
        expect(inv.skillDir).toBeNull();
    });

    it('detects install dir and symlink that points into it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'ag-test-'));
        try {
            const install = join(root, 'install');
            const bin = join(root, 'bin');
            await mkdir(install, { recursive: true });
            await mkdir(join(install, 'bin'));
            await writeFile(join(install, 'bin', 'arch-graph'), '#!/bin/sh\n');
            await mkdir(bin);
            await symlink(join(install, 'bin', 'arch-graph'), join(bin, 'arch-graph'));

            const inv = await inventoryGlobal(install, bin);
            expect(inv.installDir?.path).toBe(install);
            expect(inv.symlinkPath).toBe(join(bin, 'arch-graph'));
            expect(inv.symlinkIsOurs).toBe(true);
            expect(inv.symlinkTarget).toBe(join(install, 'bin', 'arch-graph'));
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('symlink pointing OUTSIDE install dir → not ours', async () => {
        const root = await mkdtemp(join(tmpdir(), 'ag-test-'));
        try {
            const install = join(root, 'install');
            const bin = join(root, 'bin');
            const someOther = join(root, 'other', 'arch-graph');
            await mkdir(install);
            await mkdir(bin);
            await mkdir(join(root, 'other'));
            await writeFile(someOther, '#!/bin/sh\n');
            await symlink(someOther, join(bin, 'arch-graph'));

            const inv = await inventoryGlobal(install, bin);
            expect(inv.symlinkPath).toBe(join(bin, 'arch-graph'));
            expect(inv.symlinkIsOurs).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

// ─── inventoryMcp ────────────────────────────────────────────────────────────

describe('inventoryMcp', () => {
    // inventoryMcp() reads ~/.claude.json directly. To test in isolation we
    // exercise the parsing logic by writing a fixture and re-importing with
    // a stubbed HOME. node has no `process.env.HOME` override that affects
    // os.homedir() across all platforms — so we test the JSON-parsing branches
    // through the function's behaviour on the real ~/.claude.json instead, plus
    // direct unit-tests of the corrupt-JSON behaviour using a separate helper.
    //
    // The hermetic tests below override $HOME so os.homedir() (which on POSIX
    // delegates to $HOME) returns our fixture dir.

    const setHomedir = (h: string) => {
        const prev = process.env.HOME;
        process.env.HOME = h;
        return () => {
            if (prev === undefined) delete process.env.HOME;
            else process.env.HOME = prev;
        };
    };

    it('no ~/.claude.json → empty inventory', async () => {
        const home = await mkdtemp(join(tmpdir(), 'ag-home-'));
        const restore = setHomedir(home);
        try {
            const inv = await inventoryMcp();
            expect(inv.configPath).toBeNull();
            expect(inv.projectsWithEntry).toEqual([]);
        } finally {
            restore();
            await rm(home, { recursive: true, force: true });
        }
    });

    it('corrupt JSON → empty inventory, no throw', async () => {
        const home = await mkdtemp(join(tmpdir(), 'ag-home-'));
        const restore = setHomedir(home);
        try {
            await writeFile(join(home, '.claude.json'), 'not json{{{');
            const inv = await inventoryMcp();
            expect(inv.projectsWithEntry).toEqual([]);
        } finally {
            restore();
            await rm(home, { recursive: true, force: true });
        }
    });

    it('valid JSON with arch-graph in two projects → both reported', async () => {
        const home = await mkdtemp(join(tmpdir(), 'ag-home-'));
        const restore = setHomedir(home);
        try {
            await writeFile(
                join(home, '.claude.json'),
                JSON.stringify({
                    projects: {
                        '/path/to/a': { mcpServers: { 'arch-graph': { command: 'arch-graph' } } },
                        '/path/to/b': { mcpServers: { other: {}, 'arch-graph': {} } },
                        '/path/to/c': { mcpServers: { unrelated: {} } },
                        '/path/to/d': {},
                    },
                }),
            );
            const inv = await inventoryMcp();
            expect(inv.configPath).toBe(join(home, '.claude.json'));
            expect(inv.projectsWithEntry.sort()).toEqual(['/path/to/a', '/path/to/b']);
        } finally {
            restore();
            await rm(home, { recursive: true, force: true });
        }
    });

    it('JSON without projects key → empty', async () => {
        const home = await mkdtemp(join(tmpdir(), 'ag-home-'));
        const restore = setHomedir(home);
        try {
            await writeFile(join(home, '.claude.json'), JSON.stringify({ other: 'data' }));
            const inv = await inventoryMcp();
            expect(inv.projectsWithEntry).toEqual([]);
        } finally {
            restore();
            await rm(home, { recursive: true, force: true });
        }
    });
});

// ─── renderInventory ─────────────────────────────────────────────────────────

describe('renderInventory', () => {
    it('all-empty → "none found" sections', () => {
        const out = renderInventory({
            project: { config: null, outDir: null, claudeMdWithBlock: null, hookWithBlock: null },
            global: { installDir: null, symlinkPath: null, symlinkIsOurs: false, symlinkTarget: null, skillDir: null },
            mcp: { configPath: null, projectsWithEntry: [] },
        });
        expect(out).toMatch(/Project artefacts.*– none found/s);
        expect(out).toMatch(/MCP registrations.*– none found/s);
        expect(out).toMatch(/Global install.*– none found/s);
    });

    it('flags external symlink target with warning', () => {
        const out = renderInventory({
            project: { config: null, outDir: null, claudeMdWithBlock: null, hookWithBlock: null },
            global: {
                installDir: { path: '/some/install', sizeBytes: 1024 * 1024 },
                symlinkPath: '/usr/local/bin/arch-graph',
                symlinkIsOurs: false,
                symlinkTarget: '/elsewhere/arch-graph',
                skillDir: null,
            },
            mcp: { configPath: null, projectsWithEntry: [] },
        });
        expect(out).toContain('⚠ external target, will be left alone');
    });

    it('humanSize covers B / KB / MB / GB', () => {
        const big = renderInventory({
            project: {
                config: null,
                outDir: { path: '/x', sizeBytes: 5 * 1024 * 1024 * 1024 },
                claudeMdWithBlock: null,
                hookWithBlock: null,
            },
            global: { installDir: null, symlinkPath: null, symlinkIsOurs: false, symlinkTarget: null, skillDir: null },
            mcp: { configPath: null, projectsWithEntry: [] },
        });
        expect(big).toMatch(/5\.0 GB/);

        const small = renderInventory({
            project: {
                config: null,
                outDir: { path: '/x', sizeBytes: 500 },
                claudeMdWithBlock: null,
                hookWithBlock: null,
            },
            global: { installDir: null, symlinkPath: null, symlinkIsOurs: false, symlinkTarget: null, skillDir: null },
            mcp: { configPath: null, projectsWithEntry: [] },
        });
        expect(small).toMatch(/500 B/);

        const kb = renderInventory({
            project: {
                config: null,
                outDir: { path: '/x', sizeBytes: 2048 },
                claudeMdWithBlock: null,
                hookWithBlock: null,
            },
            global: { installDir: null, symlinkPath: null, symlinkIsOurs: false, symlinkTarget: null, skillDir: null },
            mcp: { configPath: null, projectsWithEntry: [] },
        });
        expect(kb).toMatch(/2\.0 KB/);
    });
});

// ─── removeProjectArtefacts ──────────────────────────────────────────────────

describe('removeProjectArtefacts', () => {
    it('strips CLAUDE.md section, leaving the rest intact', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        try {
            const cmdPath = join(dir, 'CLAUDE.md');
            await writeFile(
                cmdPath,
                `# Project\n\nkeep me\n\n${CLAUDE_MARK_START}\nbody\n${CLAUDE_MARK_END}\n\nalso keep\n`,
            );
            await removeProjectArtefacts({
                config: null,
                outDir: null,
                claudeMdWithBlock: cmdPath,
                hookWithBlock: null,
            });
            const after = await readFile(cmdPath, 'utf8');
            expect(after).toContain('keep me');
            expect(after).toContain('also keep');
            expect(after).not.toContain('arch-graph:start');
            expect(after).not.toContain('body');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('deletes empty hook file (shebang+comments only after strip)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        try {
            const hookPath = join(dir, 'pre-commit');
            await writeFile(
                hookPath,
                `#!/bin/sh\n# managed by arch-graph\n${HOOK_MARK_START}\nbody\n${HOOK_MARK_END}\n`,
            );
            await removeProjectArtefacts({
                config: null,
                outDir: null,
                claudeMdWithBlock: null,
                hookWithBlock: { path: hookPath, mode: 'pre-commit' },
            });
            expect(existsSync(hookPath)).toBe(false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('keeps hook file when other meaningful content remains', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        try {
            const hookPath = join(dir, 'pre-commit');
            await writeFile(
                hookPath,
                `#!/bin/sh\nlint-staged\n${HOOK_MARK_START}\nbody\n${HOOK_MARK_END}\n`,
            );
            await removeProjectArtefacts({
                config: null,
                outDir: null,
                claudeMdWithBlock: null,
                hookWithBlock: { path: hookPath, mode: 'pre-commit' },
            });
            expect(existsSync(hookPath)).toBe(true);
            const body = await readFile(hookPath, 'utf8');
            expect(body).toContain('lint-staged');
            expect(body).not.toContain('arch-graph');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('removes config + out dir', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        try {
            const cfg = join(dir, 'arch-graph.config.ts');
            const out = join(dir, 'arch-graph-out');
            await writeFile(cfg, 'export default {};\n');
            await mkdir(out);
            await writeFile(join(out, 'graph.json'), '{}');

            await removeProjectArtefacts({
                config: cfg,
                outDir: { path: out, sizeBytes: 0 },
                claudeMdWithBlock: null,
                hookWithBlock: null,
            });

            expect(existsSync(cfg)).toBe(false);
            expect(existsSync(out)).toBe(false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('no-op when nothing in inventory', async () => {
        // Should not throw.
        await removeProjectArtefacts({
            config: null,
            outDir: null,
            claudeMdWithBlock: null,
            hookWithBlock: null,
        });
    });
});

// ─── removeMcpRegistrations ──────────────────────────────────────────────────

describe('removeMcpRegistrations', () => {
    it('deletes arch-graph from listed projects, preserves others', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        try {
            const cfg = join(dir, '.claude.json');
            const initial = {
                projects: {
                    '/a': { mcpServers: { 'arch-graph': { cmd: 'x' }, other: {} } },
                    '/b': { mcpServers: { 'arch-graph': {} } },
                    '/c': { mcpServers: { other: {} } },
                },
                otherField: 'untouched',
            };
            await writeFile(cfg, JSON.stringify(initial));

            await removeMcpRegistrations({ configPath: cfg, projectsWithEntry: ['/a', '/b'] });

            const after = JSON.parse(await readFile(cfg, 'utf8'));
            expect(after.projects['/a'].mcpServers).toEqual({ other: {} });
            expect(after.projects['/b'].mcpServers).toEqual({});
            expect(after.projects['/c'].mcpServers).toEqual({ other: {} });
            expect(after.otherField).toBe('untouched');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('handles missing project entries gracefully', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        try {
            const cfg = join(dir, '.claude.json');
            await writeFile(cfg, JSON.stringify({ projects: { '/x': {} } }));
            await removeMcpRegistrations({ configPath: cfg, projectsWithEntry: ['/missing'] });
            // Should not throw; file remains parseable.
            const after = JSON.parse(await readFile(cfg, 'utf8'));
            expect(after.projects['/x']).toEqual({});
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('corrupt JSON → no-op, no throw', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        try {
            const cfg = join(dir, '.claude.json');
            await writeFile(cfg, 'not json{{{');
            await removeMcpRegistrations({ configPath: cfg, projectsWithEntry: ['/a'] });
            // File content unchanged.
            const after = await readFile(cfg, 'utf8');
            expect(after).toBe('not json{{{');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('no configPath → no-op', async () => {
        // No throw, no fs ops.
        await removeMcpRegistrations({ configPath: null, projectsWithEntry: [] });
    });
});

// ─── removeGlobalInstall ─────────────────────────────────────────────────────

describe('removeGlobalInstall', () => {
    it('fallback (no uninstall.sh) → spawns rm and deletes installDir', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        try {
            // No scripts/uninstall.sh in this fake install dir → fallback path.
            await mkdir(join(dir, 'bin'));
            await writeFile(join(dir, 'bin', 'arch-graph'), '#!/bin/sh\n');

            const result = removeGlobalInstall(dir);
            expect(result.exitCode).toBe(0);
            expect(existsSync(dir)).toBe(false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('uninstall.sh path → invokes it with --yes', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        try {
            // Plant a tiny stub uninstall.sh that just signals success and
            // touches a sentinel so we know it ran with the right flag.
            await mkdir(join(dir, 'scripts'), { recursive: true });
            const sentinel = join(dir, 'ran-with');
            await writeFile(
                join(dir, 'scripts', 'uninstall.sh'),
                `#!/bin/sh\necho "$@" > "${sentinel}"\nexit 0\n`,
                { mode: 0o755 },
            );

            const result = removeGlobalInstall(dir);
            expect(result.exitCode).toBe(0);
            const ranWith = await readFile(sentinel, 'utf8');
            expect(ranWith.trim()).toBe('--yes');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

// ─── runUninstallWizard (non-TTY paths) ──────────────────────────────────────

describe('runUninstallWizard', () => {
    const captureStdout = async (fn: () => Promise<void>): Promise<string> => {
        const chunks: string[] = [];
        const orig = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: string | Buffer) => {
            chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
            return true;
        }) as typeof process.stdout.write;
        try {
            await fn();
        } finally {
            process.stdout.write = orig;
        }
        return chunks.join('');
    };

    const withEnv = async <T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
        const prev: Record<string, string | undefined> = {};
        for (const k of Object.keys(vars)) prev[k] = process.env[k];
        for (const [k, v] of Object.entries(vars)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        try {
            return await fn();
        } finally {
            for (const k of Object.keys(prev)) {
                if (prev[k] === undefined) delete process.env[k];
                else process.env[k] = prev[k];
            }
        }
    };

    // Force non-TTY for these tests regardless of the runner state.
    const withNonTty = async (fn: () => Promise<void>): Promise<void> => {
        const prev = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
        try {
            await fn();
        } finally {
            Object.defineProperty(process.stdin, 'isTTY', { value: prev, configurable: true });
        }
    };

    it('non-TTY, no flags → dry-run (no fs side-effects)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        const home = await mkdtemp(join(tmpdir(), 'ag-home-'));
        try {
            await writeFile(join(dir, 'arch-graph.config.ts'), 'x');
            const out = await captureStdout(async () => {
                await withNonTty(async () => {
                    await withEnv({ HOME: home, ARCH_GRAPH_HOME: dir, ARCH_GRAPH_BIN_DIR: join(dir, 'bin') }, async () => {
                        await runUninstallWizard({ scopes: new Set(), project: dir, yes: false });
                    });
                });
            });
            expect(out).toMatch(/Dry-run only/);
            // Config still on disk — wasn't removed.
            expect(existsSync(join(dir, 'arch-graph.config.ts'))).toBe(true);
        } finally {
            await rm(dir, { recursive: true, force: true });
            await rm(home, { recursive: true, force: true });
        }
    });

    it('scopes=[project] with no artefacts → "nothing to remove" message', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        const home = await mkdtemp(join(tmpdir(), 'ag-home-'));
        try {
            const out = await captureStdout(async () => {
                await withEnv({ HOME: home, ARCH_GRAPH_HOME: dir, ARCH_GRAPH_BIN_DIR: join(dir, 'bin') }, async () => {
                    await runUninstallWizard({
                        scopes: new Set(['project']),
                        project: dir,
                        yes: false,
                    });
                });
            });
            expect(out).toMatch(/no project artefacts to remove/);
            expect(out).toMatch(/done/);
        } finally {
            await rm(dir, { recursive: true, force: true });
            await rm(home, { recursive: true, force: true });
        }
    });

    it('scopes=[project] with artefacts → removes them', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        const home = await mkdtemp(join(tmpdir(), 'ag-home-'));
        try {
            await writeFile(join(dir, 'arch-graph.config.ts'), 'x');
            await mkdir(join(dir, 'arch-graph-out'));
            await writeFile(join(dir, 'arch-graph-out', 'graph.json'), '{}');

            await captureStdout(async () => {
                await withEnv({ HOME: home, ARCH_GRAPH_HOME: dir, ARCH_GRAPH_BIN_DIR: join(dir, 'bin') }, async () => {
                    await runUninstallWizard({
                        scopes: new Set(['project']),
                        project: dir,
                        yes: false,
                    });
                });
            });

            expect(existsSync(join(dir, 'arch-graph.config.ts'))).toBe(false);
            expect(existsSync(join(dir, 'arch-graph-out'))).toBe(false);
        } finally {
            await rm(dir, { recursive: true, force: true });
            await rm(home, { recursive: true, force: true });
        }
    });

    it('scopes=[mcp] with no entries → "no MCP registrations" message', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        const home = await mkdtemp(join(tmpdir(), 'ag-home-'));
        try {
            const out = await captureStdout(async () => {
                await withEnv({ HOME: home, ARCH_GRAPH_HOME: dir, ARCH_GRAPH_BIN_DIR: join(dir, 'bin') }, async () => {
                    await runUninstallWizard({
                        scopes: new Set(['mcp']),
                        project: dir,
                        yes: false,
                    });
                });
            });
            expect(out).toMatch(/no MCP registrations to remove/);
        } finally {
            await rm(dir, { recursive: true, force: true });
            await rm(home, { recursive: true, force: true });
        }
    });

    it('scopes=[global] with no install → "no global install" message', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        const home = await mkdtemp(join(tmpdir(), 'ag-home-'));
        try {
            const fakeInstall = join(dir, 'nothing-here');
            const out = await captureStdout(async () => {
                await withEnv({ HOME: home, ARCH_GRAPH_HOME: fakeInstall, ARCH_GRAPH_BIN_DIR: join(dir, 'bin') }, async () => {
                    await runUninstallWizard({
                        scopes: new Set(['global']),
                        project: dir,
                        yes: false,
                    });
                });
            });
            expect(out).toMatch(/no global install to remove/);
        } finally {
            await rm(dir, { recursive: true, force: true });
            await rm(home, { recursive: true, force: true });
        }
    });

    it('--yes with populated project/mcp/global → executes all three', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        const home = await mkdtemp(join(tmpdir(), 'ag-home-'));
        try {
            // Project artefacts
            await writeFile(join(dir, 'arch-graph.config.ts'), 'x');
            // MCP entry under HOME
            await writeFile(
                join(home, '.claude.json'),
                JSON.stringify({ projects: { '/p1': { mcpServers: { 'arch-graph': {} } } } }),
            );
            // Global "install" with stub uninstall.sh
            const fakeInstall = join(dir, 'fake-install');
            await mkdir(join(fakeInstall, 'scripts'), { recursive: true });
            const ran = join(fakeInstall, 'ran');
            await writeFile(
                join(fakeInstall, 'scripts', 'uninstall.sh'),
                `#!/bin/sh\necho "$@" > "${ran}"\nexit 0\n`,
                { mode: 0o755 },
            );

            await captureStdout(async () => {
                await withEnv({ HOME: home, ARCH_GRAPH_HOME: fakeInstall, ARCH_GRAPH_BIN_DIR: join(dir, 'bin') }, async () => {
                    await runUninstallWizard({
                        scopes: new Set(),
                        project: dir,
                        yes: true,
                    });
                });
            });

            // Project: config removed
            expect(existsSync(join(dir, 'arch-graph.config.ts'))).toBe(false);
            // MCP: entry deleted
            const after = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
            expect(after.projects['/p1'].mcpServers).toEqual({});
            // Global: stub script invoked with --yes
            const ranWith = await readFile(ran, 'utf8');
            expect(ranWith.trim()).toBe('--yes');
        } finally {
            await rm(dir, { recursive: true, force: true });
            await rm(home, { recursive: true, force: true });
        }
    });

    it('explicit scope=Set() (empty) on TTY-isTTY-undefined → "nothing selected"', async () => {
        // Edge case: when --yes is false AND scopes is empty AND we're on TTY,
        // askForScopes runs. To exercise the "nothing selected" branch we
        // simulate non-TTY but with --yes=false → falls into dry-run branch
        // covered above. The "nothing selected" branch fires when the TTY user
        // declines every prompt; covered manually + integration tests.
        // This test just asserts the helper exits cleanly with non-TTY no-op.
        const dir = await mkdtemp(join(tmpdir(), 'ag-test-'));
        const home = await mkdtemp(join(tmpdir(), 'ag-home-'));
        try {
            await captureStdout(async () => {
                await withNonTty(async () => {
                    await withEnv({ HOME: home, ARCH_GRAPH_HOME: dir, ARCH_GRAPH_BIN_DIR: join(dir, 'bin') }, async () => {
                        await runUninstallWizard({ scopes: new Set(), project: dir, yes: false });
                    });
                });
            });
            // No throw, no fs effects.
            expect(existsSync(dir)).toBe(true);
        } finally {
            await rm(dir, { recursive: true, force: true });
            await rm(home, { recursive: true, force: true });
        }
    });
});

// ─── default-dir helpers ─────────────────────────────────────────────────────

describe('default-dir helpers', () => {
    it('defaultInstallDir resolves to <package-root>', () => {
        const d = defaultInstallDir();
        expect(d.length).toBeGreaterThan(0);
        // Heuristic: should point at a directory that contains package.json
        // when invoked from the source tree.
        expect(existsSync(resolve(d, 'package.json'))).toBe(true);
    });

    it('defaultBinDir respects ARCH_GRAPH_BIN_DIR override', () => {
        const prev = process.env.ARCH_GRAPH_BIN_DIR;
        process.env.ARCH_GRAPH_BIN_DIR = '/custom/bin';
        try {
            expect(defaultBinDir()).toBe('/custom/bin');
        } finally {
            if (prev === undefined) delete process.env.ARCH_GRAPH_BIN_DIR;
            else process.env.ARCH_GRAPH_BIN_DIR = prev;
        }
    });
});
