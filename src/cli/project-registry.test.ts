// Tests for the project registry (src/cli/project-registry.ts).
//
// Each test runs with $ARCH_GRAPH_REGISTRY pointed at a tmp file so we never
// touch the user's real registry.

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
    listProjects,
    registerProject,
    registryPath,
    unregisterProject,
} from './project-registry.js';

const withRegistry = async <T>(fn: (registryFile: string) => Promise<T>): Promise<T> => {
    const dir = await mkdtemp(join(tmpdir(), 'ag-reg-'));
    const registryFile = join(dir, 'registry.json');
    const prev = process.env.ARCH_GRAPH_REGISTRY;
    process.env.ARCH_GRAPH_REGISTRY = registryFile;
    try {
        return await fn(registryFile);
    } finally {
        if (prev === undefined) delete process.env.ARCH_GRAPH_REGISTRY;
        else process.env.ARCH_GRAPH_REGISTRY = prev;
        await rm(dir, { recursive: true, force: true });
    }
};

describe('registryPath', () => {
    it('respects ARCH_GRAPH_REGISTRY override', () => {
        const prev = process.env.ARCH_GRAPH_REGISTRY;
        process.env.ARCH_GRAPH_REGISTRY = '/custom/place.json';
        try {
            expect(registryPath()).toBe('/custom/place.json');
        } finally {
            if (prev === undefined) delete process.env.ARCH_GRAPH_REGISTRY;
            else process.env.ARCH_GRAPH_REGISTRY = prev;
        }
    });

    it('falls back to XDG_STATE_HOME', () => {
        const prevReg = process.env.ARCH_GRAPH_REGISTRY;
        const prevXdg = process.env.XDG_STATE_HOME;
        delete process.env.ARCH_GRAPH_REGISTRY;
        process.env.XDG_STATE_HOME = '/x/state';
        try {
            expect(registryPath()).toBe('/x/state/arch-graph/registry.json');
        } finally {
            if (prevReg === undefined) delete process.env.ARCH_GRAPH_REGISTRY;
            else process.env.ARCH_GRAPH_REGISTRY = prevReg;
            if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
            else process.env.XDG_STATE_HOME = prevXdg;
        }
    });

    it('defaults to ~/.local/state/arch-graph/registry.json', () => {
        const prevReg = process.env.ARCH_GRAPH_REGISTRY;
        const prevXdg = process.env.XDG_STATE_HOME;
        delete process.env.ARCH_GRAPH_REGISTRY;
        delete process.env.XDG_STATE_HOME;
        try {
            expect(registryPath()).toMatch(/\.local\/state\/arch-graph\/registry\.json$/);
        } finally {
            if (prevReg === undefined) delete process.env.ARCH_GRAPH_REGISTRY;
            else process.env.ARCH_GRAPH_REGISTRY = prevReg;
            if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
            else process.env.XDG_STATE_HOME = prevXdg;
        }
    });
});

describe('registerProject', () => {
    it('creates the file with the first entry', async () => {
        await withRegistry(async (reg) => {
            await registerProject('/p1');
            const data = JSON.parse(await readFile(reg, 'utf8'));
            expect(data.version).toBe(1);
            expect(data.projects.length).toBe(1);
            expect(data.projects[0].path).toBe(resolve('/p1'));
        });
    });

    it('is idempotent — re-registering the same path refreshes lastSeen', async () => {
        await withRegistry(async (reg) => {
            await registerProject('/p1');
            const before = JSON.parse(await readFile(reg, 'utf8'));
            await new Promise((r) => setTimeout(r, 10));
            await registerProject('/p1');
            const after = JSON.parse(await readFile(reg, 'utf8'));
            expect(after.projects.length).toBe(1);
            expect(after.projects[0].lastSeen).not.toBe(before.projects[0].lastSeen);
        });
    });

    it('appends multiple distinct projects', async () => {
        await withRegistry(async (reg) => {
            await registerProject('/a');
            await registerProject('/b');
            await registerProject('/c');
            const data = JSON.parse(await readFile(reg, 'utf8'));
            expect(data.projects.map((p: { path: string }) => p.path).sort()).toEqual([
                resolve('/a'),
                resolve('/b'),
                resolve('/c'),
            ]);
        });
    });

    it('swallows errors silently (e.g. directory unwritable)', async () => {
        // Point at a path that can't be written (under a non-existent root
        // we can't create). registerProject should NOT throw.
        const prev = process.env.ARCH_GRAPH_REGISTRY;
        process.env.ARCH_GRAPH_REGISTRY = '/proc/cannot/write.json';
        try {
            await expect(registerProject('/p')).resolves.toBeUndefined();
        } finally {
            if (prev === undefined) delete process.env.ARCH_GRAPH_REGISTRY;
            else process.env.ARCH_GRAPH_REGISTRY = prev;
        }
    });
});

describe('listProjects', () => {
    it('empty file → empty list', async () => {
        await withRegistry(async () => {
            const list = await listProjects();
            expect(list).toEqual([]);
        });
    });

    it('lists all alive paths', async () => {
        await withRegistry(async (reg) => {
            const dir = await mkdtemp(join(tmpdir(), 'ag-existing-'));
            try {
                await registerProject(dir);
                const list = await listProjects();
                expect(list).toEqual([resolve(dir)]);
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        });
    });

    it('auto-prunes dead paths', async () => {
        await withRegistry(async (reg) => {
            const dir = await mkdtemp(join(tmpdir(), 'ag-existing-'));
            // Register, then delete the directory
            await registerProject(dir);
            await registerProject('/nonexistent/dead-path');
            await rm(dir, { recursive: true, force: true });

            const list = await listProjects();
            expect(list).toEqual([]);
            // Registry file should be auto-deleted when empty
            expect(existsSync(reg)).toBe(false);
        });
    });

    it('keeps registry file when at least one alive path remains', async () => {
        await withRegistry(async (reg) => {
            const dir = await mkdtemp(join(tmpdir(), 'ag-keep-'));
            try {
                await registerProject(dir);
                await registerProject('/nonexistent/X');
                const list = await listProjects();
                expect(list).toEqual([resolve(dir)]);
                expect(existsSync(reg)).toBe(true);
                const data = JSON.parse(await readFile(reg, 'utf8'));
                expect(data.projects.length).toBe(1);
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        });
    });
});

describe('unregisterProject', () => {
    it('removes a single entry', async () => {
        await withRegistry(async () => {
            const a = await mkdtemp(join(tmpdir(), 'ag-a-'));
            const b = await mkdtemp(join(tmpdir(), 'ag-b-'));
            try {
                await registerProject(a);
                await registerProject(b);
                await unregisterProject(a);
                const list = await listProjects();
                expect(list).toEqual([resolve(b)]);
            } finally {
                await rm(a, { recursive: true, force: true });
                await rm(b, { recursive: true, force: true });
            }
        });
    });

    it('deletes the file when registry becomes empty', async () => {
        await withRegistry(async (reg) => {
            const a = await mkdtemp(join(tmpdir(), 'ag-a-'));
            try {
                await registerProject(a);
                expect(existsSync(reg)).toBe(true);
                await unregisterProject(a);
                expect(existsSync(reg)).toBe(false);
            } finally {
                await rm(a, { recursive: true, force: true });
            }
        });
    });

    it('no-op when path not in registry', async () => {
        await withRegistry(async () => {
            await expect(unregisterProject('/nonexistent')).resolves.toBeUndefined();
        });
    });
});

describe('load tolerance (corrupt registry)', () => {
    it('corrupt JSON → behaves as empty', async () => {
        await withRegistry(async (reg) => {
            await mkdir(join(reg, '..'), { recursive: true });
            await writeFile(reg, 'not json{{{');
            const list = await listProjects();
            expect(list).toEqual([]);
        });
    });

    it('valid JSON but wrong shape → empty', async () => {
        await withRegistry(async (reg) => {
            await mkdir(join(reg, '..'), { recursive: true });
            await writeFile(reg, JSON.stringify({ projects: 'not-an-array' }));
            const list = await listProjects();
            expect(list).toEqual([]);
        });
    });

    it('entries missing path field are skipped', async () => {
        await withRegistry(async (reg) => {
            const dir = await mkdtemp(join(tmpdir(), 'ag-mix-'));
            try {
                await mkdir(join(reg, '..'), { recursive: true });
                await writeFile(
                    reg,
                    JSON.stringify({
                        version: 1,
                        projects: [
                            { path: dir, lastSeen: 'x' },
                            { lastSeen: 'no-path' },
                            { path: 123, lastSeen: 'bad-type' },
                            'not-an-object',
                        ],
                    }),
                );
                const list = await listProjects();
                expect(list).toEqual([resolve(dir)]);
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        });
    });
});
