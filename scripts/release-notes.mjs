import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = '## v' + version;
  const start = lines.findIndex(line => line.trimEnd() === heading);
  if (start === -1) throw new Error(`请先在 CHANGELOG.md 中添加 ${heading} 并记录本版实际改动。`);
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  if (lines.slice(end).some(line => line.trimEnd() === heading)) throw new Error(`CHANGELOG.md 中有重复的 ${heading}。`);
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) throw new Error(`请在 CHANGELOG.md 的 ${heading} 下填写本版实际改动。`);
  return `# Verilog IDE v${version} 更新日志\n\n${body}\n`;
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
  const changelog = await readFile('CHANGELOG.md', 'utf8');
  console.log(await writeReleaseNotes('release', version, releaseNotes(changelog, version)));
}
