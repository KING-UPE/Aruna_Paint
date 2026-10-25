import { defineConfig } from 'tsup';

// One bundled file for the shop server; @aruna/shared is inlined, npm packages stay external.
export default defineConfig({
  entry: ['src/index.ts', 'src/scripts/seed.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: ['@aruna/shared'],
});
