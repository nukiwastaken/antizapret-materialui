const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("netbridge", {
  openComponent: (key) => ipcRenderer.invoke("open-component", key),
  openRelease: (key) => ipcRenderer.invoke("open-release", key),
});
