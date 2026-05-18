import { describe, expect, it } from 'vitest';
import {
    enumerateDbEntityFieldsGroundTruth,
    buildDbEntityFieldsReport,
    validateDbEntityFields,
} from './db-entity-fields-validator.js';
import type { ArchGraphConfig } from '../core/config.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function makeTmpCfg(files: Record<string, string>): Promise<{ cfg: ArchGraphConfig; dir: string }> {
    const dir = join(tmpdir(), `arch-graph-dbef-test-${Date.now()}`);
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

describe('enumerateDbEntityFieldsGroundTruth', () => {
    it('returns empty for files with no column decorators', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'service.ts': `export class MyService { hello() {} }`,
        });
        try {
            const gt = await enumerateDbEntityFieldsGroundTruth(cfg);
            expect(gt).toHaveLength(0);
        } finally {
            await cleanup(dir);
        }
    });

    it('detects @Column decorator', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'user.entity.ts': `
import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';
@Entity()
export class UserEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    name: string;
}
`,
        });
        try {
            const gt = await enumerateDbEntityFieldsGroundTruth(cfg);
            expect(gt.length).toBeGreaterThanOrEqual(2);
            expect(gt.some((e) => e.decorator === 'Column')).toBe(true);
            expect(gt.some((e) => e.decorator === 'PrimaryGeneratedColumn')).toBe(true);
        } finally {
            await cleanup(dir);
        }
    });

    it('detects all 6 column decorator types', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'all.entity.ts': `
import { Entity, Column, PrimaryColumn, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, DeleteDateColumn } from 'typeorm';
@Entity()
export class AllEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @PrimaryColumn()
    code: string;

    @Column()
    name: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    @DeleteDateColumn()
    deletedAt: Date;
}
`,
        });
        try {
            const gt = await enumerateDbEntityFieldsGroundTruth(cfg);
            expect(gt.length).toBe(6);
            const decorators = new Set(gt.map((e) => e.decorator));
            expect(decorators.has('Column')).toBe(true);
            expect(decorators.has('PrimaryColumn')).toBe(true);
            expect(decorators.has('PrimaryGeneratedColumn')).toBe(true);
            expect(decorators.has('CreateDateColumn')).toBe(true);
            expect(decorators.has('UpdateDateColumn')).toBe(true);
            expect(decorators.has('DeleteDateColumn')).toBe(true);
        } finally {
            await cleanup(dir);
        }
    });

    it('ignores commented-out decorators', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'commented.entity.ts': `
import { Entity } from 'typeorm';
@Entity()
export class CommentedEntity {
    // @Column()
    // name: string;
    /* @PrimaryGeneratedColumn() */
    /* id: number; */
}
`,
        });
        try {
            const gt = await enumerateDbEntityFieldsGroundTruth(cfg);
            expect(gt).toHaveLength(0);
        } finally {
            await cleanup(dir);
        }
    });

    it('returns correct file and line metadata', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'meta.entity.ts': `
import { Entity, Column } from 'typeorm';
@Entity()
export class MetaEntity {
    @Column()
    title: string;
}
`,
        });
        try {
            const gt = await enumerateDbEntityFieldsGroundTruth(cfg);
            expect(gt.length).toBeGreaterThanOrEqual(1);
            const col = gt.find((e) => e.decorator === 'Column');
            expect(col).toBeDefined();
            expect(col!.file).toContain('meta.entity.ts');
            expect(col!.line).toBeGreaterThan(0);
            expect(col!.matchedText).toContain('@Column');
        } finally {
            await cleanup(dir);
        }
    });
});

describe('buildDbEntityFieldsReport', () => {
    it('returns recall null when ground truth is empty', () => {
        const result = buildDbEntityFieldsReport(0, []);
        expect(result.recall).toBeNull();
        expect(result.meetsFloor).toBe(true);
        expect(result.groundTruthCount).toBe(0);
    });

    it('computes recall=1 for perfect extraction', () => {
        const gt = [
            { file: 'a.ts', line: 5, matchedText: '@Column(', decorator: 'Column' },
            { file: 'a.ts', line: 8, matchedText: '@PrimaryGeneratedColumn(', decorator: 'PrimaryGeneratedColumn' },
        ];
        const result = buildDbEntityFieldsReport(2, gt);
        expect(result.groundTruthCount).toBe(2);
        expect(result.recall).toBeCloseTo(1.0);
        expect(result.meetsFloor).toBe(true);
    });

    it('caps recall at 1 when extractedCount > groundTruth', () => {
        const gt = [{ file: 'a.ts', line: 5, matchedText: '@Column(', decorator: 'Column' }];
        const result = buildDbEntityFieldsReport(10, gt);
        expect(result.recall).toBeCloseTo(1.0);
        expect(result.meetsFloor).toBe(true);
    });

    it('meetsFloor true at exactly 0.95', () => {
        // 19 extracted / 20 GT = 0.95
        const gt = Array.from({ length: 20 }, (_, i) => ({
            file: 'a.ts', line: i + 1, matchedText: '@Column(', decorator: 'Column',
        }));
        const result = buildDbEntityFieldsReport(19, gt);
        expect(result.recall).toBeCloseTo(0.95);
        expect(result.meetsFloor).toBe(true);
    });

    it('meetsFloor false when recall < 0.95', () => {
        // 1 extracted / 20 GT = 0.05 → fails floor
        const gt = Array.from({ length: 20 }, (_, i) => ({
            file: 'a.ts', line: i + 1, matchedText: '@Column(', decorator: 'Column',
        }));
        const result = buildDbEntityFieldsReport(1, gt);
        expect(result.recall).toBeCloseTo(0.05);
        expect(result.meetsFloor).toBe(false);
    });

    it('meetsFloor false when extractedCount is 0 and groundTruth > 0', () => {
        const gt = [{ file: 'a.ts', line: 5, matchedText: '@Column(', decorator: 'Column' }];
        const result = buildDbEntityFieldsReport(0, gt);
        expect(result.recall).toBe(0);
        expect(result.meetsFloor).toBe(false);
    });
});

describe('validateDbEntityFields', () => {
    it('returns recall null when no ground truth decorators exist', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'service.ts': `export class S {}`,
        });
        try {
            const result = await validateDbEntityFields(cfg, 0);
            expect(result.recall).toBeNull();
            expect(result.meetsFloor).toBe(true);
        } finally {
            await cleanup(dir);
        }
    });

    it('computes recall correctly from a real file', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'user.entity.ts': `
import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';
@Entity()
export class UserEntity {
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    email: string;

    @Column()
    name: string;
}
`,
        });
        try {
            // 3 GT entries (PrimaryGeneratedColumn + 2x Column), extracted 3 → recall 1.0
            const result = await validateDbEntityFields(cfg, 3);
            expect(result.groundTruthCount).toBe(3);
            expect(result.recall).toBeCloseTo(1.0);
            expect(result.meetsFloor).toBe(true);
        } finally {
            await cleanup(dir);
        }
    });

    it('meetsFloor false when many columns missed', async () => {
        const { cfg, dir } = await makeTmpCfg({
            'big.entity.ts': `
import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';
@Entity()
export class BigEntity {
    @PrimaryGeneratedColumn() id: number;
    @Column() a: string;
    @Column() b: string;
    @Column() c: string;
    @Column() d: string;
    @Column() e: string;
    @Column() f: string;
    @Column() g: string;
    @Column() h: string;
    @Column() i: string;
    @Column() j: string;
    @Column() k: string;
    @Column() l: string;
    @Column() m: string;
    @Column() n: string;
    @Column() o: string;
    @Column() p: string;
    @Column() q: string;
    @Column() r: string;
    @Column() s: string;
}
`,
        });
        try {
            // 20 GT entries, only 1 extracted → recall = 0.05 → fails floor
            const result = await validateDbEntityFields(cfg, 1);
            expect(result.groundTruthCount).toBe(20);
            expect(result.recall).toBeCloseTo(0.05);
            expect(result.meetsFloor).toBe(false);
        } finally {
            await cleanup(dir);
        }
    });
});
