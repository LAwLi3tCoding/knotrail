import { contextBridge, ipcRenderer } from 'electron';
import type { AppCommand, CommandResult, DesktopAPI } from '../shared/contracts.js';

const bridge: DesktopAPI = {
  command: <T = CommandResult>(command: AppCommand): Promise<T> => ipcRenderer.invoke('knotrail:command', command),
  subscribe(listener) {
    const receive = (_event: Electron.IpcRendererEvent, event: { taskId?: string; seq?: number; kind: string }) => listener(event);
    ipcRenderer.on('knotrail:event', receive);
    return () => ipcRenderer.removeListener('knotrail:event', receive);
  },
  chooseProject: () => ipcRenderer.invoke('knotrail:choose-project'),
  exportReport: taskId => ipcRenderer.invoke('knotrail:export-report', taskId),
};
contextBridge.exposeInMainWorld('knotrail', bridge);
