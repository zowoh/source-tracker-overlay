# Source Tracker Overlay

Desktop overlay + companion app for [source-tracker-six.vercel.app](https://source-tracker-six.vercel.app).  
Shows R6 Siege player stats in a transparent in-game overlay.

---

## Anti-Cheat Compliance

**100% safe with BattlEye and Easy Anti-Cheat.**

| What gets you banned | This app |
|---|---|
| DLL injection into game process | ❌ None |
| Reading/writing game memory | ❌ None |
| Kernel drivers / hooks | ❌ None |
| DirectX / Vulkan overlay hooks | ❌ None |

The overlay is a standard Windows window (`alwaysOnTop`, rendered by Win32) — identical to Discord. All stats come from public HTTPS APIs. Ubisoft has confirmed external stat trackers using public APIs are permitted.

---

## Features

- **Ubisoft login** — sign in with your Ubisoft Connect username; stats auto-load as "You" in slot 0
- **Save login / autofill** — checkbox saves credentials encrypted via Windows DPAPI (safeStorage); automatically restores your session next launch
- **Logout** — button in the header clears saved credentials and returns to login screen
- **In-game overlay** — transparent, always-on-top window (toggle: `Alt+G`)
- **Ad integration** — LootLabs ads in the desktop sidebar and overlay footer
- **WebSocket bridge** — port 7373, lets the web app push rosters automatically
- **Click-through mode** — 🖱 button in overlay lets game receive mouse input

---

## Setup

### Requirements
- Windows 10/11 (64-bit)
- Node.js 18+

### Install & run
```bash
npm install
npm start
```

### Build Windows installer
```bash
npm run build:win
# → dist/Source Tracker Overlay Setup.exe
```

---

## File structure

```
src/
  main.js                 — Electron main process (auth, roster, WS bridge)
  preload.js              — Secure IPC bridge (contextBridge)
  renderer/
    desktop.html          — Login screen + full dashboard companion
    overlay.html          — Transparent in-game overlay (Alt+G)
assets/
  icon.ico                — Replace with your own icon
```

---

## Login & credentials

- Username is verified against the public Ubisoft stats API (same as r6tracker.com)
- If "Save login & autofill" is checked, credentials are encrypted with `electron.safeStorage` (Windows DPAPI) and written to `%APPDATA%/source-tracker-overlay/st_creds.enc`
- On next launch the app reads and decrypts this file and signs you in automatically
- Clicking **Sign Out** deletes the credentials file and returns to the login screen
- The logout button also appears in the system tray context menu

---

## WebSocket bridge (port 7373)

Connects the web app to the overlay. In your browser's `App.jsx`:

```js
useEffect(() => {
  let ws;
  try {
    ws = new WebSocket('ws://127.0.0.1:7373');
    ws.onmessage = e => {
      const { type, payload } = JSON.parse(e.data);
      if (type === 'roster-update') {
        // payload.yourTeam[0..3], payload.enemyTeam[0..4]
      }
    };
    // Push roster into overlay:
    // ws.send(JSON.stringify({ type: 'roster-update', payload: { yourTeam, enemyTeam } }));
  } catch (_) {}
  return () => ws?.close();
}, []);
```

---

## Hotkeys

| Key | Action |
|---|---|
| `Alt+G` | Toggle overlay on/off |
| 🖱 button | Toggle click-through (game gets mouse clicks) |
