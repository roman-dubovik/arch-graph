import fg from 'fast-glob';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ProjectConfig } from './types.js';

export interface ServiceManifest {
    id: string;
    rootDir: string;
    tsconfigPath: string | null;
    entryFile: string | null;
}

export async function discoverServices(cfg: ProjectConfig): Promise<ServiceManifest[]> {
    const root = resolve(cfg.root);
    const appDirs = await fg(`${cfg.appsGlob}`, {
        cwd: root,
        onlyDirectories: true,
        absolute: true,
    });

    const out: ServiceManifest[] = [];
    for (const dir of appDirs) {
        const id = dir.replace(root + '/', '').replace(/^apps\//, '');
        const tsconfigPath = pickFirstExisting(dir, [
            'tsconfig.app.json',
            'tsconfig.json',
            'tsconfig.lib.json',
        ]);
        const entryFile = pickFirstExisting(dir, ['src/main.ts', 'src/index.ts']);
        out.push({ id, rootDir: dir, tsconfigPath, entryFile });
    }
    return out;
}

function pickFirstExisting(dir: string, files: string[]): string | null {
    for (const f of files) {
        const p = join(dir, f);
        if (existsSync(p)) return p;
    }
    return null;
}
