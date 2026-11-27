import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = resolve(rootDir, 'tests');

async function collectTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTestFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

const args = process.argv.slice(2);
const entryPoints = args.length
  ? args.map((arg) => resolve(rootDir, arg))
  : await collectTestFiles(testsDir);

if (!entryPoints.length) {
  console.error('No test files found.');
  process.exit(1);
}

const outDir = await mkdtemp(join(tmpdir(), 'gemini-projects-tests-'));
try {
  await build({
    entryPoints,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: 'inline',
    outbase: testsDir,
    outdir: outDir,
    outExtension: { '.js': '.mjs' },
    external: ['node:*']
  });

  const builtFiles = entryPoints.map((file) =>
    join(outDir, relative(testsDir, file).replace(/\.ts$/, '.mjs'))
  );

  const result = spawnSync(process.execPath, ['--test', ...builtFiles], {
    cwd: rootDir,
    stdio: 'inherit'
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outDir, { recursive: true, force: true });
}
