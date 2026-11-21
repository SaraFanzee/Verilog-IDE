import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat, rename } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { pipeline, finished } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import tar from 'tar-stream';

function neededToolFile(name) {
  return name === 'VERSION' || /^(?:bin|libexec)\/(?:slang|yosys|yosys-abc)$/.test(name)
    || /^(?:share\/yosys|(?:share|lib)\/tcl[\d.]*|license)(?:\/|$)/.test(name)
    || /^lib\/[^/]+\.so(?:\.[^/]*)?$/.test(name);
}

// Read the Linux toolchain directly from its tarball, preserving Unix metadata
// on Windows hosts where kernel file permissions and symlinks differ.
export async function archiveLinux(archive, rootName, appDirectory, toolchainArchive) {
  const pack = tar.pack();
  const partial = archive + '.part';
  const writing = pipeline(pack, createGzip({ level: 5 }), createWriteStream(partial, { flags: 'wx' }));
  writing.catch(() => {});
  async function addApp(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = posix.join(prefix, entry.name);
      if (entry.isDirectory()) await addApp(path, name);
      else if (entry.isFile()) {
        const size = (await stat(path)).size;
        const executable = ['verilog-ide', 'chrome-sandbox', 'chrome_crashpad_handler'].includes(entry.name);
        await pipeline(createReadStream(path), pack.entry({ name, size, mode: executable ? 0o755 : 0o644 }));
      }
    }
  }
  try {
    await addApp(appDirectory, rootName);
    const extract = tar.extract();
    const reading = pipeline(createReadStream(toolchainArchive), createGunzip(), extract);
    reading.catch(() => {});
    const found = new Set();
    for await (const entry of extract) {
      const original = entry.header;
      const relative = original.name.replace(/^\.\//, '').replace(/^oss-cad-suite\//, '').replace(/\/$/, '');
      if (!neededToolFile(relative)) {
        entry.resume();
        await finished(entry);
        continue;
      }
      const header = { ...original, name: posix.join(rootName, 'resources', 'toolchain', relative), uid: 0, gid: 0, uname: 'root', gname: 'root' };
      if (header.type === 'link' && header.linkname?.replace(/^\.\//, '').startsWith('oss-cad-suite/')) {
        header.linkname = posix.join(rootName, 'resources', 'toolchain', header.linkname.replace(/^(?:\.\/)?oss-cad-suite\//, ''));
      }
      // Drop source PAX path overrides so archive names reflect the new root.
      delete header.pax;
      await pipeline(entry, pack.entry(header));
      found.add(relative);
    }
    await reading;
    for (const name of ['bin/yosys', 'bin/yosys-abc', 'bin/slang', 'share/yosys/techlibs/common/techmap.v']) {
      if (name.includes('techlibs') && (found.has('share/yosys/techmap.v') || found.has(name))) continue;
      if (!found.has(name)) throw new Error(`Linux toolchain archive is missing ${name}.`);
    }
    pack.finalize();
    await writing;
    await rename(partial, archive);
  } catch (error) {
    pack.destroy(error);
    await writing.catch(() => {});
    throw error;
  }
}
