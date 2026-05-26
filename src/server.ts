/**
 * Local HTTP bridge — Stagship → Print Agent → Printer.
 *
 *   POST /print  → forwards ESC/POS bytes to the configured printer over TCP
 *   GET  /status → reports the last reachability check + configured printer
 *
 * The server binds to 127.0.0.1 only — never 0.0.0.0 — so no other host on
 * the LAN can drive the printer through this agent. CORS is allow-listed to
 * the production Stagship origin and the localhost Next.js dev origin.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "http";
import { sendToPrinter, probeIp } from "./printer";
import { getConfig, saveConfig } from "./config";

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

  app.get("/status", async (_req, res) => {
    const cfg = getConfig();
    if (!cfg.printerIp) {
      res.json({ connected: false, printerIp: null });
      return;
    }
    // Trust the cached ping if the loop already updated it; otherwise probe.
    const cachedOk = cfg.lastPing === "ok";
    if (cachedOk) {
      res.json({ connected: true, printerIp: cfg.printerIp });
      return;
    }
    const ok = await probeIp(cfg.printerIp, cfg.printerPort ?? 9100, 1_000);
    saveConfig({ lastPing: ok ? "ok" : "fail" });
    res.json({ connected: ok, printerIp: cfg.printerIp });
  });

  // Friendly root so a curious user hitting localhost:12345 sees something.
  app.get("/", (_req, res) => {
    res.type("text/plain").send(
      "Stagship Print Agent — POST /print { receipt: base64 } or GET /status\n",
    );
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}
