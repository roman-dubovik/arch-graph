import { defineConfig } from '../src/index.js';

export default defineConfig({
    id: 'unpacks',
    root: '/Users/romandubovik/Documents/Projects/unpacks/unpacks-nx',
    appsGlob: 'apps/*',
    libsGlob: 'libs/**',
    excludeGlobs: ['/tmp/'],
});
