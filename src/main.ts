/**
 * Electron entry — runs the tray, the local HTTP server, the periodic
 * printer-reachability ping, and the Settings window's IPC handlers.
 *
 * The app is "background-only": no dock icon on macOS (LSUIElement set in
 * electron-builder), no taskbar entry on Windows (skipTaskbar on the only
 * window we ever show, the Settings window).
 */
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  shell,
  dialog,
} from "electron";
import { autoUpdater } from "electron-updater";
import path from "path";
import type { Server } from "http";

import { getConfig, saveConfig } from "./config";
import { sendToPrinter, probeIp, buildTestReceiptBytes } from "./printer";
import { discoverPrinters } from "./discovery";
import { startServer } from "./server";

const HTTP_PORT = 12345;
const PING_INTERVAL_MS = 30_000;
/** Re-check GitHub for a newer release every 6 hours after the startup check. */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Icons live alongside the source tree. After packaging, electron-builder
// copies `assets/` into the app.asar and __dirname resolves inside that
// archive — Electron's patched fs handles the asar reads transparently.
const ASSETS_DIR = path.join(__dirname, "..", "assets");
const TRAY_GREEN  = path.join(ASSETS_DIR, "tray-green.png");
const TRAY_YELLOW = path.join(ASSETS_DIR, "tray-yellow.png");
const TRAY_RED    = path.join(ASSETS_DIR, "tray-red.png");

/** Tray state derived from both printers' reachability. */
type TrayState = "green" | "yellow" | "red";

let tray: Tray | null = null;
let settingsWin: BrowserWindow | null = null;
let httpServer: Server | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let receiptOnline = false;
let labelOnline = false;

// ── Single-instance lock ───────────────────────────────────────────────────
// If the user double-clicks the tray app while it's already running, just
// open Settings instead of spawning a second tray icon + a second listener
// on :12345 (which would EADDRINUSE).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => openSettings());
  app.whenReady().then(init).catch((err) => {
    console.error("init failed:", err);
    dialog.showErrorBox("Stagship Print Agent", `Failed to start: ${err.message}`);
    app.quit();
  });
}

// macOS: hide the dock icon. We're a tray-only app — the LSUIElement Info.plist
// flag handles this in production, but in dev (running via `electron .`) we
// also need this runtime call so the dock doesn't bounce on launch.
if (process.platform === "darwin" && app.dock) {
  app.dock.hide();
}

// Closing the Settings window must NOT quit the app — the tray keeps running.
// In Electron, the default `window-all-closed` handler calls app.quit() only
// when no listener is registered; registering a noop listener is the supported
// way to opt out of that default.
app.on("window-all-closed", () => {
  /* tray-only app — do not quit */
});

async function init(): Promise<void> {
  // Set name early so userData path resolves to the right folder before the
  // first config read. Without this, on dev runs the path defaults to
  // "Electron" which separates dev + packaged config files unintentionally.
  app.setName("Stagship Print Agent");

  await applyAutoStartFromConfig();
  createTray();
  await startHttpServer();
  schedulePingLoop();
  scheduleAutoUpdates();
}

// ── Auto-update via GitHub Releases ───────────────────────────────────────
// electron-updater downloads the latest `latest.yml` + matching .exe / .dmg
// from the GitHub release marked "latest" for the repo declared in
// package.json#build.publish, verifies the SHA-512, and applies on quit.
// All notifications are suppressed — updates install silently in the
// background, then take effect the next time the user (or login auto-start)
// launches the agent.
function scheduleAutoUpdates(): void {
  if (!app.isPackaged) {
    // Skip in dev: electron-updater requires a real Squirrel/NSIS install dir
    // and a signed app-update.yml shipped by electron-builder.
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("error", (err) => console.error("[autoUpdater]", err));
  autoUpdater.on("update-available", (info) =>
    console.log(`[autoUpdater] update ${info.version} available — downloading`),
  );
  autoUpdater.on("update-downloaded", (info) =>
    console.log(`[autoUpdater] ${info.version} downloaded — will install on quit`),
  );

  // Initial check ~5s after startup so the UI is responsive first.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => console.error("[autoUpdater]", e));
  }, 5_000);
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((e) => console.error("[autoUpdater]", e));
  }, UPDATE_CHECK_INTERVAL_MS);
}

// ── Auto-start on login ───────────────────────────────────────────────────
async function applyAutoStartFromConfig(): Promise<void> {
  const cfg = getConfig();
  // Default-on: if the user hasn't explicitly opted out, register login item.
  // setLoginItemSettings does the right thing per-platform:
  //   macOS  → LaunchServices entry
  //   Windows → HKCU\Software\Microsoft\Windows\CurrentVersion\Run
  const enabled = cfg.autoStart !== false;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
  });
  if (cfg.autoStart === undefined) saveConfig({ autoStart: true });
}

// ── Tray ──────────────────────────────────────────────────────────────────
/**
 * Derive a tri-state tray colour from the two printers' reachability,
 * but only count printers the user has actually configured. If both are
 * unconfigured, we show red (nothing to do).
 *   green   — every configured printer is reachable
 *   yellow  — at least one reachable, at least one unreachable
 *   red     — nothing reachable (or nothing configured)
 */
function computeTrayState(): TrayState {
  const cfg = getConfig();
  const hasReceipt = !!cfg.printerIp;
  const hasLabel   = !!cfg.zebraPrinterIp;
  if (!hasReceipt && !hasLabel) return "red";

  const receiptOk = hasReceipt && receiptOnline;
  const labelOk   = hasLabel   && labelOnline;
  const receiptBad = hasReceipt && !receiptOnline;
  const labelBad   = hasLabel   && !labelOnline;

  if ((receiptOk || !hasReceipt) && (labelOk || !hasLabel)) return "green";
  if (receiptOk || labelOk) return "yellow";
  if (receiptBad || labelBad) return "red";
  return "red";
}

function trayImage(state: TrayState): Electron.NativeImage {
  const file = state === "green" ? TRAY_GREEN : state === "yellow" ? TRAY_YELLOW : TRAY_RED;
  return nativeImage
    .createFromPath(file)
    .resize({ width: 16, height: 16, quality: "best" });
}

function createTray(): void {
  tray = new Tray(trayImage("red"));
  tray.setToolTip("Stagship Print Agent");
  rebuildMenu();
  // On Windows, left-click should open the menu; on macOS it already does.
  if (process.platform !== "darwin") {
    tray.on("click", () => tray?.popUpContextMenu());
    tray.on("double-click", () => openSettings());
  }
}

function rebuildMenu(): void {
  if (!tray) return;
  const cfg = getConfig();

  const receiptLabel = !cfg.printerIp
    ? "Receipt printer: not configured"
    : receiptOnline
      ? `Receipt: online — ${cfg.printerIp}`
      : `Receipt: offline — ${cfg.printerIp}`;
  const labelLabel = !cfg.zebraPrinterIp
    ? "Label printer: not configured"
    : labelOnline
      ? `Label: online — ${cfg.zebraPrinterIp}`
      : `Label: offline — ${cfg.zebraPrinterIp}`;

  const state = computeTrayState();
  const stateText = state === "green" ? "All printers online" : state === "yellow" ? "Some printers offline" : "Printers offline";

  const menu = Menu.buildFromTemplate([
    { label: "Stagship Print Agent", enabled: false },
    { label: stateText, enabled: false },
    { type: "separator" },
    { label: receiptLabel, enabled: false },
    { label: labelLabel, enabled: false },
    { type: "separator" },
    { label: "Settings…", click: () => openSettings() },
    {
      label: "Print Test Receipt",
      enabled: !!cfg.printerIp,
      click: () => void runTestPrint(),
    },
    { type: "separator" },
    {
      label: "Open config folder",
      click: () => shell.showItemInFolder(path.join(app.getPath("userData"), "config.json")),
    },
    { type: "separator" },
    { label: "Quit", click: () => quitApp() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`Stagship Print Agent — ${stateText}`);
}

function refreshTrayAppearance(): void {
  if (tray) tray.setImage(trayImage(computeTrayState()));
  rebuildMenu();
}

function setReceiptStatus(online: boolean): void {
  const changed = receiptOnline !== online;
  receiptOnline = online;
  if (changed) saveConfig({ lastPing: online ? "ok" : "fail" });
  refreshTrayAppearance();
}

function setLabelStatus(online: boolean): void {
  const changed = labelOnline !== online;
  labelOnline = online;
  if (changed) saveConfig({ lastZebraPing: online ? "ok" : "fail" });
  refreshTrayAppearance();
}

// ── Settings window ───────────────────────────────────────────────────────
function openSettings(): void {
  if (settingsWin) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 520,
    height: 600,
    title: "Stagship Print Agent",
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: process.platform === "win32",
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.removeMenu();
  settingsWin.loadFile(path.join(__dirname, "renderer", "settings.html"));
  settingsWin.once("ready-to-show", () => settingsWin?.show());
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────
async function startHttpServer(): Promise<void> {
  try {
    httpServer = await startServer(HTTP_PORT);
    console.log(`Print Agent listening on http://127.0.0.1:${HTTP_PORT}`);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      dialog.showErrorBox(
        "Stagship Print Agent",
        `Port ${HTTP_PORT} is already in use. Another instance of the agent (or another app) is bound to it. Quit the other instance and try again.`,
      );
    } else {
      dialog.showErrorBox("Stagship Print Agent", `HTTP server failed to start: ${e.message}`);
    }
    throw e;
  }
}

// ── Ping loop ─────────────────────────────────────────────────────────────
async function pingBoth(): Promise<void> {
  const cfg = getConfig();

  const receiptOk = cfg.printerIp
    ? await probeIp(cfg.printerIp, cfg.printerPort ?? 9100, 1_500)
    : false;
  setReceiptStatus(receiptOk);

  const labelOk = cfg.zebraPrinterIp
    ? await probeIp(cfg.zebraPrinterIp, cfg.zebraPrinterPort ?? 9100, 1_500)
    : false;
  setLabelStatus(labelOk);
}

function schedulePingLoop(): void {
  void pingBoth();
  pingTimer = setInterval(() => void pingBoth(), PING_INTERVAL_MS);
}

// ── Test print ────────────────────────────────────────────────────────────
async function runTestPrint(): Promise<{ success: boolean; error?: string }> {
  const cfg = getConfig();
  if (!cfg.printerIp) {
    openSettings();
    return { success: false, error: "No printer configured." };
  }
  try {
    await sendToPrinter(cfg.printerIp, cfg.printerPort ?? 9100, buildTestReceiptBytes(), 5_000);
    setReceiptStatus(true);
    return { success: true };
  } catch (err) {
    setReceiptStatus(false);
    return { success: false, error: (err as Error).message };
  }
}

/** Minimal ZPL "self-test" sticker so the user can confirm the Zebra is alive. */
function buildTestLabelZpl(): string {
  return [
    "^XA",
    "^CF0,50",
    "^FO40,40^FDSTAGSHIP^FS",
    "^CF0,28",
    "^FO40,110^FDPrint Agent test label^FS",
    "^FO40,160^FD" + new Date().toLocaleString() + "^FS",
    "^FO40,220^FDIf you see this, the Zebra is connected.^FS",
    "^XZ",
  ].join("\n");
}

async function runTestLabel(): Promise<{ success: boolean; error?: string }> {
  const cfg = getConfig();
  if (!cfg.zebraPrinterIp) {
    openSettings();
    return { success: false, error: "No label printer configured." };
  }
  try {
    await sendToPrinter(
      cfg.zebraPrinterIp,
      cfg.zebraPrinterPort ?? 9100,
      Buffer.from(buildTestLabelZpl(), "utf8"),
      5_000,
    );
    setLabelStatus(true);
    return { success: true };
  } catch (err) {
    setLabelStatus(false);
    return { success: false, error: (err as Error).message };
  }
}

// ── IPC bridge for the Settings window ────────────────────────────────────
ipcMain.handle("config:get", () => getConfig());

ipcMain.handle("config:save", async (_e, patch: Record<string, unknown>) => {
  // Whitelist what the renderer can change — never let it write arbitrary keys.
  const safe: Record<string, unknown> = {};
  if (typeof patch.printerIp === "string")        safe.printerIp        = patch.printerIp.trim();
  if (typeof patch.printerPort === "number")      safe.printerPort      = patch.printerPort;
  if (typeof patch.zebraPrinterIp === "string")   safe.zebraPrinterIp   = patch.zebraPrinterIp.trim();
  if (typeof patch.zebraPrinterPort === "number") safe.zebraPrinterPort = patch.zebraPrinterPort;
  if (typeof patch.autoStart === "boolean") {
    safe.autoStart = patch.autoStart;
    app.setLoginItemSettings({ openAtLogin: patch.autoStart, openAsHidden: true });
  }
  const next = saveConfig(safe);
  // Re-ping immediately so the tray flips colour without waiting 30s.
  await pingBoth();
  return next;
});

ipcMain.handle("printer:test", () => runTestPrint());
ipcMain.handle("printer:test-label", () => runTestLabel());

ipcMain.handle("printer:scan", async (event) => {
  const send = (frac: number) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send("printer:scan-progress", frac);
    }
  };
  return await discoverPrinters(send);
});

ipcMain.handle("autostart:get", () => app.getLoginItemSettings().openAtLogin);

// ── Quit ──────────────────────────────────────────────────────────────────
function quitApp(): void {
  if (pingTimer) clearInterval(pingTimer);
  if (httpServer) {
    try {
      httpServer.close();
    } catch {
      /* noop */
    }
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
  app.quit();
}
