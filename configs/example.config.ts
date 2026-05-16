import { defineConfig } from 'arch-graph';

export default defineConfig({
    id: 'my-project',          // becomes `service:my-project` in graph
    root: '.',                 // path to your NestJS monorepo root
    appsGlob: 'apps/*',        // where services live
    libsGlob: 'libs/**',       // where shared libs live

    // Custom NATS wrapper API (if you wrap @nestjs/microservices in your own class):
    nats: {
        wrapperPublishApis: [
            // { class: 'MyNatsService', methods: ['publish', 'request'] },
        ],
        wrapperSubscribeApis: [
            // { class: 'MyNatsService', methods: ['subscribe'] },
        ],
    },

    // Domain toggles (default: all enabled)
    // domains: {
    //     bullmq: false,        // disable BullMQ if not used in this project
    //     http: false,
    // },
});
