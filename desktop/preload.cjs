// Pont entre l'interface (web/app.js) et l'application : reconnaissance des
// PDF et des images par l'Audiveris embarqué, sans serveur.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("transpozDesktop", {
  /** @returns {Promise<{engine: string|null}>} */
  status: () => ipcRenderer.invoke("transpoz:status"),
  /**
   * @param {Array<{name: string, data: Uint8Array}>} files  pages, dans l'ordre
   * @param {{time?: string}} [options]  chiffrage imposé à la reconnaissance (« 2/2 »…)
   * @returns {Promise<{engine?: string, pages?: Array<{name: string, data: Uint8Array}>, error?: string}>}
   */
  recognize: (files, options) => ipcRenderer.invoke("transpoz:recognize", files, options),
});
