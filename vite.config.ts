import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  // Relative asset URLs so the built bundle works from a subdirectory
  // (GitHub Pages project sites) or straight off the filesystem.
  base: './',
  build: {
    target: 'es2022',
  },
  server: {
      host: true,
      allowedHosts: true,
  },
  test: {
    projects: [
      {
        // Engine, protocol and session: no DOM, no framework.
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/lib/**/*.test.ts'],
        },
      },
      {
        // Component tests need Svelte's client build, which only the browser
        // export condition resolves.
        extends: true,
        resolve: { conditions: ['browser'] },
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.dom.test.ts'],
        },
      },
    ],
  },
});
