"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tracker", {
  // Auth
  authGet:    ()     => ipcRenderer.invoke("auth-get"),
  authLogin:  (opts) => ipcRenderer.invoke("auth-login",  opts),
  authLogout: ()     => ipcRenderer.invoke("auth-logout"),

  // Match
  getMatchState: () => ipcRenderer.invoke("get-match-state"),

  // Roster
  getRoster:    ()     => ipcRenderer.invoke("get-roster"),
  clearRoster:  ()     => ipcRenderer.invoke("clear-roster"),
  lookupPlayer: (opts) => ipcRenderer.invoke("lookup-player", opts),
  setSlot:      (opts) => ipcRenderer.invoke("set-slot",      opts),

  // Overlay
  setClickThrough:     (on)    => ipcRenderer.send("set-click-through", on),
  setHoverInteractive: (isOver) => ipcRenderer.send("set-hover-interactive", isOver),

  // External links
  openDiscord: () => ipcRenderer.send("open-discord"),

  // Push events → renderer
  onAuthState:    (cb) => ipcRenderer.on("auth-state",    (_e, d) => cb(d)),
  onMatchState:   (cb) => ipcRenderer.on("match-state",   (_e, d) => cb(d)),
  onLogStatus:    (cb) => ipcRenderer.on("log-status",    (_e, d) => cb(d)),
  onRosterUpdate: (cb) => ipcRenderer.on("roster-update", (_e, d) => cb(d)),
  onRosterClear:  (cb) => ipcRenderer.on("roster-clear",  (_e, d) => cb(d)),

  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch),
});
