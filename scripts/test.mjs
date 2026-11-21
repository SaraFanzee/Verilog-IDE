import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const output = '.test-output/suite.mjs';
try {
  await build({ entryPoints: ['test/suite.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm' });
  await import(pathToFileURL(resolve(output)).href);
} finally {
  await rm(output, { force: true });
}
