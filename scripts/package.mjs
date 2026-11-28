import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { archiveLinux } from './linux-archive.mjs';
import { copyLibraries } from './windows-libraries.mjs';
import { readReleaseNotes, writeReleaseNotes } from './release-notes.mjs';

const { values } = parseArgs({ options: {
  platform: { type: 'string', default: process.platform },
  toolchain: { type: 'string', default: process.env.VERILOG_IDE_TOOLCHAIN },
  'toolchain-archive': { type: 'string' },
  'electron-zips': { type: 'string', default: 'runtime' },
} });
const platform = values.platform;
if (!['win32', 'linux'].includes(platform)) throw new Error('Supported targets are win32 and linux (x64).');
const crossArchive = platform === 'linux' && values['toolchain-archive'];
if (!crossArchive && !values.toolchain) throw new Error('Pass --toolchain <OSS CAD Suite directory> or a Linux --toolchain-archive <tarball>.');
if (!crossArchive && platform === 'linux' && process.platform !== 'linux') throw new Error('Pass --toolchain-archive when building the Linux archive from Windows.');
const require = createRequire(import.meta.url);
const version = require('../package.json').version;
const notes = await readReleaseNotes(version);
const electronVersion = require('electron/package.json').version;
const filename = `electron-v${electronVersion}-${platform}-x64.zip`;
const solution = resolve(values.toolchain ?? '.');
const bins = ['yosys', 'yosys-abc', 'slang'].map(name => platform === 'win32' ? name + '.exe' : name);
if (!crossArchive) await Promise.all(bins.map(name => access(join(solution, 'bin', name))));

const run = promisify(execFile);
const zip = join(resolve(values['electron-zips']), filename);
await mkdir(resolve(values['electron-zips']), { recursive: true });
try {
  await access(zip);
} catch {
  const url = `https://github.com/electron/electron/releases/download/v${electronVersion}/${filename}`;
  await run('curl', ['--fail', '--location', '--retry', '2', '--silent', '--show-error', '--output', zip, url]);
}
const expected = require('electron/checksums.json')[filename];
const hash = createHash('sha256');
for await (const chunk of createReadStream(zip)) hash.update(chunk);
if (!expected || hash.digest('hex') !== expected) throw new Error('Electron ZIP checksum mismatch.');

const release = resolve('release');
await mkdir(release, { recursive: true });
const name = `Verilog-IDE-${version}-${platform}-x64`;
const output = crossArchive ? join(resolve('runtime'), name + '-staging') : join(release, name);
await mkdir(resolve('runtime'), { recursive: true });
// Refuse to overwrite an earlier release so it can be kept for comparison.
await mkdir(output);
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
if (process.platform === 'win32') await run(tar, ['-xf', zip, '-C', output]);
else await run('unzip', ['-q', zip, '-d', output]);
const windows = platform === 'win32';
await rename(join(output, windows ? 'electron.exe' : 'electron'), join(output, windows ? 'Verilog IDE.exe' : 'verilog-ide'));
const resources = join(output, 'resources');
await rm(join(resources, 'default_app.asar'), { force: true });
const app = join(resources, 'app');
await mkdir(app);
await cp('dist', join(app, 'dist'), { recursive: true });
await cp('package.json', join(app, 'package.json'));
await cp('README.md', join(output, 'README.md'));
await cp('README.en.md', join(output, 'README.en.md'));
await cp('CHANGELOG.en.md', join(output, 'CHANGELOG.en.md'));
await cp('LICENSE', join(output, 'LICENSE'));
await writeFile(join(output, 'CHANGELOG.md'), notes);

const archive = join(release, name + (windows ? '.zip' : '.tar.gz'));
if (crossArchive) {
  await archiveLinux(archive, name, output, resolve(crossArchive));
  console.log(await writeReleaseNotes(release, version, notes));
  console.log(archive);
  process.exit(0);
}

const destination = join(resources, 'toolchain');
await mkdir(join(destination, 'bin'), { recursive: true });
await Promise.all(bins.map(file => cp(join(solution, 'bin', file), join(destination, 'bin', file), { verbatimSymlinks: true })));
await cp(join(solution, 'share', 'yosys'), join(destination, 'share', 'yosys'), { recursive: true, verbatimSymlinks: true });
await cp(join(solution, 'license'), join(destination, 'license'), { recursive: true });
const copyMatching = async (source, target, match) => {
  const entries = (await readdir(source)).filter(name => match.test(name));
  await mkdir(target, { recursive: true });
  await Promise.all(entries.map(file => cp(join(source, file), join(target, file), { recursive: true, verbatimSymlinks: true })));
};
if (windows) {
  await copyLibraries(solution, bins, join(destination, 'bin'));
  await copyMatching(join(solution, 'lib'), join(destination, 'lib'), /^tcl\d/);
} else {
  await copyMatching(join(solution, 'lib'), join(destination, 'lib'), /\.so(?:\.|$)|^tcl\d/);
  await copyMatching(join(solution, 'share'), join(destination, 'share'), /^tcl\d/);
  try {
    await access(join(solution, 'libexec'));
    await copyMatching(join(solution, 'libexec'), join(destination, 'libexec'), /^(yosys|yosys-abc|slang)$/);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
await run(tar, [windows ? '-acf' : '-czf', archive, '-C', release, basename(output)]);
console.log(await writeReleaseNotes(release, version, notes));
console.log(archive);
