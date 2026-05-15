import { defineConfig } from '../src/index.js';

export default defineConfig({
    id: 'insyra',
    root: '/Users/romandubovik/Documents/Projects/insyra',
    appsGlob: 'apps/*',
    libsGlob: 'libs/**',
    excludeGlobs: ['/tmp/', '/.worktrees/'],
    nats: {
        wrapperPublishApis: [{ class: 'JetStreamService', methods: ['publish'] }],
        wrapperSubscribeApis: [{ class: 'JetStreamService', methods: ['subscribe'] }],
    },
});
