/**
 * Raw TCP printing to ESC/POS network printers (Epson TM-m30III on port 9100).
 *
 * The printer accepts plain ESC/POS bytes over a TCP socket — no protocol
 * handshake, no terminator. We open a socket, write the byte stream, then
 * close. The "print job done" signal is the FIN we receive when the printer
 * closes the connection (or our own end() if the printer ignores FIN).
 */
import { Socket } from "net";

/**
 * Send raw ESC/POS bytes to the printer.
 *
 * @param ip      Printer IPv4 address.
 * @param port    Printer raw-TCP port (Epson default is 9100).
 * @param bytes   Pre-rendered ESC/POS payload (init + lines + cut + drawer kick).
 * @param timeoutMs Hard cap on the whole send. Default 10s — typical TM-m30III prints in ~1s.
 */
export function sendToPrinter(
  ip: string,
  port: number,
  bytes: Buffer,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* swallow — already-destroyed socket throws */
      }
      err ? reject(err) : resolve();
    };

    socket.setTimeout(timeoutMs);

    socket.once("connect", () => {
      socket.write(bytes, (err) => {
        if (err) return finish(err);
        // Half-close: tell the printer "we're done sending". The printer will
        // typically close from its side once it has consumed the data.
        socket.end();
      });
    });

    // Printer closed cleanly OR our end() round-tripped — treat as success.
    socket.once("close", (hadErr) => {
      if (hadErr) return finish(new Error("Printer connection closed with error"));
      finish();
    });

    socket.once("timeout", () => finish(new Error("Printer connection timed out")));
    socket.once("error", (err) => finish(err));

    socket.connect(port, ip);
  });
}

/**
 * Quick reachability probe: open a TCP socket, succeed if it connects.
 *
 * Used by:
 *   - The 30-second tray status loop (green vs red icon)
 *   - The discovery sweep (every IP on the LAN)
 *   - The /status HTTP endpoint
 */
export function probeIp(ip: string, port = 9100, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* noop */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect(port, ip);
    } catch {
      finish(false);
    }
  });
}

/**
 * Build a tiny ESC/POS test receipt — used by the tray "Print Test Receipt"
 * action and the Settings → Test Print button. Includes init, double-size
 * heading, body, partial cut.
 */
export function buildTestReceiptBytes(): Buffer {
  const ESC = 0x1b;
  const GS = 0x1d;
  const LF = 0x0a;
  const parts: Buffer[] = [
    Buffer.from([ESC, 0x40]),                       // initialize
    Buffer.from([ESC, 0x61, 0x01]),                 // align center
    Buffer.from([GS, 0x21, 0x11]),                  // double width + height
    Buffer.from("STAGSHIP\n", "utf8"),
    Buffer.from([GS, 0x21, 0x00]),                  // normal size
    Buffer.from("Print Agent Test\n", "utf8"),
    Buffer.from([LF]),
    Buffer.from("If you can read this,\n", "utf8"),
    Buffer.from("your printer is connected.\n", "utf8"),
    Buffer.from([LF, LF]),
    Buffer.from(new Date().toLocaleString() + "\n", "utf8"),
    Buffer.from([LF, LF, LF, LF]),
    Buffer.from([GS, 0x56, 0x42, 0x00]),            // partial cut, feed before cut
  ];
  return Buffer.concat(parts);
}
