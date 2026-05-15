import fg from 'fast-glob';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ArchGraphConfig } from './config.js';
import type { GraphOwnerRef } from './types.js';

export interface ServiceManifest {
    id: string;
    rootDir: string;
    tsconfigPath: string | null;
    entryFile: string | null;
}

export interface LibManifest {
    /** "libs/common/auth" — path relative to monorepo root */
    id: string;
    rootDir: string;
}

export class OwnershipRegistry {
    constructor(
        public readonly root: string,
        public readonly services: ServiceManifest[],
        public readonly libs: LibManifest[],
    ) {}

    /** Resolve a source file to its owning service/lib node. */
    findOwner(filePath: string): GraphOwnerRef {
        // Services first — they are more specific within apps/.
        for (const s of this.services) {
            if (filePath === s.rootDir || filePath.startsWith(s.rootDir + '/')) {
                return { kind: 'service', id: s.id };
            }
        }
        for (const l of this.libs) {
            if (filePath === l.rootDir || filePath.startsWith(l.rootDir + '/')) {
                return { kind: 'lib', id: l.id, path: l.rootDir };
            }
        }
        return { kind: 'unknown', path: filePath };
    }
}

export async function discoverOwnership(cfg: ArchGraphConfig): Promise<OwnershipRegistry> {
    const root = resolve(cfg.root);
    const services = await discoverServices(cfg, root);
    const libs = cfg.libsGlob ? await discoverLibs(cfg, root) : [];
    return new OwnershipRegistry(root, services, libs);
}

async function discoverServices(cfg: ArchGraphConfig, root: string): Promise<ServiceManifest[]> {
    const appDirs = await fg(cfg.appsGlob, {
        cwd: root,
        onlyDirectories: true,
        absolute: true,
    });

    const out: ServiceManifest[] = [];
    for (const dir of appDirs) {
        const id = serviceIdFrom(root, dir);
        const tsconfigPath = pickFirstExisting(dir, [
            'tsconfig.app.json',
            'tsconfig.json',
            'tsconfig.lib.json',
        ]);
        const entryFile = pickFirstExisting(dir, ['src/main.ts', 'src/index.ts']);
        out.push({ id, rootDir: dir, tsconfigPath, entryFile });
    }
    return out.sort(byRootDirDesc);
}

async function discoverLibs(cfg: ArchGraphConfig, root: string): Promise<LibManifest[]> {
    if (!cfg.libsGlob) return [];
    // libsGlob can be "libs/**" — we want each leaf directory that has a tsconfig OR an index.ts.
    // First, find all dirs matching libsGlob; then prefer the most specific one for ownership.
    const libDirs = await fg(cfg.libsGlob, {
        cwd: root,
        onlyDirectories: true,
        absolute: true,
    });

    const out: LibManifest[] = [];
    for (const dir of libDirs) {
        // Treat dirs that look like package roots (tsconfig.json | src/index.ts | package.json)
        // as ownership boundaries.
        const isPackageRoot =
            existsSync(join(dir, 'tsconfig.json')) ||
            existsSync(join(dir, 'tsconfig.lib.json')) ||
            existsSync(join(dir, 'src', 'index.ts')) ||
            existsSync(join(dir, 'package.json'));
        if (!isPackageRoot) continue;
        const id = dir.replace(root + '/', '');
        out.push({ id, rootDir: dir });
    }
    // Most specific (deepest) first so findOwner matches sub-lib before parent.
    return out.sort(byRootDirDesc);
}

function pickFirstExisting(dir: string, files: string[]): string | null {
    for (const f of files) {
        const p = join(dir, f);
        if (existsSync(p)) return p;
    }
    return null;
}

function byRootDirDesc<T extends { rootDir: string }>(a: T, b: T): number {
    return b.rootDir.length - a.rootDir.length;
}

function serviceIdFrom(root: string, dir: string): string {
    return dir.replace(root + '/', '').replace(/^apps\//, '');
}
