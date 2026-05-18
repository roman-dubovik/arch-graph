// arch-graph.config.ts — self-build configuration for public bench
// This tells arch-graph to index its OWN source code (TypeScript tool, not NestJS).
// NestJS-specific domains are disabled since arch-graph itself has no NATS/TypeORM/etc.

export default {
    id: 'arch-graph',
    root: '.',
    // arch-graph source lives in src/ with no apps/libs split.
    // Using src/ as the "app" so ts-morph picks up all TypeScript files.
    appsGlob: 'src',
    // No libs glob needed — everything is flat under src/
    libsGlob: undefined,
    excludeGlobs: [
        '/__fixtures__/',
        '.test.',
        '.spec.',
    ],
    // Disable NestJS-specific domains — arch-graph has none of these patterns
    domains: {
        nats: false,
        typeorm: false,
        bullmq: false,
        di: false,
        http: false,
        // Keep imports — arch-graph has TS imports throughout src/
        imports: true,
        fe: false,
        endpoint: false,
        config: true,
        dbEntityFields: false,
    },
    // Docs: scan all .md files tracked by git
    docs: {
        include: ['**/*.md'],
        exclude: ['node_modules/**', 'docs/comparisons/**'],
        respectGitignore: true,
    },
};
