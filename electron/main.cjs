const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, powerMonitor, Tray, Menu, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { ServiceManager } = require("./service-manager.cjs");
const { Diagnostics } = require("./diagnostics.cjs");
const { component } = require("./components.cjs");
const iconPath = path.join(__dirname, "../assets/netbridge-icon.png");
let manager;
let diagnostics;
let win;
let tray;
let menuSignature;
let closing = false;
let polling;
let quitPrompt = false;

function toggleService(key, enabled) {
  if (!["zapret", "telegram"].includes(key) || typeof enabled !== "boolean") throw new Error("Неверная операция");
  if (key === "zapret") return enabled ? manager.enableZapret() : manager.stopZapret();
  return enabled ? manager.startTelegram() : manager.stopTelegram();
}

function registerIPC() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
      throw new Error("Недопустимый источник запроса");
    }
    try { return { ok: true, value: await fn(...args) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  handle("services:state", async () => { await manager.refresh(); return manager.snapshot(); });
  handle("services:toggle", toggleService);
  handle("services:import", async (key) => {
    const spec = component(key);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: `Импорт ${spec.asset}`, properties: ["openFile"],
      filters: [{ name: spec.asset, extensions: [path.extname(spec.asset).slice(1)] }],
    });
    if (canceled) return false;
    await manager.importComponent(key, filePaths[0]);
    return true;
  });
  handle("services:optimize", () => manager.enableZapret(true));
  handle("services:cancel", () => manager.cancel());
  handle("telegram:connect", async () => {
    const link = await manager.telegramLink();
    try { await shell.openExternal(link); }
    catch {
      diagnostics.record({ service: "telegram", operation: "connect", outcome: "failed" });
      throw new Error("Не удалось открыть Telegram. Прокси не остановлен; можно скопировать ссылку и открыть её вручную.");
    }
    diagnostics.record({ service: "telegram", operation: "connect", outcome: "ok" });
  });
  handle("telegram:copy", async () => clipboard.writeText(await manager.telegramLink()));
  handle("diagnostics:state", () => diagnostics.snapshot());
  handle("diagnostics:check", () => diagnostics.check());
  handle("diagnostics:export", async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "Экспорт истории Netbridge", defaultPath: "netbridge-history.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (canceled) return false;
    await fs.writeFile(filePath, diagnostics.export(), { mode: 0o600 });
    return true;
  });
}

function showWindow() {
  if (!manager) return;
  if (!win) createWindow();
  win.show();
  win.focus();
}

function updateTray() {
  if (!tray) return;
  const { zapret, telegram } = manager.state;
  const { result, checking, suspended } = diagnostics;
  const signature = JSON.stringify([zapret.running, zapret.loaded, zapret.busy, telegram.running, telegram.busy,
    checking, suspended, result?.at, result?.stale]);
  if (signature === menuSignature) return;
  menuSignature = signature;
  const entries = [["zapret", "Zapret", zapret], ["telegram", "Telegram-прокси", telegram]];
  const run = (action) => async () => {
    try { await action(); }
    catch (error) { await dialog.showMessageBox({ type: "error", message: error.message }); }
  };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Открыть Netbridge", click: showWindow },
    { type: "separator" },
    ...entries.map(([key, label, state]) => {
      const enabled = state.running || state.loaded;
      return { label: `${label}: ${state.busy ? "выполняется операция" : enabled ? "выключить" : "включить"}`,
        enabled: !state.busy, click: run(() => toggleService(key, !enabled)) };
    }),
    { type: "separator" },
    { label: checking ? "Проверка…" : "Проверить сейчас", enabled: !checking && !suspended && !manager.busy.size,
      click: run(() => diagnostics.check()) },
    ...(result ? [{ label: result.stale ? "Диагностика устарела" :
      `Диагностика HTTPS: ${result.https.filter(({ ok }) => ok).length}/${result.https.length}`, enabled: false }] : []),
    { type: "separator" },
    { label: "Выйти из Netbridge", click: () => app.quit() },
  ]));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: "#f4f6f8",
    icon: iconPath,
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
  app.on("second-instance", showWindow);
  app.on("window-all-closed", () => {});
  app.whenReady().then(async () => {
    app.dock?.setIcon(iconPath);
    manager = new ServiceManager(app.getPath("userData"));
    diagnostics = new Diagnostics(manager);
    await Promise.all([manager.restoreStrategyReport(), diagnostics.load()]);
    manager.on("state", (state) => {
      if (win && !win.isDestroyed()) win.webContents.send("services:state", state);
      updateTray();
    });
    diagnostics.on("state", (state) => {
      if (win && !win.isDestroyed()) win.webContents.send("diagnostics:state", state);
      updateTray();
    });
    registerIPC();
    createWindow();
    if (process.platform === "darwin") {
      const logo = nativeImage.createFromPath(path.join(__dirname, "../assets/netbridge.png"));
      const trayIcon = logo.resize({ height: 20, quality: "best" });
      trayIcon.addRepresentation({ scaleFactor: 2,
        buffer: logo.resize({ height: 40, quality: "best" }).toPNG() });
      tray = new Tray(trayIcon);
      tray.setToolTip("Netbridge");
      updateTray();
    }
    powerMonitor.on("suspend", () => diagnostics.sleep(true));
    powerMonitor.on("resume", () => { diagnostics.sleep(false); void manager.refresh(); });
    await manager.refresh();
    polling = setInterval(() => { void manager.refresh(); void diagnostics.observeRoute(); }, 3000);
    app.on("activate", showWindow);
  });
  app.on("before-quit", (event) => {
    if (closing || !manager) return;
    event.preventDefault();
    if (manager.busy.size || diagnostics.checking) {
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
    }).then(async ({ response }) => {
      quitPrompt = false;
      if (response !== 0 || manager.busy.size || diagnostics.checking) return;
      closing = true;
      clearInterval(polling);
      manager.process?.unref();
      await diagnostics.pending;
      app.quit();
    });
  });
}
