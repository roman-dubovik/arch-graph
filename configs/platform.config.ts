import { defineConfig } from '../src/index.js';

export default defineConfig({
    id: 'platform',
    root: '/Users/romandubovik/Documents/Projects/platform',
    appsGlob: 'apps/*',
    libsGlob: 'libs/**',
    excludeGlobs: ['/dist-poc/', '/.git/', '/cypress/'],
    nats: {
        wrapperPublishApis: [
            { class: 'PlatformConnectionService', methods: ['request', 'publish'] },
            { class: 'JetStreamService', methods: ['publish', 'request'] },
            { class: 'NatsService', methods: ['publish', 'request', 'subscribeWithReply'] },
        ],
        wrapperSubscribeApis: [
            { class: 'PlatformConnectionService', methods: ['handleRequest', 'subscribe'] },
            { class: 'JetStreamService', methods: ['subscribe'] },
            { class: 'NatsService', methods: ['subscribe', 'subscribeWithReply'] },
        ],
    },
});
