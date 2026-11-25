const { app, BrowserWindow, ipcMain, shell, dialog, clipboard } = require("electron");
const path = require("node:path");
const { ServiceManager } = require("./service-manager.cjs");
let manager;
let win;
let closing = false;
let polling;
let quitPrompt = false;

function registerIPC() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error("Недопустимый источник запроса");
    }
    try { return { ok: true, value: await fn(...args) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  handle("services:state", async () => { await manager.refresh(); return manager.snapshot(); });
  handle("services:toggle", async (key, enabled) => {
    if (!["zapret", "telegram"].includes(key) || typeof enabled !== "boolean") throw new Error("Неверная операция");
    if (key === "zapret") return enabled ? manager.enableZapret() : manager.stopZapret();
    if (!enabled) return manager.stopTelegram();
    await manager.startTelegram();
    await shell.openExternal(await manager.telegramLink());
  });
  handle("services:optimize", () => manager.enableZapret(true));
  handle("services:cancel", () => manager.cancel());
  handle("telegram:connect", async () => shell.openExternal(await manager.telegramLink()));
  handle("telegram:copy", async () => clipboard.writeText(await manager.telegramLink()));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: "#f4f6f8",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  if (app.isPackaged) win.loadFile(path.join(__dirname, "../dist/index.html"));
  else win.loadURL("http://127.0.0.1:5173");
  win.on("closed", () => { win = null; });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    manager = new ServiceManager(app.getPath("userData"));
    manager.on("state", (state) => {
      if (win && !win.isDestroyed()) win.webContents.send("services:state", state);
    });
    registerIPC();
    createWindow();
    await manager.refresh();
    polling = setInterval(() => manager.refresh(), 3000);
    app.on("activate", () => { if (!win) createWindow(); });
  });
  app.on("before-quit", (event) => {
    if (closing || !manager) return;
    event.preventDefault();
    if (manager.busy.size) {
      dialog.showMessageBoxSync({
        type: "info", message: "Дождитесь завершения операции или отмените подбор стратегий.",
        buttons: ["Остаться"],
      });
      return;
    }
    if (quitPrompt) return;
    quitPrompt = true;
    dialog.showMessageBox({
      type: "question", message: "Оставить сервисы включёнными?",
      detail: "Zapret и Telegram-прокси могут продолжать работу после закрытия Netbridge.",
      buttons: ["Оставить и выйти", "Отмена"], cancelId: 1,
    }).then(({ response }) => {
      quitPrompt = false;
      if (response !== 0) return;
      closing = true;
      clearInterval(polling);
      manager.process?.unref();
      app.quit();
    });
  });
}
