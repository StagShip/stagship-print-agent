import type { AgentConfig } from "./config";

/**
 * Resolve how to send ZPL to the label printer.
 * Explicit zebraPrintMode wins; otherwise infer from saved fields so IP-only
 * configs (legacy settings UI) still use TCP instead of defaulting to USB.
 */
export function getZebraPrintMode(cfg: AgentConfig): "usb" | "ip" {
  if (cfg.zebraPrintMode === "usb" || cfg.zebraPrintMode === "ip") {
    return cfg.zebraPrintMode;
  }
  if (cfg.zebraPrinterIp?.trim()) return "ip";
  if (cfg.zebraPrinterName?.trim()) return "usb";
  return "usb";
}
