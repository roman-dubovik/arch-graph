import { defineConfig } from '../src/index.js';

export default defineConfig({
    id: 'beribuy2',
    root: '/Users/romandubovik/Documents/Projects/beribuy/beribuy-2.0',
    appsGlob: 'apps/*',
    libsGlob: 'libs/**',
    excludeGlobs: ['/.worktrees/'],
    domains: { bullmq: false },
});
