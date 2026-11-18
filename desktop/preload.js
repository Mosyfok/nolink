const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("nolinkDesktop", {
  platform: process.platform,
  version: "1.0.0"
});
