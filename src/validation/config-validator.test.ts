import { describe, expect, it } from 'vitest';
import { enumerateConfigGroundTruth, validateConfig } from './config-validator.js';
import type { ArchGraphConfig } from '../core/config.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function makeTmpCfg(files: Record<string, string>): Promise<{ cfg: ArchGraphConfig; dir: string }> {
    const dir = join(tmpdir(), `arch-graph-cfg-test-${Date.now()}`);
    await mkdir(join(dir, 'apps', 'myapp', 'src'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        await writeFile(join(dir, 'apps', 'myapp', 'src', name), content, 'utf8');
    }
    const cfg: ArchGraphConfig = { id: 'test', root: dir, appsGlob: 'apps/*' };
    return { cfg, dir };
}

async function cleanup(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
}

describe('enumerateConfigGroundTruth', () => {
    it('returns empty when no configService or process.env', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'service.ts': `export class MyService { hello() {} }`,
        });
        try {
            const gt = await enumerateConfigGroundTruth(cfg);
            expect(gt).toHaveLength(0);
        } finally {
            await cleanup(dir);
        }
    });

    it('detects configService.get(...)', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'auth.service.ts': `
export class AuthService {
    constructor(private configService) {}
    getSecret() { return this.configService.get('JWT_SECRET'); }
}
`,
        });
        try {
            const gt = await enumerateConfigGroundTruth(cfg);
            expect(gt.some((e) => e.kind === 'configService')).toBe(true);
        } finally {
            await cleanup(dir);
        }
    });

    it('detects configService.getOrThrow(...)', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'db.service.ts': `
export class DbService {
    constructor(private configService) {}
    getUrl() { return this.configService.getOrThrow('DATABASE_URL'); }
}
`,
        });
        try {
            const gt = await enumerateConfigGroundTruth(cfg);
            expect(gt.some((e) => e.kind === 'configService')).toBe(true);
        } finally {
            await cleanup(dir);
        }
    });

    it('detects process.env.KEY', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'env.ts': `
const port = process.env.PORT ?? '3000';
const nodeEnv = process.env.NODE_ENV;
`,
        });
        try {
            const gt = await enumerateConfigGroundTruth(cfg);
            expect(gt.length).toBeGreaterThanOrEqual(2);
            expect(gt.every((e) => e.kind === 'process.env')).toBe(true);
        } finally {
            await cleanup(dir);
        }
    });

    it('detects both kinds in the same file', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'mixed.service.ts': `
export class MixedService {
    constructor(private configService) {}
    run() {
        const a = this.configService.get('KEY_A');
        const b = process.env.KEY_B;
        return { a, b };
    }
}
`,
        });
        try {
            const gt = await enumerateConfigGroundTruth(cfg);
            expect(gt.some((e) => e.kind === 'configService')).toBe(true);
            expect(gt.some((e) => e.kind === 'process.env')).toBe(true);
        } finally {
            await cleanup(dir);
        }
    });

    it('ignores commented-out callsites', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'commented.service.ts': `
export class CS {
    constructor(private configService) {}
    run() {
        // return this.configService.get('COMMENTED_OUT');
        return null;
    }
}
`,
        });
        try {
            const gt = await enumerateConfigGroundTruth(cfg);
            expect(gt).toHaveLength(0);
        } finally {
            await cleanup(dir);
        }
    });
});

describe('validateConfig', () => {
    it('returns recall null when no ground truth', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'service.ts': `export class S {}`,
        });
        try {
            const result = await validateConfig(cfg, 0);
            expect(result.recall).toBeNull();
            expect(result.meetsFloor).toBe(true);
        } finally {
            await cleanup(dir);
        }
    });

    it('computes recall correctly', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'svc.ts': `
export class Svc {
    constructor(private configService) {}
    a() { return this.configService.get('A'); }
    b() { return this.configService.getOrThrow('B'); }
}
`,
        });
        try {
            // 2 GT callsites, extracted 2 → recall 1.0
            const result = await validateConfig(cfg, 2);
            expect(result.groundTruthCount).toBe(2);
            expect(result.recall).toBeCloseTo(1.0);
            expect(result.meetsFloor).toBe(true);
        } finally {
            await cleanup(dir);
        }
    });

    it('meetsFloor false when recall < 0.90', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'svc.ts': `
export class Svc {
    constructor(private configService) {}
    a() { return this.configService.get('A'); }
    b() { return this.configService.getOrThrow('B'); }
    c() { return this.configService.get('C'); }
    d() { return this.configService.get('D'); }
    e() { return this.configService.get('E'); }
    f() { return this.configService.get('F'); }
    g() { return this.configService.get('G'); }
    h() { return this.configService.get('H'); }
    i() { return this.configService.get('I'); }
    j() { return this.configService.get('J'); }
    k() { return this.configService.get('K'); }
}
`,
        });
        try {
            // 11 GT callsites, extracted 0 → recall 0 → fails floor
            const result = await validateConfig(cfg, 0);
            expect(result.groundTruthCount).toBe(11);
            expect(result.recall).toBe(0);
            expect(result.meetsFloor).toBe(false);
        } finally {
            await cleanup(dir);
        }
    });
});
