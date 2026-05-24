import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';

import {
    buildInventory,
    inventoryProject,
    inventoryGlobal,
    removeProjectArtefacts,
    removeGlobalInstall,
} from './uninstall.js';
import { registerProject, unregisterProject, listProjects } from './project-registry.js';
import { agentHookInstall } from './hooks.js';

describe('Lifecycle Integration Tests', () => {
    let testHome: string;
    let testXdgState: string;
    let testInstallDir: string;
    let testBinDir: string;

    beforeEach(async () => {
        testHome = await mkdtemp(join(tmpdir(), 'ag-lifecycle-home-'));
        testXdgState = join(testHome, '.local', 'state');
        testInstallDir = join(testHome, '.arch-graph');
        testBinDir = join(testHome, '.local', 'bin');

        process.env.HOME = testHome;
        process.env.XDG_STATE_HOME = testXdgState;
        process.env.ARCH_GRAPH_REGISTRY = join(testXdgState, 'arch-graph', 'registry.json');

        await mkdir(testInstallDir, { recursive: true });
        await mkdir(testBinDir, { recursive: true });
        await writeFile(join(testInstallDir, 'package.json'), JSON.stringify({ name: 'arch-graph' }));
    });

    afterEach(async () => {
        await rm(testHome, { recursive: true, force: true });
    });

    describe('1.1 Registry Logic', () => {
        it('should register and unregister projects correctly', async () => {
            const p1 = join(testHome, 'project-1');
            const p2 = join(testHome, 'project-2');
            await mkdir(p1);
            await mkdir(p2);

            await registerProject(p1);
            await registerProject(p2);
            expect(await listProjects()).toContain(resolve(p1));
            expect(await listProjects()).toContain(resolve(p2));

            await unregisterProject(p1);
            const list = await listProjects();
            expect(list).not.toContain(resolve(p1));
            expect(list).toContain(resolve(p2));
        });
    });

    describe('1.2 Project Inventory', () => {
        it('should detect all project artifacts', async () => {
            const p1 = join(testHome, 'project-1');
            await mkdir(p1);
            const config = join(p1, 'arch-graph.config.ts');
            const outDir = join(p1, 'arch-graph-out');
            const graphJson = join(outDir, 'graph.json');
            const claudeMd = join(p1, 'CLAUDE.md');

            await writeFile(config, '');
            await mkdir(outDir);
            await writeFile(graphJson, '{}');
            await writeFile(claudeMd, '<!-- arch-graph:start -->\ncontent\n<!-- arch-graph:end -->');

            const inv = await inventoryProject(p1);
            expect(inv.config).toBe(resolve(config));
            expect(inv.outDir?.path).toBe(resolve(outDir));
            expect(inv.claudeMdWithBlock).toBe(resolve(claudeMd));
        });
    });

    describe('1.3 Global Inventory', () => {
        it('should identify our symlink and install dir', async () => {
            const binary = join(testInstallDir, 'bin', 'arch-graph');
            await mkdir(join(testInstallDir, 'bin'), { recursive: true });
            await writeFile(binary, '');
            
            const link = join(testBinDir, 'arch-graph');
            await symlink(binary, link);

            const inv = await inventoryGlobal(testInstallDir, testBinDir);
            expect(inv.installDir?.path).toBe(resolve(testInstallDir));
            expect(inv.symlinkPath).toBe(resolve(link));
            expect(inv.symlinkIsOurs).toBe(true);
        });
    });

    describe('2.1 Scaffolding (Multi-Agent)', () => {
        it('should scaffold for all selected agents (Claude, Cursor)', async () => {
            const p1 = join(testHome, 'project-multi');
            await mkdir(p1);
            
            // Emulate selection of agents
            await agentHookInstall({ repo: p1, agent: 'all' });

            // Claude
            expect(existsSync(join(p1, '.claude', 'hooks', 'SessionStart.sh'))).toBe(true);
            // Cursor
            expect(existsSync(join(p1, '.cursorrules'))).toBe(true);
        });
    });

    describe('2.2 Project Uninstall', () => {
        it('should surgically remove all project artifacts and delete files if they become empty', async () => {
            const p1 = join(testHome, 'project-un');
            await mkdir(p1);
            const config = join(p1, 'arch-graph.config.ts');
            const outDir = join(p1, 'arch-graph-out');
            const claudeMd = join(p1, 'CLAUDE.md');

            await writeFile(config, '');
            await mkdir(outDir);
            await writeFile(join(outDir, 'graph.json'), '{}');
            // Claude.md only has our block
            await writeFile(claudeMd, '<!-- arch-graph:start -->\ncontent\n<!-- arch-graph:end -->');

            const inv = await inventoryProject(p1);
            await removeProjectArtefacts(inv);

            expect(existsSync(config)).toBe(false);
            expect(existsSync(outDir)).toBe(false);
            expect(existsSync(claudeMd)).toBe(false); // File should be gone because it was only arch-graph
        });
    });

    describe('2.6 Broken Markers Resilience', () => {
        it('should NOT delete content if the marker pair is incomplete', async () => {
            const p1 = join(testHome, 'project-broken-markers');
            await mkdir(p1);
            const claudeMd = join(p1, 'CLAUDE.md');
            
            const content = "# User Content\n<!-- arch-graph:start -->\norphaned content";
            await writeFile(claudeMd, content);

            const inv = await inventoryProject(p1);
            // Inventory should NOT detect this as a valid managed block
            expect(inv.claudeMdWithBlock).toBeNull();

            await removeProjectArtefacts(inv);

            const finalContent = await readFile(claudeMd, 'utf8');
            expect(finalContent).toBe(content); // Should be untouched
        });
    });

    describe('2.3 Surgical Integrity (.cursorrules)', () => {
        it('should remove ONLY arch-graph block from .cursorrules and keep user rules', async () => {
            const p1 = join(testHome, 'project-surgical-rules');
            await mkdir(p1);
            const cursorRules = join(p1, '.cursorrules');
            
            const userContent = "## User Custom Rule\nAlways use tabs.";
            const archBlock = "\n# >>> arch-graph >>>\narch-graph code-intel summary\n# <<< arch-graph <<<\n";
            await writeFile(cursorRules, userContent + archBlock);

            const inv = await inventoryProject(p1);
            await removeProjectArtefacts(inv);

            const finalContent = await readFile(cursorRules, 'utf8');
            expect(finalContent.trim()).toBe(userContent.trim());
            expect(finalContent).not.toContain('arch-graph');
        });
    });

    describe('2.4 Surgical Integrity (CLAUDE.md)', () => {
        it('should preserve user notes in CLAUDE.md', async () => {
            const p1 = join(testHome, 'project-surgical-claude');
            await mkdir(p1);
            const claudeMd = join(p1, 'CLAUDE.md');
            
            const userNotes = "# Project Notes\nDon't forget to run build.";
            // Note: Using the REAL markers from claude.ts
            const archBlock = "\n<!-- arch-graph:start -->\ninfo\n<!-- arch-graph:end -->\n";
            await writeFile(claudeMd, userNotes + archBlock);

            const inv = await inventoryProject(p1);
            await removeProjectArtefacts(inv);

            const finalContent = await readFile(claudeMd, 'utf8');
            expect(finalContent.trim()).toBe(userNotes.trim());
            expect(existsSync(claudeMd)).toBe(true);
        });
    });

    describe('2.5 Surgical Integrity (Shared Git Hook)', () => {
        it('should remove arch-graph block from a shared hook and keep other tools', async () => {
            const repo = join(testHome, 'project-shared-hook');
            await mkdir(repo);
            await mkdir(join(repo, '.git', 'hooks'), { recursive: true });
            const hookPath = join(repo, '.git', 'hooks', 'pre-commit');
            
            const otherTool = "#!/bin/sh\n# husky start\nnpm test\n# husky end\n";
            const archBlock = "\n# >>> arch-graph >>>\narch-graph build\n# <<< arch-graph <<<\n";
            await writeFile(hookPath, otherTool + archBlock);

            const inv = await inventoryProject(repo);
            // We need to ensure inventory detects it as hookWithBlock
            expect(inv.hookWithBlock?.path).toBe(resolve(hookPath));

            await removeProjectArtefacts(inv);

            const finalContent = await readFile(hookPath, 'utf8');
            expect(finalContent.trim()).toBe(otherTool.trim());
            expect(finalContent).not.toContain('arch-graph');
            expect(existsSync(hookPath)).toBe(true);
        });
    });

    describe('3.1 Multi-Project Sweep', () => {
        it('should sweep multiple registered projects in one command', async () => {
            const p1 = join(testHome, 'project-a');
            const p2 = join(testHome, 'project-b');
            await mkdir(p1);
            await mkdir(p2);
            
            // Setup artifacts in both
            await writeFile(join(p1, 'arch-graph.config.ts'), '');
            await writeFile(join(p2, 'arch-graph.config.ts'), '');
            
            // Register them
            await registerProject(p1);
            await registerProject(p2);

            // Build inventory for all projects in registry
            const inv = await buildInventory(null, testHome, testInstallDir, testBinDir);
            expect(inv.projects.length).toBe(2);

            // Action: remove project scope for all
            for (const project of inv.projects) {
                await removeProjectArtefacts(project.inv);
                await unregisterProject(project.path);
            }

            expect(existsSync(join(p1, 'arch-graph.config.ts'))).toBe(false);
            expect(existsSync(join(p2, 'arch-graph.config.ts'))).toBe(false);
            expect(await listProjects()).toEqual([]);
        });
    });

    describe('3.2 Full Teardown Identification', () => {
        it('should identify global install and symlink for removal', async () => {
            // Setup global state
            const binary = join(testInstallDir, 'bin', 'arch-graph');
            await mkdir(join(testInstallDir, 'bin'), { recursive: true });
            await writeFile(binary, '');
            const link = join(testBinDir, 'arch-graph');
            await symlink(binary, link);

            const inv = await inventoryGlobal(testInstallDir, testBinDir);
            expect(inv.installDir?.path).toBe(resolve(testInstallDir));
            expect(inv.symlinkPath).toBe(resolve(link));
            expect(inv.symlinkIsOurs).toBe(true);
        });
    });
});
