import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import type { ArchGraphConfig } from '../../core/config.js';
import { extractNats } from './extractor.js';

function projectWithFile(filePath: string, source: string): Project {
    const project = new Project({
        useInMemoryFileSystem: true,
        skipAddingFilesFromTsConfig: true,
    });
    project.createSourceFile(filePath, source);
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
});
