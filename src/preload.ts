import { contextBridge, ipcRenderer } from 'electron';
import type { Desktop } from './protocol';

const desktop: Desktop = {
  open: () => ipcRenderer.invoke('open'),
  save: (source, as) => ipcRenderer.invoke('save', source, as),
  directory: () => ipcRenderer.invoke('directory'),
  hdl: (sources, options, lint) => ipcRenderer.invoke('hdl', sources, options, lint),
};
contextBridge.exposeInMainWorld('desktop', desktop);
