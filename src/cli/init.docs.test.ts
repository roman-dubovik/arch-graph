import { describe, it, expect } from 'vitest';
import { buildConfigTemplate } from './init.js';

function makeAnswers(overrides: Partial<{
    docs: {
        respectGitignore: boolean;
        chunkTokens: number;
        userInclude: string[];
        userExclude: string[];
    };
}>) {
    return {
        projectId: 'demo',
        repoRoot: '/tmp',
        appsGlob: 'apps/*',
        libsGlob: 'libs/*',
        domains: [],
        natsWrapper: false,
        natsWrapperClass: '',
        natsWrapperPublishMethods: [],
        natsWrapperSubscribeMethods: [],
        installClaude: false,
        hookMode: 'none' as const,
        strictMode: false,
        runBuild: false,
        semanticStrategy: 'both-buckets' as const,
        snippetTarget: 'separate' as const,
        ...overrides,
    };
}

describe('init — docs block in config template', () => {
    it('emits docs.include with user-curated extras', () => {
        const answers = makeAnswers({
            docs: {
                respectGitignore: true,
                chunkTokens: 100,
                userInclude: ['docs/adr/0001-foo.md'],
                userExclude: ['tools/scripts/HOWTO.md'],
            },
        });
        const tpl = buildConfigTemplate(answers);
        expect(tpl).toContain('docs:');
        expect(tpl).toContain("'docs/adr/0001-foo.md'");
        expect(tpl).toContain("'tools/scripts/HOWTO.md'");
        expect(tpl).toContain('chunkTokens: 100');
        expect(tpl).toContain('respectGitignore: true');
    });

    it('omits docs block entirely when answers.docs is undefined', () => {
        const answers = makeAnswers({});
        const tpl = buildConfigTemplate(answers);
        expect(tpl.includes('docs:')).toBe(false);
    });
});
