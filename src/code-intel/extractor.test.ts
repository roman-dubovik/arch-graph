import { describe, expect, it } from 'vitest';

import { inMemoryProject } from '../__fixtures__/in-memory-project.js';
import { extractCodeIntel } from './extractor.js';
import {
    explainBranch,
    explainDataFlow,
    getBlueprint,
    getFileOutline,
    impactContract,
    resolveSymbol,
    traceScenario,
} from './queries.js';

describe('extractCodeIntel', () => {
    it('extracts DTOs, provider methods, calls, flows, branches, and impact facts', () => {
        const project = inMemoryProject({
            '/root/apps/api/src/items.controller.ts': `
                import { Body, Controller, Post } from '@nestjs/common';
                import { ItemsService } from './items.service';
                import { CreateItemDto } from './item.dto';

                /** HTTP API for item creation. */
                @Controller('/items')
                export class ItemsController {
                    constructor(private readonly service: ItemsService) {}

                    /** Creates an item when enabled. */
                    @Post('/create')
                    async create(@Body() dto: CreateItemDto): Promise<ItemDto | null> {
                        if (dto.enabled) {
                            return this.service.create(dto);
                        }
                        return null;
                    }
                }
            `,
            '/root/apps/api/src/items.service.ts': `
                import { CreateItemDto } from './item.dto';
                import { ItemMapper } from './item.mapper';
                import { normalizeItem as normalizeImported } from './normalize-item';
                import { join } from 'node:path';
                import { stat } from 'node:fs/promises';
                import { Node } from 'ts-morph';

                /** Owns item persistence orchestration. */
                export class ItemsService {
                    constructor(private readonly mapper: ItemMapper) {}

                    async create(dto: CreateItemDto) {
                        const { name } = dto;
                        const normalized = normalizeImported(name);
                        const path = join('items', normalized);
                        const adapter = makeAdapter();
                        const st = await stat(path);
                        Node.isIdentifier(dto as never);
                        if (st.isFile()) adapter.load(path);
                        process.stdout.write(path);
                        this.mapper.audit(name);
                        return this.mapper.toEntity(dto);
                    }
                }

                class LocalAdapter {
                    load(path: string) {
                        return path;
                    }
                }

                function makeAdapter(): LocalAdapter {
                    return new LocalAdapter();
                }
            `,
            '/root/apps/api/src/normalize-item.ts': `
                export function normalizeItem(name: string) {
                    return name.trim().toLowerCase();
                }
            `,
            '/root/apps/api/src/item.mapper.ts': `
                import { CreateItemDto } from './item.dto';
                export class ItemMapper {
                    audit(name: string) {
                        return name;
                    }

                    toEntity(dto: CreateItemDto) {
                        return { name: dto.name };
                    }
                }
            `,
            '/root/apps/api/src/item.dto.ts': `
                /** Payload used to create an item. */
                export class CreateItemDto {
                    /** Display name. */
                    name!: string;
                    enabled?: boolean;
                }

                export interface ItemResult {
                    id: string;
                    name: string;
                }
            `,
            '/root/apps/api/src/item.result.consumer.ts': `
                import { ItemResult } from './item.dto';
                export function consumeResult(result: ItemResult) {
                    return result.id;
                }
            `,
            '/root/apps/api/src/items.controller.spec.ts': `
                import { CreateItemDto } from './item.dto';
                describe('ItemsController', () => {
                    it('uses CreateItemDto', () => undefined as unknown as CreateItemDto);
                });
            `,
            '/root/apps/api/src/typed-receivers.ts': `
                import type { SourceFile, Node } from 'ts-morph';

                export function inspectSource(sf: SourceFile, node: Node) {
                    sf.getClasses();
                    node.getKind();
                }
            `,
        });

        const index = extractCodeIntel(project, { root: '/root' });

        expect(resolveSymbol(index, 'CreateItemDto').matches[0]).toMatchObject({
            kind: 'dto',
            fqn: 'CreateItemDto',
            description: 'Payload used to create an item.',
        });
        expect(resolveSymbol(index, 'ItemsController.create').matches[0]).toMatchObject({
            kind: 'method',
            fqn: 'ItemsController.create',
            signature: expect.stringContaining('dto: CreateItemDto'),
            description: 'Creates an item when enabled.',
        });

        expect(index.symbols.some((s) => s.kind === 'field' && s.fqn === 'CreateItemDto.name')).toBe(true);
        expect(index.calls).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    caller: 'ItemsController.create',
                    callee: 'ItemsService.create',
                    args: ['dto'],
                }),
                expect.objectContaining({
                    caller: 'ItemsService.create',
                    callee: 'ItemMapper.toEntity',
                    args: ['dto'],
                }),
            ]),
        );

        expect(index.flows).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    target: 'ItemsController.create',
                    param: 'dto',
                    sourceKind: 'http',
                    source: '@Body dto',
                    to: 'ItemsService.create',
                    toParam: 'dto',
                }),
                expect.objectContaining({
                    target: 'ItemsService.create',
                    param: 'dto',
                    sourceKind: 'param',
                    source: 'dto',
                    to: 'ItemMapper.toEntity',
                    toParam: 'dto',
                }),
            ]),
        );

        expect(index.branches).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    functionName: 'ItemsController.create',
                    condition: 'dto.enabled',
                    calls: ['ItemsService.create'],
                }),
            ]),
        );

        expect(explainBranch(index, { file: 'apps/api/src/items.controller.ts', line: 13 }).branches[0]).toMatchObject({
            condition: 'dto.enabled',
            thenText: expect.stringContaining('this.service.create(dto)'),
            calls: ['ItemsService.create'],
        });

        expect(traceScenario(index, { entry: 'ItemsController.create' }).calls.map((c) => c.callee)).toEqual([
            'ItemsService.create',
            'normalizeItem',
            'makeAdapter',
            'LocalAdapter.load',
            'ItemMapper.audit',
            'ItemMapper.toEntity',
        ]);

        const impact = impactContract(index, { symbol: 'CreateItemDto' });
        expect(impact.impacts.map((i) => i.kind)).toEqual(
            expect.arrayContaining(['endpoint', 'type-reference', 'test']),
        );

        expect(impactContract(index, { symbol: 'ItemResult' }).impacts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'type-reference', symbol: 'ItemResult' }),
                expect.objectContaining({ kind: 'field-reference', symbol: 'ItemResult', field: 'id' }),
            ]),
        );
    });

    it('extracts impacts in frontend components', () => {
        const project = inMemoryProject({
            '/root/apps/web/src/components/ItemCard.tsx': `
                import { ItemResult } from '../../../../libs/api/item.dto';
                export const ItemCard = ({ item }: { item: ItemResult }) => {
                    return <div>{item.name}</div>;
                };
            `,
            '/root/libs/api/item.dto.ts': `
                export interface ItemResult {
                    id: string;
                    name: string;
                }
            `,
        });

        const index = extractCodeIntel(project, { root: '/root' });
        const impact = impactContract(index, { symbol: 'ItemResult' });

        expect(impact.impacts).toContainEqual(
            expect.objectContaining({
                kind: 'type-reference',
                file: 'apps/web/src/components/ItemCard.tsx',
            }),
        );

        expect(impact.impacts).toContainEqual(
            expect.objectContaining({
                kind: 'field-reference',
                field: 'name',
                file: 'apps/web/src/components/ItemCard.tsx',
            }),
        );
    });

    it('extracts switch statements and ternary operators as branches', () => {
        const project = inMemoryProject({
            '/root/app.ts': `
                export class App {
                    process(status: string, val: number) {
                        const x = val > 10 ? this.high() : this.low();
                        switch (status) {
                            case 'open':
                                this.onOpen();
                                break;
                            case 'closed':
                                this.onClosed();
                                break;
                            default:
                                this.onDefault();
                        }
                    }
                    high() {}
                    low() {}
                    onOpen() {}
                    onClosed() {}
                    onDefault() {}
                }
            `,
        });

        const index = extractCodeIntel(project, { root: '/root' });

        // Ternary check
        expect(index.branches).toContainEqual(
            expect.objectContaining({
                functionName: 'App.process',
                condition: 'val > 10',
                calls: expect.arrayContaining(['App.high', 'App.low']),
            }),
        );

        // Switch checks (one branch per case/default)
        expect(index.branches).toContainEqual(
            expect.objectContaining({
                functionName: 'App.process',
                condition: "status === 'open'",
                calls: ['App.onOpen'],
            }),
        );
        expect(index.branches).toContainEqual(
            expect.objectContaining({
                functionName: 'App.process',
                condition: "status === 'closed'",
                calls: ['App.onClosed'],
            }),
        );
        expect(index.branches).toContainEqual(
            expect.objectContaining({
                functionName: 'App.process',
                condition: 'status default',
                calls: ['App.onDefault'],
            }),
        );
    });

    it('extracts throw and catch as branches', () => {
        const project = inMemoryProject({
            '/root/app.ts': `
                export class App {
                    save(data: any) {
                        try {
                            if (!data) throw new Error('No data');
                            this.persist(data);
                        } catch (e) {
                            this.logError(e);
                        }
                    }
                    persist(d: any) {}
                    logError(e: any) {}
                }
            `,
        });

        const index = extractCodeIntel(project, { root: '/root' });

        // Throw check
        expect(index.branches).toContainEqual(
            expect.objectContaining({
                functionName: 'App.save',
                condition: "throw new Error('No data')",
            }),
        );

        // Catch check
        expect(index.branches).toContainEqual(
            expect.objectContaining({
                functionName: 'App.save',
                condition: 'catch (e)',
                calls: ['App.logError'],
            }),
        );
    });

    it('captures nested conditions in nestedIn field', () => {
        const project = inMemoryProject({
            '/root/app.ts': `
                export class App {
                    test(a: number, b: number) {
                        if (a > 0) {
                            if (b > 0) {
                                this.both();
                            }
                        }
                    }
                    both() {}
                }
            `,
        });

        const index = extractCodeIntel(project, { root: '/root' });

        expect(index.branches).toContainEqual(
            expect.objectContaining({
                condition: 'b > 0',
                nestedIn: ['a > 0'],
            }),
        );
    });

    it('captures nested conditions across different branching types', () => {
        const project = inMemoryProject({
            '/root/app.ts': `
                export class App {
                    test(status: string, val: number) {
                        switch (status) {
                            case 'open':
                                if (val > 0) {
                                    this.onOpenHigh();
                                }
                                break;
                        }
                    }
                    onOpenHigh() {}
                }
            `,
        });

        const index = extractCodeIntel(project, { root: '/root' });

        expect(index.branches).toContainEqual(
            expect.objectContaining({
                condition: 'val > 0',
                nestedIn: ["status === 'open'"],
            }),
        );
    });

    it('extracts else and else-if branches with negated conditions', () => {
        const project = inMemoryProject({
            '/root/app.ts': `
                export class App {
                    test(a: number) {
                        if (a > 10) {
                            this.high();
                        } else if (a > 5) {
                            this.medium();
                        } else {
                            this.low();
                        }
                    }
                    high() {}
                    medium() {}
                    low() {}
                }
            `,
        });

        const index = extractCodeIntel(project, { root: '/root' });

        // If branch
        expect(index.branches).toContainEqual(
            expect.objectContaining({
                condition: 'a > 10',
                calls: ['App.high'],
            }),
        );

        // Else-if branch
        expect(index.branches).toContainEqual(
            expect.objectContaining({
                condition: 'a > 5',
                nestedIn: ['!(a > 10)'],
                calls: ['App.medium'],
            }),
        );

        // Else branch
        expect(index.branches).toContainEqual(
            expect.objectContaining({
                condition: 'else',
                nestedIn: ['!(a > 10)', '!(a > 5)'],
                calls: ['App.low'],
            }),
        );
    });

    it('handles nested else branches correctly', () => {
        const project = inMemoryProject({
            '/root/app.ts': `
                export class App {
                    test(a: number, b: number) {
                        if (a > 0) {
                            if (b > 0) {
                                this.both();
                            } else {
                                this.onlyA();
                            }
                        }
                    }
                    both() {}
                    onlyA() {}
                }
            `,
        });

        const index = extractCodeIntel(project, { root: '/root' });

        expect(index.branches).toContainEqual(
            expect.objectContaining({
                condition: 'else',
                nestedIn: ['a > 0', '!(b > 0)'],
                calls: ['App.onlyA'],
            }),
        );
    });

    it('categorizes sources and sinks in data flows', () => {
        const project = inMemoryProject({
            '/root/app.ts': `
                import { Body, Controller, Post } from '@nestjs/common';
                @Controller()
                export class App {
                    @Post()
                    async save(@Body() data: any) {
                        const apiKey = process.env.API_KEY;
                        this.logger.log(data);
                        await this.db.save(data);
                    }
                }
            `,
        });

        const index = extractCodeIntel(project, { root: '/root' });

        // Source categorization (HTTP Body)
        expect(index.flows).toContainEqual(
            expect.objectContaining({
                param: 'data',
                sourceKind: 'http',
                source: '@Body data',
            }),
        );

        // Sink categorization (Log)
        expect(index.flows).toContainEqual(
            expect.objectContaining({
                param: 'data',
                sinkKind: 'log',
                to: 'this.logger.log',
            }),
        );

        // Sink categorization (DB)
        expect(index.flows).toContainEqual(
            expect.objectContaining({
                param: 'data',
                sinkKind: 'db',
                to: 'this.db.save',
            }),
        );

        // Env source
        expect(index.flows).toContainEqual(
            expect.objectContaining({
                param: 'apiKey',
                sourceKind: 'env',
                via: 'apiKey = process.env.API_KEY',
            }),
        );
    });

    it('ranks data flows preferring sinks', () => {
        const project = inMemoryProject({
            '/root/app.ts': `
                export class App {
                    process(data: any) {
                        this.logger.log(data);
                        this.db.save(data);
                    }
                }
            `,
        });

        const index = extractCodeIntel(project, { root: '/root' });
        const result = explainDataFlow(index, { target: 'App.process', param: 'data' });

        // DB sink (rank 0) should be before log sink (rank 5)
        expect(result.flows[0]).toMatchObject({ sinkKind: 'db' });
        expect(result.flows[1]).toMatchObject({ sinkKind: 'log' });
    });

    it('resolves calls with complex DI and typed receivers', () => {
        const project = inMemoryProject({
            '/root/app.ts': `
                import { Injectable, Inject } from '@nestjs/common';
                import { UsersService } from './users.service';

                @Injectable()
                export class App {
                    private readonly internal = new InternalService();

                    constructor(
                        private readonly users: UsersService,
                        @Inject('API_CLIENT') private readonly client: any
                    ) {}

                    async run() {
                        await this.users.find();
                        this.internal.doWork();
                        this.client.post();
                    }
                }

                class InternalService {
                    doWork() {}
                }
            `,
            '/root/users.service.ts': `
                export class UsersService {
                    find() {}
                }
            `,
        });

        const index = extractCodeIntel(project, { root: '/root' });
        const calls = index.calls.filter((c) => c.caller === 'App.run');

        expect(calls).toContainEqual(
            expect.objectContaining({
                callee: 'UsersService.find',
                kind: 'internal',
            }),
        );

        expect(calls).toContainEqual(
            expect.objectContaining({
                callee: 'InternalService.doWork',
                kind: 'internal',
            }),
        );

        // For @Inject('TOKEN') any, we should now see the token in callee
        expect(calls).toContainEqual(
            expect.objectContaining({
                callee: 'API_CLIENT.post',
                expression: 'this.client.post',
            }),
        );
    });

    it('captures conditions for each call', () => {
        const project = inMemoryProject({
            '/root/app.ts': `
                export class App {
                    process(status: string) {
                        if (status === 'open') {
                            this.handleOpen();
                        }
                    }
                    handleOpen() {}
                }
            `,
        });

        const index = extractCodeIntel(project, { root: '/root' });
        const call = index.calls.find((c) => c.callee === 'App.handleOpen');

        expect(call).toMatchObject({
            conditions: ["status === 'open'"],
        });
    });

    it('traces scenarios with condition stacks', () => {
        const project = inMemoryProject({
            '/root/app.ts': `
                export class App {
                    run(a: number) {
                        if (a > 0) {
                            this.doA();
                        } else {
                            this.doB();
                        }
                    }
                    doA() {
                        this.finish();
                    }
                    doB() {}
                    finish() {}
                }
            `,
        });

        const index = extractCodeIntel(project, { root: '/root' });
        const result = traceScenario(index, { entry: 'App.run' });

        expect(result.calls).toContainEqual(
            expect.objectContaining({
                callee: 'App.doA',
                conditions: ['a > 0'],
            }),
        );
        expect(result.calls).toContainEqual(
            expect.objectContaining({
                callee: 'App.doB',
                conditions: ['!(a > 0)'],
            }),
        );
        expect(result.calls).toContainEqual(
            expect.objectContaining({
                callee: 'App.finish',
                conditions: ['a > 0'],
            }),
        );
    });

    it('extracts endLine for classes and methods', () => {
        const project = inMemoryProject({
            '/root/app.ts': `
                export class App {
                    run() {
                        const x = 1;
                    }
                }
            `,
        });

        const index = extractCodeIntel(project, { root: '/root' });
        const appClass = index.symbols.find((s) => s.name === 'App');
        const runMethod = index.symbols.find((s) => s.name === 'run');

        expect(appClass).toMatchObject({
            line: 2,
            endLine: 6,
        });
        expect(runMethod).toMatchObject({
            line: 3,
            endLine: 5,
        });
    });

    it('P0: provides a complete outline with precise ranges for surgical reads', () => {
        const project = inMemoryProject({
            '/root/complex.ts': `
                import { Injectable } from '@nestjs/common';

                /**
                 * Main application class.
                 */
                @Injectable()
                export class ComplexApp {
                    // Property with comment
                    private state = 1;

                    /**
                     * Entry point.
                     */
                    async run(data: string): Promise<void> {
                        console.log(data);

                        if (data) {
                            return this.finish();
                        }
                    }

                    private finish() {
                        return;
                    }
                }
            `,
        });

        const index = extractCodeIntel(project, { root: '/root' });
        const outline = getFileOutline(index, { file: 'complex.ts' });

        expect(outline.symbols).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: 'ComplexApp',
                    kind: 'class',
                    line: 7,
                    endLine: 26,
                }),
                expect.objectContaining({
                    name: 'run',
                    kind: 'method',
                    line: 15,
                    endLine: 21,
                }),
                expect.objectContaining({
                    name: 'finish',
                    kind: 'method',
                    line: 23,
                    endLine: 25,
                }),
                expect.objectContaining({
                    name: 'state',
                    kind: 'field',
                    line: 10,
                    endLine: 10,
                }),
            ]),
        );

        // Verify ordering
        const names = outline.symbols.map((s) => s.name);
        expect(names.indexOf('ComplexApp')).toBeLessThan(names.indexOf('run'));
        expect(names.indexOf('run')).toBeLessThan(names.indexOf('finish'));
    });

    it('infers project policies from symbol patterns', () => {
        const project = inMemoryProject({
            '/root/src/dto/1.dto.ts': 'export class OneDto {}',
            '/root/src/dto/2.dto.ts': 'export class TwoDto {}',
            '/root/src/dto/3.dto.ts': 'export class ThreeDto {}',
            '/root/src/dto/4.dto.ts': 'export class FourDto {}',
            '/root/src/dto/5.dto.ts': 'export class FiveDto {}',
            '/root/src/entities/item.entity.ts': `
                export class Item {
                    @ManyToOne() @CustomFK() field1: any;
                    @ManyToOne() @CustomFK() field2: any;
                    @ManyToOne() @CustomFK() field3: any;
                    @ManyToOne() @CustomFK() field4: any;
                    @ManyToOne() field5: any;
                }
            `,
        });

        const index = extractCodeIntel(project, { root: '/root' });

        // Placement policy
        expect(index.policies).toContainEqual(
            expect.objectContaining({
                kind: 'placement',
                rule: 'DTO location: src/dto/*.ts',
            }),
        );

        // Decorator pairing policy
        expect(index.policies).toContainEqual(
            expect.objectContaining({
                kind: 'decorator-pairing',
                rule: 'When using @ManyToOne, also use @CustomFK',
            }),
        );
    });
});
