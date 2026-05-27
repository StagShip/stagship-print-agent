/**
 * Settings window — talks to main via the `window.api` surface from preload.ts.
 * Pure DOM, no framework. Compiled to ES2020 module by tsconfig.renderer.json.
 */

type AgentConfig = {
  printerIp?: string;
  printerPort?: number;
  zebraPrintMode?: "usb" | "ip";
  zebraPrinterName?: string;
  zebraPrinterIp?: string;
  zebraPrinterPort?: number;
  autoStart?: boolean;
  lastPing?: "ok" | "fail";
  lastZebraPing?: "ok" | "fail";
};

type Api = {
  getConfig(): Promise<AgentConfig>;
  saveConfig(patch: Partial<AgentConfig>): Promise<AgentConfig>;
  testPrint(): Promise<{ success: boolean; error?: string }>;
  testLabelPrint(): Promise<{ success: boolean; error?: string }>;
  scanForPrinters(onProgress: (frac: number) => void): Promise<string[]>;
  listPrinters(): Promise<string[]>;
  getAutoStart(): Promise<boolean>;
  getVersion(): Promise<string>;
};

declare global {
  interface Window {
    api: Api;
  }
}

const api = window.api;

// ── Receipt printer elements ──────────────────────────────────────────────
const ipInput       = document.getElementById("ip") as HTMLInputElement;
const foundSelect   = document.getElementById("found") as HTMLSelectElement;
const scanBtn       = document.getElementById("scan") as HTMLButtonElement;
const testBtn       = document.getElementById("test") as HTMLButtonElement;
const saveBtn       = document.getElementById("save") as HTMLButtonElement;
const autoStartChk  = document.getElementById("autostart") as HTMLInputElement;
const statusEl      = document.getElementById("status") as HTMLDivElement;
const progressTrack = document.getElementById("progress-track") as HTMLDivElement;
const progressBar   = document.getElementById("progress-bar") as HTMLDivElement;

// ── Label printer elements ────────────────────────────────────────────────
const modeUsbRadio      = document.getElementById("modeUsb") as HTMLInputElement;
const modeIpRadio       = document.getElementById("modeIp") as HTMLInputElement;
const usbFields         = document.getElementById("usbFields") as HTMLDivElement;
const ipFields          = document.getElementById("ipFields") as HTMLDivElement;
const zprinterSelect    = document.getElementById("zprinterSelect") as HTMLSelectElement;
const zrefreshBtn       = document.getElementById("zrefresh") as HTMLButtonElement;
const zipInput          = document.getElementById("zip") as HTMLInputElement;
const zportInput        = document.getElementById("zport") as HTMLInputElement;
const ztestBtn          = document.getElementById("ztest") as HTMLButtonElement;
const zsaveBtn          = document.getElementById("zsave") as HTMLButtonElement;
const zstatusEl         = document.getElementById("zstatus") as HTMLDivElement;
const versionEl         = document.getElementById("version") as HTMLParagraphElement;

// ── Helpers ───────────────────────────────────────────────────────────────
type StatusKind = "info" | "ok" | "error" | "empty";

function setStatus(kind: StatusKind, text: string): void {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = text || "\u00A0";
}

function setZStatus(kind: StatusKind, text: string): void {
  zstatusEl.className = `status ${kind}`;
  zstatusEl.textContent = text || "\u00A0";
}

function setProgress(visible: boolean, frac = 0): void {
  progressTrack.style.display = visible ? "block" : "none";
  progressBar.style.width = `${Math.round(frac * 100)}%`;
}

function ipLooksValid(s: string): boolean {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function currentMode(): "usb" | "ip" {
  return modeIpRadio.checked ? "ip" : "usb";
}

/** Show or hide USB vs IP field groups based on the active radio. */
function applyModeUI(): void {
  const isUsb = currentMode() === "usb";
  usbFields.style.display = isUsb ? "" : "none";
  ipFields.style.display  = isUsb ? "none" : "";
}

// ── Printer list (USB mode) ───────────────────────────────────────────────
async function refreshPrinterList(selectName?: string): Promise<void> {
  zrefreshBtn.disabled = true;
  try {
    const names = await api.listPrinters();
    zprinterSelect.innerHTML = names.length
      ? names.map((n) => `<option value="${n}">${n}</option>`).join("")
      : `<option value="">— no printers found —</option>`;
    if (selectName) {
      // Restore previously saved selection if it's still in the list.
      const match = names.find((n) => n === selectName);
      if (match) zprinterSelect.value = match;
    }
  } catch {
    zprinterSelect.innerHTML = `<option value="">— could not load printers —</option>`;
  } finally {
    zrefreshBtn.disabled = false;
  }
}

// ── Load config on open ───────────────────────────────────────────────────
async function load(): Promise<void> {
  const cfg = await api.getConfig();

  // Receipt printer
  if (cfg.printerIp) {
    ipInput.value = cfg.printerIp;
    setStatus(
      cfg.lastPing === "ok" ? "ok" : "info",
      cfg.lastPing === "ok"
        ? `Connected to ${cfg.printerIp}.`
        : `Saved ${cfg.printerIp} — not currently reachable.`,
    );
  } else {
    setStatus("info", "No receipt printer configured. Tap Scan Network to find one.");
  }

  // Label printer — restore saved mode
  const savedMode = cfg.zebraPrintMode ?? "usb";
  if (savedMode === "ip") {
    modeIpRadio.checked = true;
  } else {
    modeUsbRadio.checked = true;
  }
  applyModeUI();

  if (savedMode === "usb") {
    await refreshPrinterList(cfg.zebraPrinterName);
    const hasName = !!cfg.zebraPrinterName;
    setZStatus(
      hasName ? (cfg.lastZebraPing === "ok" ? "ok" : "info") : "info",
      hasName
        ? cfg.lastZebraPing === "ok"
          ? `Connected — ${cfg.zebraPrinterName}.`
          : `Saved "${cfg.zebraPrinterName}" — select & test to confirm.`
        : "No USB printer selected. Refresh and pick one from the list.",
    );
  } else {
    if (cfg.zebraPrinterIp) {
      zipInput.value = cfg.zebraPrinterIp;
      zportInput.value = String(cfg.zebraPrinterPort ?? 9100);
      setZStatus(
        cfg.lastZebraPing === "ok" ? "ok" : "info",
        cfg.lastZebraPing === "ok"
          ? `Connected to ${cfg.zebraPrinterIp}.`
          : `Saved ${cfg.zebraPrinterIp} — not currently reachable.`,
      );
    } else {
      zportInput.value = "9100";
      setZStatus("info", "No label printer IP configured. Enter the Zebra's IP and tap Save.");
    }
  }

  autoStartChk.checked = await api.getAutoStart();

  try {
    const version = await api.getVersion();
    versionEl.textContent = `Version ${version}`;
  } catch {
    versionEl.textContent = "\u00A0";
  }
}

// ── Receipt printer actions ───────────────────────────────────────────────
async function scan(): Promise<void> {
  scanBtn.disabled = true;
  testBtn.disabled = true;
  saveBtn.disabled = true;
  foundSelect.style.display = "none";
  foundSelect.innerHTML = "";
  setStatus("info", "Scanning local network for printers…");
  setProgress(true, 0);

  try {
    const ips = await api.scanForPrinters((frac) => setProgress(true, frac));
    setProgress(false);

    if (ips.length === 0) {
      setStatus("error", "No printers found. Check the printer is on and on the same network.");
      return;
    }
    if (ips.length === 1) {
      ipInput.value = ips[0];
      await api.saveConfig({ printerIp: ips[0] });
      setStatus("ok", `Auto-saved ${ips[0]}.`);
      return;
    }
    foundSelect.style.display = "block";
    foundSelect.innerHTML = ips
      .map((ip) => `<option value="${ip}">${ip}</option>`)
      .join("");
    ipInput.value = ips[0];
    setStatus("info", `Found ${ips.length} devices. Pick the right one and tap Test Print to confirm.`);
  } catch (err) {
    setProgress(false);
    setStatus("error", `Scan failed: ${(err as Error).message}`);
  } finally {
    scanBtn.disabled = false;
    testBtn.disabled = false;
    saveBtn.disabled = false;
  }
}

async function save(): Promise<void> {
  const ip = ipInput.value.trim();
  if (!ipLooksValid(ip)) {
    setStatus("error", "That doesn't look like a valid IPv4 address.");
    return;
  }
  saveBtn.disabled = true;
  setStatus("info", `Saving ${ip}…`);
  try {
    await api.saveConfig({ printerIp: ip });
    setStatus("ok", `Saved ${ip}.`);
  } catch (err) {
    setStatus("error", `Failed to save: ${(err as Error).message}`);
  } finally {
    saveBtn.disabled = false;
  }
}

async function test(): Promise<void> {
  const ip = ipInput.value.trim();
  if (!ipLooksValid(ip)) {
    setStatus("error", "Enter a printer IP first.");
    return;
  }
  testBtn.disabled = true;
  setStatus("info", "Sending test receipt…");
  try {
    await api.saveConfig({ printerIp: ip });
    const result = await api.testPrint();
    if (result.success) {
      setStatus("ok", "Test receipt sent. Check the printer.");
    } else {
      setStatus("error", `Test print failed: ${result.error ?? "unknown error"}`);
    }
  } catch (err) {
    setStatus("error", `Test print failed: ${(err as Error).message}`);
  } finally {
    testBtn.disabled = false;
  }
}

// ── Label printer actions ─────────────────────────────────────────────────
async function zsave(): Promise<void> {
  const mode = currentMode();
  zsaveBtn.disabled = true;

  try {
    if (mode === "usb") {
      const name = zprinterSelect.value;
      if (!name) {
        setZStatus("error", "Select a printer from the list first.");
        return;
      }
      setZStatus("info", `Saving "${name}"…`);
      await api.saveConfig({ zebraPrintMode: "usb", zebraPrinterName: name });
      setZStatus("ok", `Saved "${name}".`);
    } else {
      const ip = zipInput.value.trim();
      if (!ipLooksValid(ip)) {
        setZStatus("error", "That doesn't look like a valid IPv4 address.");
        return;
      }
      const portStr = zportInput.value.trim();
      const port = portStr ? parseInt(portStr, 10) : 9100;
      if (isNaN(port) || port < 1 || port > 65535) {
        setZStatus("error", "Port must be a number between 1 and 65535.");
        return;
      }
      setZStatus("info", `Saving ${ip}:${port}…`);
      await api.saveConfig({ zebraPrintMode: "ip", zebraPrinterIp: ip, zebraPrinterPort: port });
      setZStatus("ok", `Saved ${ip}:${port}.`);
    }
  } catch (err) {
    setZStatus("error", `Failed to save: ${(err as Error).message}`);
  } finally {
    zsaveBtn.disabled = false;
  }
}

async function ztest(): Promise<void> {
  const mode = currentMode();
  ztestBtn.disabled = true;

  try {
    if (mode === "usb") {
      const name = zprinterSelect.value;
      if (!name) {
        setZStatus("error", "Select a printer from the list first.");
        return;
      }
      setZStatus("info", "Sending test label…");
      await api.saveConfig({ zebraPrintMode: "usb", zebraPrinterName: name });
      const result = await api.testLabelPrint();
      if (result.success) {
        setZStatus("ok", "Test label sent. Check the Zebra.");
      } else {
        setZStatus("error", `Test label failed: ${result.error ?? "unknown error"}`);
      }
    } else {
      const ip = zipInput.value.trim();
      if (!ipLooksValid(ip)) {
        setZStatus("error", "Enter a label printer IP first.");
        return;
      }
      const portStr = zportInput.value.trim();
      const port = portStr ? parseInt(portStr, 10) : 9100;
      setZStatus("info", "Sending test label…");
      await api.saveConfig({ zebraPrintMode: "ip", zebraPrinterIp: ip, zebraPrinterPort: port });
      const result = await api.testLabelPrint();
      if (result.success) {
        setZStatus("ok", "Test label sent. Check the Zebra.");
      } else {
        setZStatus("error", `Test label failed: ${result.error ?? "unknown error"}`);
      }
    }
  } catch (err) {
    setZStatus("error", `Test label failed: ${(err as Error).message}`);
  } finally {
    ztestBtn.disabled = false;
  }
}

// ── Event listeners ───────────────────────────────────────────────────────
scanBtn.addEventListener("click", (e) => { e.preventDefault(); void scan(); });
saveBtn.addEventListener("click", (e) => { e.preventDefault(); void save(); });
testBtn.addEventListener("click", (e) => { e.preventDefault(); void test(); });
foundSelect.addEventListener("change", () => { ipInput.value = foundSelect.value; });

modeUsbRadio.addEventListener("change", () => {
  applyModeUI();
  if (currentMode() === "usb") void refreshPrinterList();
});
modeIpRadio.addEventListener("change", () => {
  applyModeUI();
  if (!zportInput.value) zportInput.value = "9100";
});

zrefreshBtn.addEventListener("click", (e) => { e.preventDefault(); void refreshPrinterList(); });
zsaveBtn.addEventListener("click", (e) => { e.preventDefault(); void zsave(); });
ztestBtn.addEventListener("click", (e) => { e.preventDefault(); void ztest(); });

autoStartChk.addEventListener("change", () => {
  void api.saveConfig({ autoStart: autoStartChk.checked });
});

void load();

export {};
