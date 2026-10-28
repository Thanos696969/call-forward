import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Workspace packages ship TypeScript source, so bundle them; keep npm deps external.
  noExternal: [/^@relay\//],
  // Native addon: load from node_modules at runtime, never bundle.
  external: ['@node-rs/argon2'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
