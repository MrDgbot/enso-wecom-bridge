import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'plugin/main.mjs',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
