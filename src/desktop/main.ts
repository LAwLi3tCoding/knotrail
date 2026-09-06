import { app, BrowserWindow, dialog, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron';
import { constants, existsSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, fstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createAppService } from '../core/service.js';
import { acquireOwnerLock } from '../execution/lock.js';
import { sandboxCapability } from '../execution/sandbox.js';
import type { OwnerLock } from '../execution/contracts.js';

let mainWindow: BrowserWindow | undefined;
let service: ReturnType<typeof createAppService> | undefined;
let owner: OwnerLock | undefined;
let quitting = false;
let shutdownComplete = false;
const rendererPath = resolve(__dirname, '../renderer/index.html');
const rendererURL = pathToFileURL(rendererPath).href;

function trustedSender(event: IpcMainInvokeEvent) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== rendererURL) {
    throw new Error('Untrusted application frame');
  }
}

/** The renderer can replace a key but can never retrieve it. */
function secretStore(dataDir: string) {
  const path = join(dataDir, 'model-key.enc');
  const requireEncryption = () => {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('Secure credential storage is unavailable. Unlock the operating system keychain and retry.');
    }
  };
  return {
    get(): string | undefined {
      if (!existsSync(path)) return undefined;
      requireEncryption();
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!fstatSync(fd).isFile()) throw new Error('Credential storage is not a regular file');
        return safeStorage.decryptString(readFileSync(fd));
      } catch { throw new Error('Could not decrypt the saved model key. Save a new key in Settings.'); }
      finally { closeSync(fd); }
    },
    set(value: string) {
      if (!value) { rmSync(path, { force: true }); return; }
      requireEncryption();
      const temporary = join(dataDir, `.model-key-${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, safeStorage.encryptString(value), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, path);
      } finally { rmSync(temporary, { force: true }); }
    },
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1460, height: 940, minWidth: 760, minHeight: 560,
    title: 'Knotrail', backgroundColor: '#faf9f6', show: false,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 19 },
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webviewTag: false, spellcheck: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== rendererURL) event.preventDefault(); });
  mainWindow.webContents.on('will-redirect', event => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = undefined; });
  void mainWindow.loadFile(rendererPath);
}

if (process.env.KNOTRAIL_DATA_DIR) {
  const configured = resolve(process.env.KNOTRAIL_DATA_DIR);
  mkdirSync(configured, { recursive: true, mode: 0o700 });
  app.setPath('userData', configured);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow?.isMinimized()) mainWindow.restore(); mainWindow?.show(); mainWindow?.focus(); });
  void app.whenReady().then(() => {
    const dataDir = resolve(process.env.KNOTRAIL_DATA_DIR || app.getPath('userData'));
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const canonical = realpathSync(dataDir);
    owner = acquireOwnerLock(canonical);
    service = createAppService({
      dataDir: canonical, secretStore: secretStore(canonical), lockFd: owner.fd,
      capabilities: sandboxCapability(),
      notify: event => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('knotrail:event', event); },
    });
    ipcMain.handle('knotrail:command', async (event, command: unknown) => {
      trustedSender(event);
      if (quitting || !service) throw new Error('The application is shutting down');
      if (Buffer.byteLength(JSON.stringify(command) ?? '') > 256_000) throw new Error('Command is too large');
      return service.command(command);
    });
    ipcMain.handle('knotrail:choose-project', async event => {
      trustedSender(event);
      const result = await dialog.showOpenDialog(mainWindow!, { title: 'Open project · 打开项目', properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    ipcMain.handle('knotrail:export-report', async (event, taskId: unknown) => {
      trustedSender(event);
      if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) throw new Error('Invalid task identifier');
      const content = service!.report(taskId);
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: 'Export task report · 导出任务报告', defaultPath: `knotrail-${taskId}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (result.canceled || !result.filePath) return null;
      writeFileSync(result.filePath, content, { mode: 0o600 });
      return result.filePath;
    });
    createWindow();
    app.on('activate', () => { if (!mainWindow && !quitting) createWindow(); });
  }).catch(async (error: unknown) => {
    dialog.showErrorBox('Knotrail could not start', error instanceof Error ? error.message : 'Application initialization failed');
    try {
      await service?.shutdown();
      owner?.release();
      shutdownComplete = true;
      app.quit();
    } catch {
      dialog.showErrorBox('Knotrail retained ownership', 'A worker has not stopped. Retry Quit after the task has stopped.');
    }
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    // Keep the owner descriptor until all pi workers and execution helpers settle.
    void (service?.shutdown() ?? Promise.resolve()).then(() => {
      owner?.release(); shutdownComplete = true; app.quit();
    }).catch(() => {
      quitting = false;
      dialog.showErrorBox('Knotrail could not finish shutting down', 'A worker has not stopped. The application retained ownership; retry Quit after the task has stopped.');
    });
  });
}
