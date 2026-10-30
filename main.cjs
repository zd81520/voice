const { app, BrowserWindow, protocol, net, session, ipcMain, dialog } = require('electron');
const { join, dirname, basename } = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

protocol.registerSchemesAsPrivileged([
  { scheme: 'sample', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const APP_ORIGIN = 'sample://app';
const FILES = new Set(['/index.html', '/styles.css', '/app.js', '/sampler.js', '/project.js', '/wav-guard.js', '/waveform.js', '/midi-performance.js', '/zone-mapping.js', '/zone-map-view.js']);
const MAX_PROJECT_BYTES = 64 * 1024 * 1024;
let mainWindow;

function trusted(contents, url) {
  return !!mainWindow && contents === mainWindow.webContents && typeof url === 'string' &&
    (url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`));
}

app.whenReady().then(async () => {
  ipcMain.handle('project:save', async (event, text) => {
    if (!trusted(event.sender, event.senderFrame?.url) || event.senderFrame !== mainWindow.webContents.mainFrame) {
      return { saved: false, error: '不允许此页面保存工程。' };
    }
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_PROJECT_BYTES || !text.length) {
      return { saved: false, error: '工程数据无效或超过 64 MiB。' };
    }
    let temporary;
    let file;
    let ownsTemporary = false;
    try {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '保存采样工程', defaultPath: '我的音色.sampler.json',
        filters: [{ name: '采样工程', extensions: ['sampler.json'] }],
      });
      if (result.canceled || !result.filePath) return { saved: false, canceled: true };
      // Use exactly the path confirmed by the native dialog, including its
      // extension; changing it afterwards could overwrite a different file.
      const destination = result.filePath;
      temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
      file = await fs.open(temporary, 'wx');
      ownsTemporary = true;
      await file.writeFile(text, { encoding: 'utf8' });
      await file.close();
      file = undefined;
      await fs.rename(temporary, destination);
      ownsTemporary = false;
      return { saved: true };
    } catch (error) {
      return { saved: false, error: `保存失败：${error.message}` };
    } finally {
      if (file) await file.close().catch(() => {});
      if (ownsTemporary) await fs.unlink(temporary).catch(() => {});
    }
  });
  protocol.handle('sample', request => {
    let url;
    try { url = new URL(request.url); } catch { return new Response('Bad request', { status: 400 }); }
    if (url.host !== 'app' || !FILES.has(url.pathname) || url.search || url.hash) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(join(__dirname, 'renderer', url.pathname.slice(1))).href);
  });
  const ses = session.defaultSession;
  // Electron 44 requests midiSysex even for requestMIDIAccess({sysex:false}).
  // Restrict the permission to our own local main window; the renderer only
  // requests ordinary note input and never requests or sends SysEx messages.
  const isMidiPermission = permission => permission === 'midi' || permission === 'midiSysex';
  ses.setPermissionCheckHandler((contents, permission, origin) =>
    isMidiPermission(permission) && trusted(contents, origin));
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(isMidiPermission(permission) && trusted(contents, details.requestingUrl || contents?.getURL()));
  });
  mainWindow = new BrowserWindow({
    width: 1240, height: 850, minWidth: 850, minHeight: 650,
    title: '采样工作台', backgroundColor: '#11141b', autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning', buttons: ['返回编辑', '放弃更改'], defaultId: 0, cancelId: 0,
      title: '未保存的更改', message: '工程有未保存的更改。',
      detail: '返回编辑可以先保存工程；放弃更改将丢失未保存的内容。',
    });
    if (choice === 1) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
});
app.on('window-all-closed', () => app.quit());
