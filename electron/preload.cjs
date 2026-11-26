const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, state) => callback(state);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("netbridge", {
  state: () => ipcRenderer.invoke("services:state"),
  toggle: (key, enabled) => ipcRenderer.invoke("services:toggle", key, enabled),
  optimize: () => ipcRenderer.invoke("services:optimize"),
  cancel: () => ipcRenderer.invoke("services:cancel"),
  connectTelegram: () => ipcRenderer.invoke("telegram:connect"),
  copyTelegram: () => ipcRenderer.invoke("telegram:copy"),
  importComponent: (key) => ipcRenderer.invoke("services:import", key),
  diagnostics: () => ipcRenderer.invoke("diagnostics:state"),
  check: () => ipcRenderer.invoke("diagnostics:check"),
  exportHistory: () => ipcRenderer.invoke("diagnostics:export"),
  onState: (callback) => subscribe("services:state", callback),
  onDiagnostics: (callback) => subscribe("diagnostics:state", callback),
});
