/**
 * Local HTTP bridge — Stagship → Print Agent → Printers.
 *
 *   POST /print        → ESC/POS bytes (base64) → Epson receipt printer (TCP 9100)
 *   POST /print-label  → raw ZPL string         → Zebra label printer  (TCP 9100)
 *   GET  /status       → connectivity + IPs for both printers
 *
 * The server binds to 127.0.0.1 only — never 0.0.0.0 — so no other host on
 * the LAN can drive the printers through this agent. CORS is allow-listed to
 * the production Stagship origin and the localhost Next.js dev origin.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "http";
import { sendToPrinter, probeIp } from "./printer";
import { getConfig, saveConfig } from "./config";
import { sendRawToWindowsPrinter } from "./win-printer";

const ALLOWED_ORIGINS = new Set<string>([
  "https://stagship.com",
  "https://www.stagship.com",
  "http://localhost:3000",
]);

/** CORS — narrow allow-list so curl/other origins don't hit the printer. */
function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

export function startServer(port = 12345): Promise<Server> {
  const app = express();
  // 5MB is generous — even a huge label receipt is < 100KB of ESC/POS.
  app.use(express.json({ limit: "5mb" }));
  app.use(corsMiddleware);

  app.post("/print", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { receipt?: unknown };
    if (typeof body.receipt !== "string" || body.receipt.length === 0) {
      res.status(400).json({
        success: false,
        error: "Missing or empty 'receipt' field (expected base64 ESC/POS).",
      });
      return;
    }

    const cfg = getConfig();
    if (!cfg.printerIp) {
      res.status(503).json({
        success: false,
        error: "No printer configured — open the agent and pick a printer first.",
      });
      return;
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.receipt, "base64");
      if (bytes.length === 0) throw new Error("empty payload after decode");
    } catch (e) {
      res.status(400).json({
        success: false,
        error: `Invalid base64 receipt: ${(e as Error).message}`,
      });
      return;
    }

    try {
      await sendToPrinter(cfg.printerIp, cfg.printerPort ?? 9100, bytes);
      saveConfig({ lastPing: "ok" });
      res.json({ success: true });
    } catch (e) {
      saveConfig({ lastPing: "fail" });
      res.status(502).json({ success: false, error: (e as Error).message });
    }
  });

  app.post("/print-label", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { zpl?: unknown; url?: unknown };

    // Accept either a pre-fetched ZPL string or a remote URL to fetch from.
    // The URL path is preferred by the web client — it lets Node.js do the
    // fetch (no CORS restrictions) instead of the browser.
    let zplString: string;
    if (typeof body.url === "string" && body.url.length > 0) {
      try {
        const r = await fetch(body.url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        zplString = await r.text();
      } catch (e) {
        res.status(502).json({
          success: false,
          error: `Failed to fetch ZPL from URL: ${(e as Error).message}`,
        });
        return;
      }
    } else if (typeof body.zpl === "string" && body.zpl.length > 0) {
      zplString = body.zpl;
    } else {
      res.status(400).json({
        success: false,
        error: "Missing or empty 'zpl' string or 'url' field (expected ZPL string or label URL).",
      });
      return;
    }

    const cfg = getConfig();
    const mode = cfg.zebraPrintMode ?? "usb";

    if (mode === "usb") {
      if (process.platform !== "win32") {
        res.status(503).json({
          success: false,
          error: "USB printing is only supported on Windows. Switch to IP/Network mode on this machine.",
        });
        return;
      }

      const printerName = cfg.zebraPrinterName;
      if (!printerName) {
        res.status(503).json({
          success: false,
          error: "No USB label printer configured — open the agent and select a printer.",
        });
        return;
      }

      try {
        sendRawToWindowsPrinter(printerName, zplString);
        saveConfig({ lastZebraPing: "ok" });
        res.json({ success: true });
      } catch (e) {
        saveConfig({ lastZebraPing: "fail" });
        res.status(502).json({ success: false, error: (e as Error).message });
      }
    } else {
      // IP / TCP mode — send ZPL bytes directly to the printer socket.
      if (!cfg.zebraPrinterIp) {
        res.status(503).json({
          success: false,
          error: "No label printer IP configured — open the agent and set the Zebra IP first.",
        });
        return;
      }

      // ZPL is plain ASCII text — send it as UTF-8 bytes (ASCII is a subset).
      const bytes = Buffer.from(zplString, "utf8");

      try {
        await sendToPrinter(cfg.zebraPrinterIp, cfg.zebraPrinterPort ?? 9100, bytes);
        saveConfig({ lastZebraPing: "ok" });
        res.json({ success: true });
      } catch (e) {
        saveConfig({ lastZebraPing: "fail" });
        res.status(502).json({ success: false, error: (e as Error).message });
      }
    }
  });

  app.get("/status", async (_req, res) => {
    const cfg = getConfig();

    // Receipt printer (Epson)
    let receiptConnected = false;
    if (cfg.printerIp) {
      receiptConnected = cfg.lastPing === "ok"
        ? true
        : await probeIp(cfg.printerIp, cfg.printerPort ?? 9100, 1_000);
      saveConfig({ lastPing: receiptConnected ? "ok" : "fail" });
    }

    // Label printer (Zebra)
    let labelConnected = false;
    if (cfg.zebraPrinterIp) {
      labelConnected = cfg.lastZebraPing === "ok"
        ? true
        : await probeIp(cfg.zebraPrinterIp, cfg.zebraPrinterPort ?? 9100, 1_000);
      saveConfig({ lastZebraPing: labelConnected ? "ok" : "fail" });
    }

    res.json({
      // Legacy single-printer fields kept for backward compatibility with the
      // existing Stagship POS client that only looks at `connected` + `printerIp`.
      connected: receiptConnected,
      printerIp: cfg.printerIp ?? null,
      // New per-device fields.
      receipt: { connected: receiptConnected, ip: cfg.printerIp ?? null },
      label:   { connected: labelConnected,   ip: cfg.zebraPrinterIp ?? null },
    });
  });

  // Friendly root so a curious user hitting localhost:12345 sees something.
  app.get("/", (_req, res) => {
    res.type("text/plain").send(
      "Stagship Print Agent\n" +
      "  POST /print        { receipt: base64-escpos } → Epson receipt printer\n" +
      "  POST /print-label  { zpl: \"<zpl>\" }            → Zebra label printer\n" +
      "  GET  /status                                  → connectivity per device\n",
    );
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}
