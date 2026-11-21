import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, delimiter, parse } from 'node:path';
import type { BuildOptions, BuildResult, Diagnostic, Netlist, Source } from './protocol';

function run(executable: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; log: string }>((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd, env: environment, windowsHide: true });
    let log = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('HDL 工具超过 45 秒，已终止。'));
    }, 45_000);
    const receive = (data: string) => {
      log += data;
      if (log.length > 2_000_000) {
        child.kill();
        reject(new Error('HDL 工具输出超过 2 MB，已终止。'));
      }
    };
    child.stdout.setEncoding('utf8').on('data', receive);
    child.stderr.setEncoding('utf8').on('data', receive);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); resolveRun({ code, log }); });
  });
}

// Slang expands a command file with its own argument parser. This keeps paths
// containing spaces out of the Yosys command parser.
function quote(value: string) {
  if (/[";\r\n\0\\]/.test(value)) throw new Error('综合选项含不支持的字符。');
  return `"${value}"`;
}

function buildScript(options: BuildOptions, files: string[], includes: string[], lint: boolean) {
  const { standard, top, mode, hierarchy, optimize, abc, observe, defines, parameters } = options;
  if (!['1364-2005', '1800-2017', '1800-2023'].includes(standard)) throw new Error('不支持的语言版本。');
  if (top && !/^[\w$]+$/.test(top)) throw new Error('顶层模块需为常规 HDL 标识符。');
  const read = ['--std', standard];
  if (lint) read.push('--lint-only');
  if (top && !lint) read.push('--top', top);
  if (hierarchy && !lint) read.push('--best-effort-hierarchy');
  for (const directory of includes) read.push('-I', quote(directory.replaceAll('\\', '/')));
  for (const define of defines) read.push('-D', quote(define));
  if (!lint) for (const parameter of parameters) read.push('-G', quote(parameter));
  read.push(...files.map(quote));
  const args = read.join('\n');
  const commands = ['read_slang -F inputs.f'];
  if (lint) return { args, script: commands[0] };
  commands.push('hierarchy -check -auto-top', 'proc', 'write_json source.json');
  if (observe) commands.push('setattr -set keep 1 w:*');
  if (mode === 'gate') {
    // Relative ABC scratch paths work with spaces and '#' in user profiles.
    // The parent job directory owns cleanup of all scratch files.
    if (abc) commands.push('scratchpad -set abc.nocleanup 1');
    // Preserve source-encoded state registers when source observation is enabled.
    commands.push(`synth${abc ? '' : ' -noabc'}${observe ? ' -nofsm' : ''}`);
  }
  else {
    commands.push('memory_map');
    if (optimize) commands.push('opt -keepdc');
  }
  commands.push(...(options.extraCommands ?? []), 'write_json design.json');
  return { args, script: commands.join('\n') };
}

function overlayPath(path: string) {
  const root = parse(path).root;
  const drive = root.replace(/[^a-z0-9]/gi, '_');
  return join('src', drive, path.slice(root.length));
}

function diagnostics(log: string, files: Map<string, Source>) {
  const result: Diagnostic[] = [];
  const lines = log.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const match = /^(.+?):(\d+):(?:(\d+):)?\s+(error|warning|note):\s+(.+)$/i.exec(line.trim());
    if (!match) continue;
    const file = match[1].replaceAll('\\', '/');
    const source = files.get(file) ?? [...files].find(([name]) => file.endsWith('/' + name))?.[1];
    if (source) result.push({
      id: source.id, line: Number(match[2]), column: Number(match[3]) || Math.max(1, (lines[index + 2]?.indexOf('^') ?? -1) + 1),
      severity: match[4].toLowerCase() as Diagnostic['severity'], message: match[5],
    });
  }
  return result;
}

export async function hdlJob(sources: Source[], options: BuildOptions, lint: boolean, packagedRoot?: string): Promise<BuildResult> {
  let workspace: string | undefined;
  try {
    workspace = await mkdtemp(join(tmpdir(), 'verilog-ide-'));
    const executableName = process.platform === 'win32' ? 'yosys.exe' : 'yosys';
    const root = packagedRoot && existsSync(join(packagedRoot, 'bin', executableName))
      ? packagedRoot : process.env.VERILOG_IDE_TOOLCHAIN;
    const executableFile = lint ? (process.platform === 'win32' ? 'slang.exe' : 'slang') : executableName;
    const executable = root ? join(resolve(root), 'bin', executableFile) : executableFile;
    const environment = { ...process.env };
    if (root) {
      for (const key of Object.keys(environment)) if (key.toUpperCase() === 'PATH') delete environment[key];
      environment.PATH = [join(root, 'bin'), ...(process.platform === 'win32' ? [join(root, 'lib')] : []), process.env.PATH].join(delimiter);
    }
    const files = new Map<string, Source>();
    const includes = new Set(options.includes);
    const inputs: string[] = [];
    for (const [index, source] of sources.entries()) {
      const relative = (source.path ? overlayPath(source.path) : join('scratch', basename(source.name)))
        .replaceAll('\\', '/');
      if (files.has(relative)) throw new Error(`文件名重复：${source.name}`);
      const path = join(workspace, relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source.text, 'utf8');
      files.set(relative, source);
      if (source.path) {
        files.set(source.path.replaceAll('\\', '/'), source);
        includes.add(dirname(source.path));
      } else if (!source.name) throw new Error(`文件 ${index + 1} 缺少名称。`);
      if (!/\.(svh|vh)$/i.test(source.name)) inputs.push(relative);
    }
    if (!inputs.length) return { ok: false, log: '请打开或新建 HDL 源文件。', diagnostics: [] };
    const { args, script } = buildScript(options, inputs, [...includes], lint);
    await writeFile(join(workspace, 'job.ys'), script, 'utf8');
    await writeFile(join(workspace, 'inputs.f'), args, 'utf8');
    const { code, log } = await run(executable, lint ? ['-F', 'inputs.f'] : ['-Q', '-T', '-s', 'job.ys'], workspace, environment);
    const result: BuildResult = { ok: code === 0, log: log || (code === 0 ? '' : `HDL 工具退出状态：${code}`), diagnostics: diagnostics(log, files) };
    if (!lint) result.log = `[job.ys]\n${script}\n\n[inputs.f]\n${args}\n\n${result.log}`;
    if (!result.ok || lint) return result;
    result.netlist = JSON.parse(await readFile(join(workspace, 'design.json'), 'utf8')) as Netlist;
    result.sourceNetlist = JSON.parse(await readFile(join(workspace, 'source.json'), 'utf8')) as Netlist;
    result.top = Object.keys(result.netlist.modules).find(name => /1$/.test(result.netlist!.modules[name].attributes?.top ?? ''));
    if (!result.top) throw new Error('网表没有顶层模块。请指定顶层模块。');
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, log: message.includes('ENOENT') ? '找不到 HDL 工具。开发运行需要带 read_slang 的 Yosys 和独立 slang，可通过 VERILOG_IDE_TOOLCHAIN 指定目录。\n' + message : message, diagnostics: [] };
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}
