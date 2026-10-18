/**
 * Build pipeline.
 *   tsx scripts/build.ts               → CSS + client JS + server/scripts bundles into dist/
 *   tsx scripts/build.ts --assets-only → CSS + client JS only (used by `npm run dev`)
 *   tsx scripts/build.ts --watch       → rebuild assets when src/ changes
 *
 * Tailwind v4 is driven through its `compile()` API because the standalone CLI
 * (@tailwindcss/cli + oxide scanner) could not be installed in the build sandbox.
 * Class candidates are collected by a simple tokenizer over src/; Tailwind
 * ignores tokens that are not valid utilities.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { compile } from 'tailwindcss';

const root = process.cwd();
const require = createRequire(import.meta.url);
const args = new Set(process.argv.slice(2));
const assetsOnly = args.has('--assets-only') || args.has('--watch');
const prod = !assetsOnly || process.env.NODE_ENV === 'production';
const outAssets = path.join(root, 'dist/public/assets');

function walk(dir: string, exts: string[], out: string[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

function hash(data: string | Buffer) {
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 10);
}

function candidates(): Set<string> {
  const set = new Set<string>();
  for (const f of walk(path.join(root, 'src'), ['.ts', '.tsx'])) {
    const src = fs.readFileSync(f, 'utf8');
    for (const tok of src.split(/[\s"'`{}<>;]+/)) {
      if (tok.length > 1 && tok.length < 120 && /^[!a-z@\[-][\w\-:/.\[\]()%#&>=+*!@,]*$/i.test(tok)) set.add(tok.replace(/[.,)]+$/, ''));
    }
  }
  return set;
}

async function buildCss(): Promise<string> {
  const entry = path.join(root, 'src/styles/app.css');
  const input = fs.readFileSync(entry, 'utf8');
  const compiler = await compile(input, {
    base: path.dirname(entry),
    loadStylesheet: async (id: string, base: string) => {
      let file: string;
      if (id === 'tailwindcss') file = require.resolve('tailwindcss/index.css');
      else if (id.startsWith('tailwindcss/')) file = require.resolve(id.endsWith('.css') ? id : id + '.css');
      else file = path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, 'utf8') };
    },
    loadModule: async () => {
      throw new Error('Tailwind JS plugins/configs are not used in this project.');
    },
  } as Parameters<typeof compile>[1]);
  const css = compiler.build([...candidates()]);
  const out = await esbuild.transform(css, { loader: 'css', minify: prod, target: ['chrome110', 'safari16', 'firefox110'] });
  const name = `app-${hash(out.code)}.css`;
  fs.writeFileSync(path.join(outAssets, name), out.code);
  return name;
}

async function buildJs(): Promise<string> {
  const res = await esbuild.build({
    entryPoints: [path.join(root, 'src/client/entry.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome110', 'safari16', 'firefox110'],
    minify: prod,
    sourcemap: prod ? false : 'inline',
    write: false,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development') },
    legalComments: 'none',
  });
  const code = res.outputFiles[0].contents;
  const name = `app-${hash(Buffer.from(code))}.js`;
  fs.writeFileSync(path.join(outAssets, name), code);
  return name;
}

async function buildAssets() {
  const t = performance.now();
  fs.mkdirSync(outAssets, { recursive: true });
  const old = new Set(fs.readdirSync(outAssets));
  const [css, js] = await Promise.all([buildCss(), buildJs()]);
  fs.writeFileSync(path.join(outAssets, 'manifest.json'), JSON.stringify({ css, js }));
  for (const f of old) if (f !== css && f !== js && f !== 'manifest.json') fs.rmSync(path.join(outAssets, f), { force: true });
  console.log(`assets: ${css}, ${js} (${Math.round(performance.now() - t)} ms)`);
}

async function buildServer() {
  const entries: Record<string, string> = {
    server: 'src/server/index.ts',
    migrate: 'scripts/migrate.ts',
    seed: 'scripts/seed.ts',
    'create-admin': 'scripts/create-admin.ts',
  };
  await esbuild.build({
    entryPoints: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, path.join(root, v)])),
    outdir: path.join(root, 'dist'),
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    jsx: 'automatic',
    sourcemap: 'linked',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'warning',
  });
  console.log('server: dist/server.mjs, dist/migrate.mjs, dist/seed.mjs, dist/create-admin.mjs');
}

await buildAssets();
if (!assetsOnly) await buildServer();

if (args.has('--watch')) {
  let timer: NodeJS.Timeout | null = null;
  fs.watch(path.join(root, 'src'), { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => buildAssets().catch((e) => console.error(e)), 150);
  });
  console.log('watching src/ for asset changes…');
}
