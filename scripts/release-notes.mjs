import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function versionSection(changelog, version, filename) {
  const lines = changelog.split(/\r?\n/);
  const heading = '## v' + version;
  const start = lines.findIndex(line => line.trimEnd() === heading);
  if (start === -1) throw new Error(`Add a ${heading} section to ${filename}.`);
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  if (lines.slice(end).some(line => line.trimEnd() === heading)) throw new Error(`Duplicate ${heading} section in ${filename}.`);
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) throw new Error(`Fill in the ${heading} section in ${filename}.`);
  return body;
}

export function releaseNotes(chinese, english, version) {
  const zh = versionSection(chinese, version, 'CHANGELOG.md');
  const en = versionSection(english, version, 'CHANGELOG.en.md');
  return `# Verilog IDE v${version}\n\n${zh}\n\n---\n\n${en}\n`;
}

export async function readReleaseNotes(version) {
  const [chinese, english] = await Promise.all([
    readFile('CHANGELOG.md', 'utf8'),
    readFile('CHANGELOG.en.md', 'utf8'),
  ]);
  return releaseNotes(chinese, english, version);
}

// Windows and Linux packaging can finish concurrently in the same directory.
export async function writeReleaseNotes(directory, version, notes) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, `Verilog-IDE-${version}-更新日志.md`);
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, notes);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  console.log(await writeReleaseNotes('release', version, await readReleaseNotes(version)));
}
