# Stagship Print Agent

A tiny system-tray Electron app that bridges Stagship (https://stagship.com) to an Epson TM-m30III receipt printer on the local network. Stagship POSTs ESC/POS bytes to `http://localhost:12345/print` and the agent forwards them to the printer over raw TCP on port 9100. No print dialog, no new tab, fully silent.

## Features

- System tray icon (green = printer reachable, red = unreachable / not configured)
- Local HTTP server on `http://localhost:12345`:
  - `POST /print` — body `{ "receipt": "<base64-ESC/POS>" }`
  - `GET  /status` — `{ "connected": true|false, "printerIp": "x.x.x.x" }`
- CORS allow-listed for `https://stagship.com` and `http://localhost:3000`
- Settings window with auto-discovery (LAN scan for port 9100)
- Auto-start on login (Mac LaunchServices entry, Windows HKCU registry)
- macOS: tray-only (no dock icon, `LSUIElement: true`)
- Windows: tray-only (no taskbar entry)

## Develop

```sh
npm install
npm start
```

The first build runs `scripts/generate-icons.js` to create the tray and app icons (pure-Node PNG encoder, no native dependencies).

## Package

```sh
npm run dist:mac    # → release/Stagship Print Agent-1.0.0.dmg
npm run dist:win    # → release/Stagship Print Agent Setup 1.0.0.exe
npm run dist:all    # both
```

Build outputs land in `release/`. Code signing is disabled — you'll see a Gatekeeper / SmartScreen warning on first launch until signing is added.

## How Stagship calls it

```ts
const bytes: Uint8Array = /* ESC/POS receipt bytes */;
const base64 = btoa(String.fromCharCode(...bytes));

const res = await fetch("http://localhost:12345/print", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ receipt: base64 }),
});
const { success, error } = await res.json();
```

If the agent isn't running or the printer is unreachable, `fetch` will throw or `success` will be `false` with an `error` field. Stagship can fall back to its current ePOS or HTML-receipt path.

## Config file location

- macOS: `~/Library/Application Support/Stagship Print Agent/config.json`
- Windows: `%APPDATA%\Stagship Print Agent\config.json`

```json
{
  "printerIp": "192.168.1.32",
  "printerPort": 9100,
  "autoStart": true,
  "lastPing": "ok"
}
```
