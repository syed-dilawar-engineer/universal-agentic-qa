import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  clean: true,
  dts: false,
  sourcemap: true,
  noExternal: [/^@agentic-qa\//],
  external: ['playwright', 'playwright-core', 'fsevents'],
  banner: {
    js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
  },
});
