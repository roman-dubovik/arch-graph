import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import type { ArchGraphConfig } from '../../core/config.js';
import { extractNats } from './extractor.js';

function projectWithFile(filePath: string, source: string): Project {
    return projectWithFiles({ [filePath]: source });
}

function projectWithFiles(files: Record<string, string>): Project {
    const project = new Project({
        useInMemoryFileSystem: true,
        skipAddingFilesFromTsConfig: true,
    });
    for (const [filePath, source] of Object.entries(files)) {
        project.createSourceFile(filePath, source);
    }
    return project;
}

const BASE_CFG: ArchGraphConfig = {
    id: 'test',
    root: '/repo',
    appsGlob: 'apps/*',
};

describe('extractNats', () => {
    it('extracts configured custom decorator subscribers as nats-subscribe edges', async () => {
        const project = projectWithFile(
            '/repo/apps/audit/src/handler.ts',
            `
            function NatsMessagePattern(_pattern: string): MethodDecorator {
                return () => undefined;
            }

            class AuditEventsController {
                @NatsMessagePattern('ROLL_FORWARD_ENGAGEMENT')
                handleRollForward() {}
            }
            `,
        );

        const sites = await extractNats(
            {
                ...BASE_CFG,
                nats: { subscribeDecorators: ['NatsMessagePattern'] },
            },
            project,
        );

        expect(sites).toHaveLength(1);
        expect(sites[0]).toMatchObject({
            role: 'receiver',
            edgeKind: 'nats-subscribe',
            via: '@NatsMessagePattern',
            enclosingClass: 'AuditEventsController',
            subject: { kind: 'literal', value: 'ROLL_FORWARD_ENGAGEMENT' },
        });
    });

    it('ignores custom decorators until they are configured', async () => {
        const project = projectWithFile(
            '/repo/apps/audit/src/handler.ts',
            `
            function NatsMessagePattern(_pattern: string): MethodDecorator {
                return () => undefined;
            }

            class AuditEventsController {
                @NatsMessagePattern('ROLL_FORWARD_ENGAGEMENT')
                handleRollForward() {}
            }
            `,
        );

        const sites = await extractNats(BASE_CFG, project);

        expect(sites).toHaveLength(0);
    });

    it('resolves Nest command object subjects from the cmd property', async () => {
        const project = projectWithFile(
            '/repo/apps/bff/src/engagement.service.ts',
            `
            enum EAuditServiceCmd {
                CREATE_ENGAGEMENT = 'CREATE_ENGAGEMENT',
            }
            class ClientProxy { send(_pattern: unknown, _payload: unknown) {} }
            class EngagementService {
                constructor(private readonly client: ClientProxy) {}
                create() {
                    return this.client.send({ cmd: EAuditServiceCmd.CREATE_ENGAGEMENT }, {});
                }
            }
            `,
        );

        const sites = await extractNats(BASE_CFG, project);

        expect(sites).toHaveLength(1);
        expect(sites[0]).toMatchObject({
            role: 'sender',
            edgeKind: 'nats-request',
            subject: { kind: 'literal', value: 'CREATE_ENGAGEMENT' },
            enclosingClass: 'EngagementService',
        });
    });

    it('resolves this.property command subjects declared on the same class', async () => {
        const project = projectWithFile(
            '/repo/apps/bff/src/component.service.ts',
            `
            enum EAuditServiceCmd {
                GET_COMPONENTS = 'GET_COMPONENTS',
            }
            class ClientProxy { send(_pattern: unknown, _payload: unknown) {} }
            class ComponentService {
                private readonly getEntitiesCmd = EAuditServiceCmd.GET_COMPONENTS;
                constructor(private readonly client: ClientProxy) {}
                list() {
                    return this.client.send(this.getEntitiesCmd, {});
                }
            }
            `,
        );

        const sites = await extractNats(BASE_CFG, project);

        expect(sites).toHaveLength(1);
        expect(sites[0]).toMatchObject({
            role: 'sender',
            edgeKind: 'nats-request',
            subject: { kind: 'literal', value: 'GET_COMPONENTS' },
            enclosingClass: 'ComponentService',
        });
    });

    it('expands base-class this.property command subjects using subclass overrides', async () => {
        const project = projectWithFiles({
            '/repo/libs/shared/src/base.service.ts': `
            enum EAuditServiceCmd {
                GET_COMPONENTS = 'GET_COMPONENTS',
                GET_AREAS = 'GET_AREAS',
            }
            class ClientProxy { send(_pattern: unknown, _payload: unknown) {} }
            abstract class BaseBffPersistentService {
                protected abstract readonly getEntitiesCmd: string;
                constructor(protected readonly client: ClientProxy) {}
                list() {
                    return this.client.send(this.getEntitiesCmd, {});
                }
            }
            `,
            '/repo/apps/bff/src/component.service.ts': `
            enum EAuditServiceCmd {
                GET_COMPONENTS = 'GET_COMPONENTS',
                GET_AREAS = 'GET_AREAS',
            }
            abstract class BaseBffPersistentService {}
            class ComponentService extends BaseBffPersistentService {
                protected override readonly getEntitiesCmd = EAuditServiceCmd.GET_COMPONENTS;
            }
            `,
            '/repo/apps/bff/src/area.service.ts': `
            enum EAuditServiceCmd {
                GET_COMPONENTS = 'GET_COMPONENTS',
                GET_AREAS = 'GET_AREAS',
            }
            abstract class BaseBffPersistentService {}
            class AreaService extends BaseBffPersistentService {
                protected override readonly getEntitiesCmd = EAuditServiceCmd.GET_AREAS;
            }
            `,
        });

        const sites = await extractNats(BASE_CFG, project);
        const subjects = sites
            .map((s) => s.subject)
            .filter((s): s is Extract<typeof s, { kind: 'literal' }> => s.kind === 'literal')
            .map((s) => s.value)
            .sort();

        expect(subjects).toEqual(['GET_AREAS', 'GET_COMPONENTS']);
        expect(sites.every((s) => s.enclosingClass !== 'BaseBffPersistentService')).toBe(true);
    });
});
