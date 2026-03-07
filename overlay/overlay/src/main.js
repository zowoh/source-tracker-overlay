"use strict";
/**
 * source-tracker-overlay / src/main.js
 *
 * ANTI-CHEAT: Plain Electron BrowserWindow alwaysOnTop only.
 * Zero DLL injection, zero game process interaction.
 *
 * LIVE MATCH DETECTION — R6S GameLog.txt (read-only file watch)
 *   Path: %USERPROFILE%\Documents\My Games\Rainbow Six - Siege\{profileId}\GameLog.txt
 *   We watch the file with fs.watch (event-driven, zero CPU).
 *   Key log lines parsed:
 *     "SelectMatchId: {id}"           → entering a match NOW
 *     "LevelLoaded / BeginPlay"       → map loaded, match confirmed live
 *     "VOIP AddParticipant profileId={id}" → player joined session (ally or enemy)
 *     "MatchEnd / GameEnd"            → match over
 *     "Disconnected"                  → left match
 *
 * ROSTER AUTO-FILL — User's own Ubisoft token (from their login)
 *   profileId → username via GET /v3/profiles?profileIds={id}
 *   Stats card → our Vercel proxy (username lookup, no extra API keys visible to user)
 *
 * CREDENTIAL STORAGE — Electron safeStorage (Windows DPAPI), encrypted at rest.
 */

const {
  app, BrowserWindow, globalShortcut,
  Tray, Menu, ipcMain, nativeImage,
  safeStorage, screen, session, shell,
} = require("electron");
const path  = require("path");
const fs    = require("fs");
const https = require("https");
const http  = require("http");
const os    = require("os");
const WebSocket = require("ws");

// ── Config ────────────────────────────────────────────────────────────────────
const API_BASE       = "https://source-tracker-six.vercel.app/api";
const UBI_BASE       = "https://public-ubiservices.ubi.com";
const UBI_APPID      = "3587dcbb-7f81-457c-9781-0e3f29f6f56a";
const OVERLAY_HOTKEY = "Alt+G";
const WS_PORT        = 7373;
const CREDS_FILE     = path.join(app.getPath("userData"), "st_creds.enc");
const R6_LOG_BASE    = path.join(os.homedir(), "Documents", "My Games", "Rainbow Six - Siege");
const DISCORD_URL    = "https://discord.gg/vsybH2fcXs";
const ICON_PATH      = path.join(__dirname, "..", "assets", "icon.ico");

// ── State ─────────────────────────────────────────────────────────────────────
let overlayWin     = null;
let desktopWin     = null;
let tray           = null;
let overlayVisible = false;
let wsServer       = null;
let wsClients      = new Set();
let rosterSlots    = {};
let currentUser    = null;   // { username, platform, profileId, profile }

// Ubisoft session (user's own token — in memory only, never persisted)
let ubiTicket    = null;
let ubiSessionId = "";
let ubiExpiry    = 0;

// Log watching
let logWatcher  = null;
let logFilePath = null;
let logFilePos  = 0;

// Match state
let matchActive    = false;
let currentMatchId = null;
let voipSeen       = new Set();  // profileIds already assigned a slot

// profileId → username lookup cache (within a session)
const pidCache = new Map();

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Set app icon (shows in taskbar, alt-tab, title bar)
  if (fs.existsSync(ICON_PATH)) {
    app.setAppUserModelId("com.sourcetracker.overlay"); // must match package.json appId
  }

  // Remove default menu bar (File, Edit, View, Window, Help)
  // Replace with a single Help menu that links to Discord
  const customMenu = Menu.buildFromTemplate([
    {
      label: "Help",
      submenu: [
        {
          label: "Join Discord (Support)",
          click: () => shell.openExternal(DISCORD_URL),
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(customMenu);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          [
            "default-src 'self' 'unsafe-inline' 'unsafe-eval'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://dcbbwymp1bhlf.cloudfront.net https://*.cloudfront.net https://*.lootlabs.com",
            "frame-src https://dcbbwymp1bhlf.cloudfront.net https://*.cloudfront.net https://*.lootlabs.com https://*.doubleclick.net",
            "img-src 'self' data: https: blob:",
            "connect-src 'self' https: wss: ws://127.0.0.1:7373",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
          ].join("; "),
        ],
      },
    });
  });

  app.commandLine.appendSwitch("disable-features", "OutOfBlinkCors");

  createTray();
  createDesktopWindow();
  createOverlayWindow();
  startWebSocketBridge();
  registerHotkey();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createDesktopWindow();
  });
});

app.on("window-all-closed", e => e.preventDefault());
app.on("will-quit", () => { globalShortcut.unregisterAll(); stopLogWatch(); });

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  const icon = fs.existsSync(ICON_PATH)
    ? nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("Source Tracker");
  rebuildTrayMenu();
  tray.on("double-click", () => { desktopWin?.show(); desktopWin?.focus(); });
}
function rebuildTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Source Tracker",                                                 enabled: false },
    { type: "separator" },
    { label: currentUser ? `Signed in: ${currentUser.username}` : "Not signed in", enabled: false },
    { label: matchActive ? "🔴 Match Live" : logWatcher ? "🟢 Watching log" : "⚪ Idle", enabled: false },
    { type: "separator" },
    { label: "Open Dashboard",                      click: () => { desktopWin?.show(); desktopWin?.focus(); } },
    { label: `Toggle Overlay  (${OVERLAY_HOTKEY})`, click: toggleOverlay },
    { type: "separator" },
    ...(currentUser ? [{ label: "Sign Out", click: doLogout }] : []),
    { label: "Quit", click: () => app.exit(0) },
  ]));
}

// ── Windows ───────────────────────────────────────────────────────────────────
function createDesktopWindow() {
  if (desktopWin && !desktopWin.isDestroyed()) return;
  desktopWin = new BrowserWindow({
    width: 1160, height: 780, minWidth: 820, minHeight: 560,
    title: "Source Tracker", backgroundColor: "#000000",
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, webSecurity: false },
  });
  desktopWin.loadFile(path.join(__dirname, "renderer", "desktop.html"));
  desktopWin.on("close", e => { e.preventDefault(); desktopWin.hide(); });
}

function createOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  overlayWin = new BrowserWindow({
    width: 420, height: 720,
    x: workArea.x + 24, y: workArea.y + 60,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: true, hasShadow: false, focusable: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, webSecurity: false },
  });
  overlayWin.setAlwaysOnTop(true, "screen-saver");
  overlayWin.loadFile(path.join(__dirname, "renderer", "overlay.html"));
  overlayWin.hide();
  overlayWin.on("closed", () => { overlayWin = null; });
}

function toggleOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) createOverlayWindow();
  if (overlayVisible) {
    overlayWin.hide(); overlayVisible = false;
  } else {
    overlayWin.show(); overlayVisible = true;
    if (currentUser) {
      sendToOverlay("auth-state",    { loggedIn: true, user: currentUser });
      sendToOverlay("match-state",   buildMatchState());
      sendToOverlay("roster-update", buildRosterPayload());
    } else {
      sendToOverlay("auth-state", { loggedIn: false });
    }
  }
}

const sendToOverlay = (ch, d) => { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(ch, d); };
const sendToDesktop = (ch, d) => { if (desktopWin && !desktopWin.isDestroyed()) desktopWin.webContents.send(ch, d); };

// ── Hotkey ────────────────────────────────────────────────────────────────────
function registerHotkey() {
  globalShortcut.register(OVERLAY_HOTKEY, toggleOverlay);
}

// ── WebSocket bridge ──────────────────────────────────────────────────────────
function startWebSocketBridge() {
  wsServer = new WebSocket.Server({ port: WS_PORT, host: "127.0.0.1" });
  wsServer.on("connection", ws => {
    wsClients.add(ws);
    ws.send(JSON.stringify({ type: "roster-update", payload: buildRosterPayload() }));
    if (currentUser) ws.send(JSON.stringify({ type: "auth-state", payload: { loggedIn: true, user: currentUser } }));
    ws.on("message", raw => { try { handleWSMessage(JSON.parse(raw.toString())); } catch (_) {} });
    ws.on("close",   () => wsClients.delete(ws));
    ws.on("error",   () => wsClients.delete(ws));
  });
  wsServer.on("error", e => { if (e.code !== "EADDRINUSE") console.error("[WS]", e.message); });
}
function broadcastWS(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const ws of wsClients) { if (ws.readyState === WebSocket.OPEN) ws.send(msg); }
}
function handleWSMessage(msg) {
  if (!msg?.type) return;
  if (msg.type === "roster-clear") clearRoster();
  if (msg.type === "match-end")    endMatch("ws");
}

// ── Roster ────────────────────────────────────────────────────────────────────
function clearRoster() {
  rosterSlots = {};
  sendToOverlay("roster-clear", {});
  sendToDesktop("roster-clear", {});
  broadcastWS("roster-clear",   {});
}
function broadcastRosterUpdate() {
  const p = buildRosterPayload();
  sendToOverlay("roster-update", p);
  sendToDesktop("roster-update", p);
  broadcastWS("roster-update",   p);
}
function buildRosterPayload() {
  const yourTeam = [], enemyTeam = [];
  for (let i = 0; i < 10; i++) {
    const slot = rosterSlots[i] || { slotIndex: i, status: "empty", isEnemy: i >= 5 };
    if (i < 5) yourTeam.push(slot); else enemyTeam.push(slot);
  }
  return { yourTeam, enemyTeam };
}

// ── Match state ───────────────────────────────────────────────────────────────
function buildMatchState() {
  return { active: matchActive, matchId: currentMatchId, user: currentUser, roster: buildRosterPayload(), watching: !!logWatcher };
}

function startMatch(matchId) {
  if (matchActive) return;
  matchActive    = true;
  currentMatchId = matchId || null;
  voipSeen       = new Set();

  // Seed slot 0 with logged-in user immediately
  if (currentUser) {
    rosterSlots[0] = {
      slotIndex: 0,
      username:  currentUser.username,
      platform:  currentUser.platform,
      isEnemy:   false,
      status:    currentUser.profile ? "loaded" : "loading",
      profile:   currentUser.profile || null,
    };
    if (!currentUser.profile) {
      fetchProfile(currentUser.username, currentUser.platform)
        .then(p => {
          if (p && currentUser && rosterSlots[0]) {
            currentUser.profile = p;
            rosterSlots[0] = { ...rosterSlots[0], status: "loaded", profile: p };
            broadcastRosterUpdate();
          }
        }).catch(() => {});
    }
  }

  rebuildTrayMenu();
  broadcastRosterUpdate();
  const state = buildMatchState();
  sendToOverlay("match-state", state);
  sendToDesktop("match-state", state);
  broadcastWS("match-state",   state);
  console.log("[Match] Started — matchId:", matchId);
}

function endMatch(src) {
  if (!matchActive) return;
  matchActive    = false;
  currentMatchId = null;
  voipSeen       = new Set();
  clearRoster();
  rebuildTrayMenu();
  const state = buildMatchState();
  sendToOverlay("match-state", state);
  sendToDesktop("match-state", state);
  broadcastWS("match-state",   state);
  console.log("[Match] Ended —", src);
}

// ── R6S GameLog.txt watcher ───────────────────────────────────────────────────
function findLogFile(profileId) {
  // Primary: known profile folder
  for (const name of ["GameLog.txt", "Log.txt"]) {
    if (profileId) {
      const p = path.join(R6_LOG_BASE, profileId, name);
      if (fs.existsSync(p)) return p;
    }
  }
  // Fallback: scan all subfolders (GUID-shaped folder names)
  try {
    const entries = fs.readdirSync(R6_LOG_BASE, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      for (const name of ["GameLog.txt", "Log.txt"]) {
        const p = path.join(R6_LOG_BASE, e.name, name);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (_) {}
  return null;
}

function startLogWatch(profileId) {
  stopLogWatch();
  logFilePath = findLogFile(profileId);

  if (!logFilePath) {
    console.warn("[Log] Log file not found — profileId:", profileId);
    sendToOverlay("log-status", { watching: false, reason: "R6S log not found. Launch the game at least once." });
    sendToDesktop("log-status", { watching: false, reason: "R6S log not found." });
    return;
  }

  // Start from current end of file — ignore old sessions
  try { logFilePos = fs.statSync(logFilePath).size; } catch (_) { logFilePos = 0; }

  logWatcher = fs.watch(logFilePath, { persistent: true }, eventType => {
    if (eventType === "change") readNewLogLines();
  });
  logWatcher.on("error", err => {
    console.error("[Log] Watch error:", err.message);
    stopLogWatch();
    setTimeout(() => startLogWatch(profileId), 5000);
  });

  console.log("[Log] Watching:", logFilePath);
  sendToOverlay("log-status", { watching: true });
  sendToDesktop("log-status", { watching: true });
  rebuildTrayMenu();
}

function stopLogWatch() {
  if (logWatcher) { try { logWatcher.close(); } catch (_) {} }
  logWatcher  = null;
  logFilePath = null;
  logFilePos  = 0;
}

function readNewLogLines() {
  if (!logFilePath) return;
  try {
    const stat = fs.statSync(logFilePath);
    if (stat.size < logFilePos) logFilePos = 0;          // file rotated
    if (stat.size === logFilePos) return;                 // no new data

    const len = stat.size - logFilePos;
    const buf = Buffer.alloc(len);
    const fd  = fs.openSync(logFilePath, "r");
    fs.readSync(fd, buf, 0, len, logFilePos);
    fs.closeSync(fd);
    logFilePos = stat.size;

    buf.toString("utf8").split(/\r?\n/).forEach(line => { if (line.trim()) parseLogLine(line); });
  } catch (err) {
    console.error("[Log] Read error:", err.message);
  }
}

function parseLogLine(line) {
  // ── Match found ───────────────────────────────────────────────────────────
  const mMatch = line.match(/SelectMatchId[:\s]+([a-f0-9][\w\-]{10,})/i);
  if (mMatch) {
    if (!matchActive) startMatch(mMatch[1]);
    return;
  }

  // ── Map loading = confirmed in match ─────────────────────────────────────
  if (!matchActive && /LevelLoaded|BeginPlay|MapLoaded/i.test(line)) {
    startMatch(null);
    return;
  }

  // ── VOIP participant = player in session ──────────────────────────────────
  // "VOIP AddParticipant profileId=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  const vMatch = line.match(/AddParticipant[:\s]+(?:profileId[=:]?\s*)?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (vMatch && matchActive) {
    const pid = vMatch[1].toLowerCase();
    if (currentUser?.profileId && pid === currentUser.profileId.toLowerCase()) return;
    if (!voipSeen.has(pid)) {
      voipSeen.add(pid);
      assignVoipPlayer(pid);
    }
    return;
  }

  // ── Match end ─────────────────────────────────────────────────────────────
  if (matchActive && /MatchEnd|Match End|MatchCompleted|EndMatch|game_end|GameEnd/i.test(line)) {
    endMatch("log:MatchEnd");
    return;
  }

  // ── Disconnect ────────────────────────────────────────────────────────────
  if (matchActive && /\bDisconnected\b|\bLeaveMatch\b/i.test(line)) {
    endMatch("log:Disconnect");
  }
}

// Assign a VOIP profileId to the next empty slot, ally first then enemy
async function assignVoipPlayer(profileId) {
  // Find next open slot: allies (1-4), then enemies (5-9)
  let idx = -1;
  for (let i = 1; i <= 4; i++) {
    if (!rosterSlots[i] || rosterSlots[i].status === "empty") { idx = i; break; }
  }
  if (idx === -1) {
    for (let i = 5; i <= 9; i++) {
      if (!rosterSlots[i] || rosterSlots[i].status === "empty") { idx = i; break; }
    }
  }
  if (idx === -1) return;

  const isEnemy = idx >= 5;
  const plat    = currentUser?.platform || "uplay";

  // Immediately show loading shimmer
  rosterSlots[idx] = { slotIndex: idx, username: "…", platform: plat, isEnemy, status: "loading", profile: null };
  broadcastRosterUpdate();

  try {
    // Step 1: profileId → username (user's own Ubi token, no API keys)
    const username = await resolveProfileId(profileId);
    if (!username) throw new Error("profileId not resolved");

    // Step 2: username → stats (our Vercel proxy)
    const profile = await fetchProfile(username, plat);

    rosterSlots[idx] = { slotIndex: idx, username, platform: plat, isEnemy, status: profile ? "loaded" : "failed", profile: profile || null };
    broadcastRosterUpdate();
    console.log(`[VOIP] Slot ${idx}: ${username} (${profileId.slice(0, 8)}…)`);
  } catch (err) {
    rosterSlots[idx] = { slotIndex: idx, username: `Player ${idx}`, platform: plat, isEnemy, status: "failed", profile: null };
    broadcastRosterUpdate();
    console.warn("[VOIP] Resolve failed:", profileId.slice(0, 8), err.message);
  }
}

// ── Ubisoft API ───────────────────────────────────────────────────────────────

// ── Ubisoft login via embedded browser (account.ubisoft.com) ─────────────────
//
// Opens account.ubisoft.com/login in a BrowserWindow with:
//   - A dedicated Electron session partition (isolated cookies/cache)
//   - Chrome user-agent with Electron string stripped
//   - DevTools protocol to intercept /v3/profiles/sessions response body
//   - Cookie polling as fallback
//
// The user logs in on the real Ubisoft page (handles 2FA natively).
// We extract the session ticket and close the window automatically.
// ─────────────────────────────────────────────────────────────────────────────

// Chrome 124 UA — Electron string deliberately absent
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let ubiAuthWin     = null;
let ubiAuthResolve = null;
let ubiAuthReject  = null;

function openUbiAuthWindow() {
  return new Promise((resolve, reject) => {
    if (ubiAuthWin && !ubiAuthWin.isDestroyed()) {
      ubiAuthWin.focus();
      return;
    }

    ubiAuthResolve = resolve;
    ubiAuthReject  = reject;

    // Dedicated session so cookies don't bleed into the main app session
    const partition = "persist:ubi-login";
    const ubiSession = session.fromPartition(partition);

    // Override UA at the session level — removes the "Electron/" token
    ubiSession.setUserAgent(CHROME_UA);

    // Strip headers that fingerprint Electron
    ubiSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const h = details.requestHeaders;
      delete h["X-Requested-With"];
      h["User-Agent"]      = CHROME_UA;
      h["sec-ch-ua"]       = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';
      h["sec-ch-ua-mobile"]= "?0";
      h["sec-ch-ua-platform"] = '"Windows"';
      callback({ requestHeaders: h });
    });

    ubiAuthWin = new BrowserWindow({
      width:   480,
      height:  680,
      title:   "Sign in with Ubisoft",
      center:  true,
      resizable: false,
      icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
      webPreferences: {
        nodeIntegration:  false,
        contextIsolation: true,
        partition,                    // use isolated session
        userAgent: CHROME_UA,
      },
    });

    // Hide the default menu on the auth window too
    ubiAuthWin.setMenu(null);

    // ── Intercept /v3/profiles/sessions response body via CDP ─────────────
    ubiAuthWin.webContents.debugger.attach("1.3");
    ubiAuthWin.webContents.debugger.sendCommand("Network.enable").catch(() => {});

    ubiAuthWin.webContents.debugger.on("message", (_e, method, params) => {
      if (method !== "Network.responseReceived") return;
      if (!params.response?.url?.includes("/v3/profiles/sessions")) return;
      // Give the body time to finish loading then grab it
      setTimeout(async () => {
        try {
          const result = await ubiAuthWin?.webContents.debugger.sendCommand(
            "Network.getResponseBody",
            { requestId: params.requestId }
          );
          if (!result?.body) return;
          const json = JSON.parse(result.body);
          if (json?.ticket) {
            finishUbiAuth({
              ticket:         json.ticket,
              sessionId:      json.sessionId      || "",
              expiry:         json.expiration ? new Date(json.expiration).getTime() : Date.now() + 6900000,
              profileId:      json.profileId      || json.userId || null,
              userId:         json.userId         || null,
              nameOnPlatform: json.nameOnPlatform || json.username || null,
            });
          }
        } catch (_) {}
      }, 200);
    });

    // ── Cookie fallback — poll for Ubisoft session cookies ────────────────
    const checkCookies = async () => {
      if (!ubiAuthWin || ubiAuthWin.isDestroyed()) return;
      try {
        const cookies = await ubiSession.cookies.get({ domain: ".ubisoft.com" });
        const tokenCookie = cookies.find(c =>
          c.name === "ubiservices_token" ||
          c.name === "ubi_sdsession"     ||
          c.name === "ubi_token"
        );
        if (tokenCookie) {
          await exchangeCookieForTicket(ubiSession);
        }
      } catch (_) {}
    };

    const cookiePoll = setInterval(() => {
      if (!ubiAuthWin || ubiAuthWin.isDestroyed()) { clearInterval(cookiePoll); return; }
      checkCookies();
    }, 2000);

    // ── URL change hook ───────────────────────────────────────────────────
    ubiAuthWin.webContents.on("did-navigate", (_, url) => {
      if (/\/login-success|\/callback|account\.ubisoft\.com\/?(\?|#|$)/i.test(url)) {
        checkCookies();
      }
    });
    ubiAuthWin.webContents.on("did-navigate-in-page", (_, url) => {
      if (/\/login-success|\/callback/i.test(url)) checkCookies();
    });

    ubiAuthWin.on("closed", () => {
      clearInterval(cookiePoll);
      ubiAuthWin = null;
      if (ubiAuthReject) {
        ubiAuthReject(new Error("Login window closed before completing sign-in"));
        ubiAuthResolve = null;
        ubiAuthReject  = null;
      }
    });

    // Load the real Ubisoft account login page
    ubiAuthWin.loadURL(
      "https://account.ubisoft.com/en-US/login",
      { userAgent: CHROME_UA }
    );
  });
}

async function exchangeCookieForTicket(ubiSess) {
  try {
    const cookies  = await ubiSess.cookies.get({ domain: ".ubisoft.com" });
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");

    const data = await fetchJSONPost(
      `${UBI_BASE}/v3/profiles/sessions`,
      {
        "Content-Type":  "application/json",
        "Ubi-AppId":     UBI_APPID,
        "Cookie":        cookieStr,
        "User-Agent":    CHROME_UA,
        "Origin":        "https://account.ubisoft.com",
        "Referer":       "https://account.ubisoft.com/",
      },
      JSON.stringify({ rememberMe: false })
    );

    if (data?.ticket) {
      finishUbiAuth({
        ticket:         data.ticket,
        sessionId:      data.sessionId      || "",
        expiry:         data.expiration ? new Date(data.expiration).getTime() : Date.now() + 6900000,
        profileId:      data.profileId      || data.userId || null,
        userId:         data.userId         || null,
        nameOnPlatform: data.nameOnPlatform || data.username || null,
      });
    }
  } catch (_) {}
}

function finishUbiAuth(authData) {
  if (!ubiAuthResolve) return;       // already resolved
  const resolve    = ubiAuthResolve;
  ubiAuthResolve   = null;
  ubiAuthReject    = null;

  // Close the login window
  if (ubiAuthWin && !ubiAuthWin.isDestroyed()) {
    ubiAuthWin.close();
    ubiAuthWin = null;
  }

  resolve(authData);
}

// Legacy direct API login — kept as fallback, improved User-Agent
async function ubiLoginUser(loginId, platform, password, tfaCode) {
  const creds = Buffer.from(`${loginId}:${password}`).toString("base64");
  const headers = {
    "Authorization": `Basic ${creds}`,
    "Ubi-AppId":     UBI_APPID,
    "Content-Type":  "application/json",
    "User-Agent":    "UbiServices_SDK_2020.Release.58_PC64_ansi_static",
    "Ubi-LocaleCode":"en-US",
    "Origin":        "https://connect.ubisoft.com",
    "Referer":       "https://connect.ubisoft.com/",
  };
  if (tfaCode) headers["Ubi-2FACode"] = tfaCode;

  const data = await fetchJSONPost(
    `${UBI_BASE}/v3/profiles/sessions`,
    headers,
    JSON.stringify({ rememberMe: false })
  );

  if (!data) throw new Error("No response from Ubisoft");
  if (data.errorCode === 1244 || (data.httpCode === 401 && data.errorCode === 1141)) {
    return { requires2FA: true };
  }
  if (!data.ticket) {
    throw new Error(data.message || data.error || `Auth failed (${data.httpCode || data.errorCode || "unknown"})`);
  }
  return {
    ticket:         data.ticket,
    sessionId:      data.sessionId      || "",
    expiry:         data.expiration ? new Date(data.expiration).getTime() : Date.now() + 6900000,
    profileId:      data.profileId      || null,
    userId:         data.userId         || null,
    nameOnPlatform: data.nameOnPlatform || loginId,
  };
}

async function getValidUserTicket() {
  if (ubiTicket && Date.now() < ubiExpiry - 120000) return ubiTicket;
  // Token expired — check cache
  const cached = loadTokenCache();
  if (cached?.ticket) {
    ubiTicket    = cached.ticket;
    ubiSessionId = cached.sessionId;
    ubiExpiry    = cached.expiry;
    return ubiTicket;
  }
  return null; // needs re-login via browser window
}

async function resolveProfileId(profileId) {
  if (pidCache.has(profileId)) return pidCache.get(profileId);
  const ticket = await getValidUserTicket();
  if (!ticket) throw new Error("No valid Ubi token");

  const data = await fetchJSONGet(`${UBI_BASE}/v3/profiles?profileIds=${encodeURIComponent(profileId)}`, {
    "Authorization": `Ubi_v1 t=${ticket}`,
    "Ubi-AppId":     UBI_APPID,
    "Ubi-SessionId": ubiSessionId,
    "User-Agent":    "Mozilla/5.0",
  });

  const name = data?.profiles?.[0]?.nameOnPlatform || null;
  if (name) pidCache.set(profileId, name);
  return name;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function fetchJSONGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers, timeout: 15000 }, res => {
      let b = ""; res.on("data", d => b += d);
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function fetchJSONPost(url, headers = {}, body = "") {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const opts = {
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      timeout: 15000,
    };
    const req = https.request(opts, res => {
      let b = ""; res.on("data", d => b += d);
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(body); req.end();
  });
}

async function fetchProfile(username, platform = "uplay", bustCache = false) {
  const url = `${API_BASE}/player?username=${encodeURIComponent(username)}&platform=${platform}` + (bustCache ? "&bust=1" : "");
  const data = await fetchJSONGet(url);
  if (!data?.username) return null;
  // Auto-bust if profile came back with no KD and no season history
  if (!bustCache && data.kd == null && (!data.seasonHistory || data.seasonHistory.length === 0)) {
    console.log("[fetchProfile] got empty stats, busting cache for:", username);
    const bust = await fetchJSONGet(`${API_BASE}/player?username=${encodeURIComponent(username)}&platform=${platform}&bust=1`);
    return bust?.username ? bust : data;
  }
  return data;
}

// ── Token cache (no passwords stored — only the session token) ───────────────
const TOKEN_FILE = path.join(app.getPath("userData"), "st_token.enc");

function saveTokenCache(ticket, sessionId, expiry, user) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    const payload = JSON.stringify({ ticket, sessionId, expiry, user });
    const enc = safeStorage.encryptString(payload);
    fs.writeFileSync(TOKEN_FILE, enc.toString("hex"), "utf8");
  } catch (e) { console.error("[Token] Save:", e.message); }
}

function loadTokenCache() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const hex = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    const dec = safeStorage.decryptString(Buffer.from(hex, "hex"));
    const data = JSON.parse(dec);
    // Discard if expired
    if (!data?.ticket || !data?.expiry || Date.now() > data.expiry - 60000) return null;
    return data;
  } catch (_) { return null; }
}

function deleteTokenCache() {
  try { if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE); } catch (_) {}
  // Also clean up old creds file if present
  try { if (fs.existsSync(CREDS_FILE)) fs.unlinkSync(CREDS_FILE); } catch (_) {}
}

// Legacy password creds — kept only to migrate old installs
function loadSavedCreds() {
  try {
    if (!fs.existsSync(CREDS_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(CREDS_FILE, "utf8"));
    if (!raw?.encryptedPassword || !raw?.username) return null;
    return { username: raw.username, email: raw.email || raw.username, platform: raw.platform || "uplay", password: safeStorage.decryptString(Buffer.from(raw.encryptedPassword, "hex")) };
  } catch (_) { return null; }
}
function saveCreds() {} // no-op — replaced by token cache
function deleteSavedCreds() { deleteTokenCache(); }

// ── Post-login setup ──────────────────────────────────────────────────────────
function onLoginSuccess(user) {
  currentUser = user;
  rebuildTrayMenu();

  // Immediately send loggedIn so the renderer shows the app and loading state
  sendToDesktop("auth-state", { loggedIn: true, user: currentUser });

  startLogWatch(user.profileId);

  if (!currentUser.profile) {
    fetchProfile(currentUser.username, currentUser.platform)
      .then(p => {
        if (p && currentUser) {
          currentUser.profile = p;
          // Push again so the renderer renders full stats
          sendToDesktop("auth-state", { loggedIn: true, user: currentUser });
        }
      })
      .catch(() => {});
  } else {
    // Profile already cached — push immediately
    sendToDesktop("auth-state", { loggedIn: true, user: currentUser });
  }
}

function doLogout() {
  stopLogWatch();
  endMatch("logout");
  deleteTokenCache();
  ubiTicket = null; ubiSessionId = ""; ubiExpiry = 0;
  currentUser = null;
  pidCache.clear();
  rebuildTrayMenu();
  sendToDesktop("auth-state", { loggedIn: false });
  sendToOverlay("auth-state", { loggedIn: false });
  broadcastWS("auth-state",   { loggedIn: false });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle("auth-get", () => {
  // Check token cache first — if valid, restore session silently (no browser window)
  const cached = loadTokenCache();
  if (cached) {
    ubiTicket    = cached.ticket;
    ubiSessionId = cached.sessionId;
    ubiExpiry    = cached.expiry;
    currentUser  = cached.user || null;
    if (currentUser) {
      onLoginSuccess(currentUser);
      // Notify renderers after a tick so they've finished initialising
      setImmediate(() => {
        sendToOverlay("auth-state", { loggedIn: true, user: currentUser });
        sendToDesktop("auth-state", { loggedIn: true, user: currentUser });
      });
      return { loggedIn: true, user: currentUser };
    }
  }

  // No valid cached token — user needs to log in via browser window
  return { loggedIn: false, hasSaved: false };
});

ipcMain.handle("auth-login", async (_e, opts) => {
  try {
    // PRIMARY: open real Ubisoft login page in embedded browser
    // This handles email, password, 2FA, captcha — everything natively
    const auth = await openUbiAuthWindow();

    if (!auth?.ticket) return { success: false, error: "Login failed — no session token received" };

    ubiTicket    = auth.ticket;
    ubiSessionId = auth.sessionId;
    ubiExpiry    = auth.expiry;

    const platform = opts?.platform || "uplay";
    const user = {
      username:  auth.nameOnPlatform || "Unknown",
      platform,
      profileId: auth.profileId || null,
      profile:   null,
    };

    // Save credentials if requested — store the ticket expiry info
    // (We don't store password — we re-open the browser window on next launch
    //  unless a valid cached ticket exists)
    if (opts?.save !== false) {
      saveTokenCache(ubiTicket, ubiSessionId, ubiExpiry, user);
    }

    onLoginSuccess(user);
    sendToOverlay("auth-state", { loggedIn: true, user });
    broadcastWS("auth-state",   { loggedIn: true, user });

    // Fetch the user's own stats and push to desktop for Home tab
    fetchProfile(user.username, platform).then(profile => {
      if (profile && currentUser) {
        currentUser.profile = profile;
        saveTokenCache(ubiTicket, ubiSessionId, ubiExpiry, currentUser);
        sendToDesktop("auth-state", { loggedIn: true, user: currentUser });
      }
    }).catch(() => {});

    return { success: true, user };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("auth-logout",     () => { doLogout(); return { success: true }; });
ipcMain.handle("get-match-state", () => buildMatchState());
ipcMain.handle("get-roster",      () => buildRosterPayload());
ipcMain.handle("clear-roster",    () => { clearRoster(); return true; });

ipcMain.handle("lookup-player", async (_e, { username, platform, slotIndex }) => {
  const idx = slotIndex ?? -1;
  try {
    if (idx >= 0) {
      rosterSlots[idx] = { slotIndex: idx, username, platform: platform || "uplay", isEnemy: idx >= 5, status: "loading", profile: null };
      broadcastRosterUpdate();
    }
    const profile = await fetchProfile(username, platform || "uplay");
    if (idx >= 0) {
      rosterSlots[idx] = { slotIndex: idx, username, platform: platform || "uplay", isEnemy: idx >= 5, status: profile ? "loaded" : "failed", profile: profile || null };
      broadcastRosterUpdate();
    }
    return profile || { error: "Player not found" };
  } catch (err) {
    if (idx >= 0) { rosterSlots[idx] = { slotIndex: idx, username, isEnemy: idx >= 5, status: "failed", profile: null }; broadcastRosterUpdate(); }
    return { error: err.message };
  }
});

ipcMain.handle("set-slot", (_e, { slotIndex, data }) => {
  if (typeof slotIndex !== "number") return false;
  if (data === null) delete rosterSlots[slotIndex];
  else rosterSlots[slotIndex] = { ...data, slotIndex };
  broadcastRosterUpdate();
  return true;
});

ipcMain.on("open-discord", () => {
  shell.openExternal(DISCORD_URL);
});

ipcMain.on("set-click-through", (_e, enabled) => {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setIgnoreMouseEvents(enabled, { forward: true });
});
