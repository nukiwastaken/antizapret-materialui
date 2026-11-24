const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { execFile } = require("node:child_process");

const releases = {
  zapret: "https://github.com/Flowseal/zapret-mac-discord-youtube/releases",
  telegram: "https://github.com/Flowseal/tg-ws-proxy/releases",
};

function openApp(name) {
  return new Promise((resolve) => {
    execFile("/usr/bin/open", ["-a", name], (error) => {
      resolve({ ok: !error, error: error?.message ?? null });
    });
  });
}

ipcMain.handle("open-component", async (_event, key) => {
  if (key === "zapret") return openApp("ZapretMac");
  if (key === "telegram") return openApp("TG WS Proxy");
  return { ok: false, error: "Unknown component" };
});

ipcMain.handle("open-release", async (_event, key) => {
  const url = releases[key];
  if (!url) return false;
  await shell.openExternal(url);
  return true;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: "#f4f6f8",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: require("node:path").join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (app.isPackaged) win.loadFile(require("node:path").join(__dirname, "../dist/index.html"));
  else win.loadURL("http://127.0.0.1:5173");
}

app.whenReady().then(() => {
  ipcMain.handle("platform", () => process.platform);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
