import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hdlJob } from './backend';
import type { Desktop, Source } from './protocol';

const filters = [{ name: 'HDL', extensions: ['v', 'sv', 'vh', 'svh'] }];
protocol.registerSchemesAsPrivileged([{ scheme: 'verilog-ide', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function message<K extends keyof Desktop>(name: K, handler: Desktop[K]) {
  ipcMain.handle(name, (event, ...args: Parameters<Desktop[K]>) => {
    if (event.senderFrame?.url !== 'verilog-ide://workbench/index.html') throw new Error('Unexpected IPC sender');
    return (handler as (...args: Parameters<Desktop[K]>) => ReturnType<Desktop[K]>)(...args);
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle('verilog-ide', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'workbench' || !/^\/[\w.-]+\.(html|css|js|ttf|map|png)$/.test(url.pathname)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(join(__dirname, url.pathname.slice(1))).href);
  });
  const window = new BrowserWindow({
    width: 1480, height: 950, minWidth: 950, minHeight: 650,
    backgroundColor: '#13171e',
    title: 'Verilog IDE',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#171d26', symbolColor: '#e7edf5', height: 32 },
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isComposing || input.alt) return;
    if (input.key === 'F11' && !input.control && !input.meta && !input.shift) {
      event.preventDefault();
      if (!input.isAutoRepeat) window.setFullScreen(!window.isFullScreen());
      return;
    }
    if (!(process.platform === 'darwin' ? input.meta : input.control)) return;
    const contents = window.webContents;
    switch (input.key) {
      case '+': case '=': contents.setZoomLevel(contents.getZoomLevel() + 0.5); break;
      case '-': contents.setZoomLevel(contents.getZoomLevel() - 0.5); break;
      case '0': contents.setZoomLevel(0); break;
      default: return;
    }
    event.preventDefault();
  });
  message('open', async () => {
    const { filePaths } = await dialog.showOpenDialog(window, { properties: ['openFile', 'multiSelections'], filters });
    return Promise.all(filePaths.map(async path => ({ id: randomUUID(), name: basename(path), path, text: await readFile(path, 'utf8') })));
  });
  message('save', async (source: Source, as: boolean) => {
    const path = (!as && source.path) || (await dialog.showSaveDialog(window, { defaultPath: source.path ?? source.name, filters })).filePath;
    if (path) await writeFile(path, source.text, 'utf8');
    return path;
  });
  message('directory', async () => (await dialog.showOpenDialog(window, { properties: ['openDirectory'] })).filePaths[0]);
  message('hdl', (sources, options, lint) => hdlJob(sources, options, lint, join(process.resourcesPath, 'toolchain')));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  void window.loadURL('verilog-ide://workbench/index.html');
});

app.on('window-all-closed', () => app.quit());
