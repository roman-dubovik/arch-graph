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
    http: {
        internalServices: [
            // saas-admin / infrastructure-proxy call NX_DEPLOYER_URL → deployer service.
            { id: 'deployer', envVars: ['NX_DEPLOYER_URL'] },
            // Frontend SDKs reference NX_API_BASE_URL / NX_PLATFORM_API_URL — point to platform-api.
            { id: 'platform-api', envVars: ['NX_API_BASE_URL', 'NX_PLATFORM_API_URL'] },
            // Central enrollment URL used by agents.
            { id: 'platform-central', envVars: ['NX_CENTRAL_URL', 'CENTRAL_URL'] },
        ],
    },
});
