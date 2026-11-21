import { readFile, readdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

// Read the import table of a PE image to select the redistributable DLLs that
// the chosen toolchain executables and their dependencies actually require.
function imports(buffer) {
  const pe = buffer.readUInt32LE(60);
  if (buffer.toString('ascii', pe, pe + 4) !== 'PE\0\0') return [];
  const optional = pe + 24;
  const sectionCount = buffer.readUInt16LE(pe + 6);
  const sectionStart = optional + buffer.readUInt16LE(pe + 20);
  const directoryOffset = buffer.readUInt16LE(optional) === 0x20b ? 112 : 96;
  const importsRva = buffer.readUInt32LE(optional + directoryOffset + 8);
  const offset = rva => {
    for (let index = 0; index < sectionCount; index++) {
      const section = sectionStart + index * 40;
      const address = buffer.readUInt32LE(section + 12);
      const length = buffer.readUInt32LE(section + 16);
      if (rva >= address && rva < address + length) return buffer.readUInt32LE(section + 20) + rva - address;
    }
    return -1;
  };
  const names = [];
  if (!importsRva) return names;
  for (let descriptor = offset(importsRva); descriptor >= 0 && descriptor + 20 < buffer.length; descriptor += 20) {
    const name = offset(buffer.readUInt32LE(descriptor + 12));
    if (name < 0) break;
    const end = buffer.indexOf(0, name);
    if (end < 0) break;
    names.push(buffer.toString('ascii', name, end));
  }
  return names;
}

export async function copyLibraries(root, executables, destination) {
  const available = new Map();
  for (const directory of ['lib', 'bin']) {
    const path = join(root, directory);
    for (const file of await readdir(path)) if (/\.dll$/i.test(file)) available.set(file.toLowerCase(), join(path, file));
  }
  const queue = executables.map(name => join(root, 'bin', name));
  const seen = new Set();
  for (const executable of queue) for (const file of imports(await readFile(executable))) {
    const lower = file.toLowerCase();
    const path = available.get(lower);
    if (!path || seen.has(lower)) continue;
    seen.add(lower);
    queue.push(path);
    await copyFile(path, join(destination, file));
  }
}
