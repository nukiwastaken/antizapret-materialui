const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("netbridge", {
  state: () => ipcRenderer.invoke("services:state"),
  toggle: (key, enabled) => ipcRenderer.invoke("services:toggle", key, enabled),
  optimize: () => ipcRenderer.invoke("services:optimize"),
  cancel: () => ipcRenderer.invoke("services:cancel"),
  connectTelegram: () => ipcRenderer.invoke("telegram:connect"),
  copyTelegram: () => ipcRenderer.invoke("telegram:copy"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("services:state", listener);
    return () => ipcRenderer.removeListener("services:state", listener);
  },
});
