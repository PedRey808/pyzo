// Магнат для ПК: окно Electron с игрой из game/index.html.
// Онлайн-игра идёт напрямую между игроками через интернет (WebRTC / PeerJS), сервер не нужен.
const {app, BrowserWindow, Menu, shell, dialog, powerSaveBlocker} = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 820,
    minHeight: 560,
    title: 'Магнат',
    backgroundColor: '#1b1650',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    // the room creator's game must keep running when the window is minimised or in the background
    webPreferences: {contextIsolation: true, sandbox: true, backgroundThrottling: false},
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'game', 'index.html'));

  // external links open in the normal browser
  win.webContents.setWindowOpenHandler(({url}) => { shell.openExternal(url); return {action: 'deny'}; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); }
  });
  // the page asks "are you sure?" when the room creator closes the window during a game
  win.webContents.on('will-prevent-unload', e => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Выйти', 'Остаться'],
      defaultId: 1,
      cancelId: 1,
      title: 'Магнат',
      message: 'Выйти из игры?',
      detail: 'Вы создатель комнаты: у друзей игра остановится. Её можно будет продолжить, открыв игру снова и нажав «Продолжить».',
    });
    if (choice === 0) e.preventDefault();
  });
  // F11 — full screen, Ctrl+R — reload, F12 — dev tools
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
    else if ((input.control || input.meta) && input.key.toLowerCase() === 'r') { win.reload(); e.preventDefault(); }
  });
}

app.whenReady().then(() => {
  powerSaveBlocker.start('prevent-app-suspension');
  createWindow();
});
app.on('window-all-closed', () => app.quit());
