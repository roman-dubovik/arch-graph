import { describe, expect, it } from 'vitest';
import { enumerateEndpointGroundTruth, validateEndpoints } from './endpoint-validator.js';
import type { ArchGraphConfig } from '../core/config.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Create a minimal ArchGraphConfig pointing at a temporary directory.
 */
async function makeTmpCfg(files: Record<string, string>): Promise<{ cfg: ArchGraphConfig; dir: string }> {
    const dir = join(tmpdir(), `arch-graph-ep-test-${Date.now()}`);
    await mkdir(join(dir, 'apps', 'myapp', 'src'), { recursive: true });

    for (const [name, content] of Object.entries(files)) {
        const dest = join(dir, 'apps', 'myapp', 'src', name);
        await writeFile(dest, content, 'utf8');
    }

    const cfg: ArchGraphConfig = {
        id: 'test',
        root: dir,
        appsGlob: 'apps/*',
    };
    return { cfg, dir };
}

async function cleanup(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
}

describe('enumerateEndpointGroundTruth', () => {
    it('returns empty for files with no HTTP method decorators', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'service.ts': `export class MyService { hello() {} }`,
        });
        try {
            const gt = await enumerateEndpointGroundTruth(cfg);
            expect(gt).toHaveLength(0);
        } finally {
            await cleanup(dir);
        }
    });

    it('detects @Get decorator', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'users.controller.ts': `
import { Controller, Get } from '@nestjs/common';
@Controller('users')
export class UsersController {
    @Get()
    findAll() { return []; }
}
`,
        });
        try {
            const gt = await enumerateEndpointGroundTruth(cfg);
            expect(gt.length).toBeGreaterThanOrEqual(1);
            expect(gt.some((e) => e.method === 'GET')).toBe(true);
        } finally {
            await cleanup(dir);
        }
    });

    it('detects all 9 HTTP method decorators', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'all.controller.ts': `
import { Controller, Get, Post, Put, Patch, Delete, All, Options, Head, Sse } from '@nestjs/common';
@Controller('base')
export class AllController {
    @Get() g() {}
    @Post() po() {}
    @Put() pu() {}
    @Patch() pa() {}
    @Delete() d() {}
    @All() al() {}
    @Options() op() {}
    @Head() h() {}
    @Sse('events') sse() {}
}
`,
        });
        try {
            const gt = await enumerateEndpointGroundTruth(cfg);
            expect(gt.length).toBe(9);
            const methods = new Set(gt.map((e) => e.method));
            expect(methods.has('GET')).toBe(true);
            expect(methods.has('POST')).toBe(true);
            expect(methods.has('SSE')).toBe(true);
        } finally {
            await cleanup(dir);
        }
    });
});

describe('validateEndpoints', () => {
    it('returns recall null when no ground truth', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'service.ts': `export class S {}`,
        });
        try {
            const result = await validateEndpoints(cfg, 0);
            expect(result.recall).toBeNull();
            expect(result.meetsFloor).toBe(true);
        } finally {
            await cleanup(dir);
        }
    });

    it('computes recall and meetsFloor correctly', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'ctrl.ts': `
import { Controller, Get, Post } from '@nestjs/common';
@Controller('x')
export class XCtrl {
    @Get() a() {}
    @Post() b() {}
}
`,
        });
        try {
            // extracted 2 = perfect recall
            const result = await validateEndpoints(cfg, 2);
            expect(result.groundTruthCount).toBe(2);
            expect(result.recall).toBeCloseTo(1.0);
            expect(result.meetsFloor).toBe(true);
        } finally {
            await cleanup(dir);
        }
    });

    it('meetsFloor false when recall < 0.95', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'ctrl.ts': `
import { Controller, Get, Post, Put, Patch, Delete, All, Options, Head, Sse } from '@nestjs/common';
@Controller('x')
export class XCtrl {
    @Get() a() {}
    @Post() b() {}
    @Put() c() {}
    @Patch() d() {}
    @Delete() e() {}
    @All() f() {}
    @Options() g() {}
    @Head() h() {}
    @Sse() i() {}
    @Get('extra') j() {}
    @Get('extra2') k() {}
    @Get('extra3') l() {}
    @Get('extra4') m() {}
    @Get('extra5') n() {}
    @Get('extra6') o() {}
    @Get('extra7') p() {}
    @Get('extra8') q() {}
    @Get('extra9') r() {}
    @Get('extra10') s() {}
    @Get('extra11') t() {}
}
`,
        });
        try {
            // 20 GT endpoints, only 1 extracted → recall = 0.05 → fails floor
            const result = await validateEndpoints(cfg, 1);
            expect(result.groundTruthCount).toBe(20);
            expect(result.recall).toBeCloseTo(0.05);
            expect(result.meetsFloor).toBe(false);
        } finally {
            await cleanup(dir);
        }
    });
});
