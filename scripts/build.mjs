import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'renderer'), { recursive: true });
await mkdir(join(out, 'execution'), { recursive: true });
const node = {
  bundle: true, platform: 'node', target: 'node24', format: 'cjs',
  packages: 'external', sourcemap: false,
  define: { 'import.meta.url': '__knotrailModuleURL' },
  banner: { js: 'const __knotrailModuleURL = require("node:url").pathToFileURL(__filename).href;' },
};
// These modules locate adjacent child-process entrypoints at runtime.
const processModules = {
  'execution/sandbox': '../execution/sandbox.cjs',
  'runtime/pi-runner': '../runtime/pi-runner.cjs',
};
await Promise.all([
  build({ ...node, absWorkingDir: root, entryPoints: ['src/desktop/main.ts'], outfile: join(out, 'desktop/main.cjs'),
    plugins: [{ name: 'child-process-modules', setup(builder) {
      builder.onResolve({ filter: /(?:execution\/sandbox|runtime\/pi-runner)\.js$/ }, args => {
        const key = Object.keys(processModules).find(name => args.path.endsWith(`${name}.js`));
        return key ? { path: processModules[key], external: true } : undefined;
      });
    } }],
  }),
  build({ absWorkingDir: root, entryPoints: ['src/desktop/preload.ts'], outfile: join(out, 'desktop/preload.cjs'), bundle: true, platform: 'node', target: 'node24', format: 'cjs', packages: 'external' }),
  ...['execution/sandbox', 'runtime/pi-runner'].map(name => build({ ...node, absWorkingDir: root, entryPoints: [`src/${name}.ts`], outfile: join(out, `${name}.cjs`) })),
  build({ absWorkingDir: root, entryPoints: ['src/runtime/pi-worker.ts'], outfile: join(out, 'runtime/pi-worker.mjs'), bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', sourcemap: false }),
  build({ absWorkingDir: root, entryPoints: ['src/renderer/main.tsx'], outfile: join(out, 'renderer/app.js'), bundle: true, platform: 'browser', format: 'esm', target: 'chrome140', minify: true, sourcemap: false, define: { 'process.env.NODE_ENV': '"production"' } }),
  cp(join(root, 'src/renderer/index.html'), join(out, 'renderer/index.html')),
  cp(join(root, 'src/execution/helper.mjs'), join(out, 'execution/helper.mjs')),
]);
console.log('Built desktop, pi worker, execution helper, and renderer in dist/');
