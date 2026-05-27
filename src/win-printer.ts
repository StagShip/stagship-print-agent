/**
 * Windows raw printer interface — no native addon required.
 *
 * Printing is done by writing ZPL to a temp file and handing it to the Windows
 * print spooler via `cmd /c print /D:"<name>" "<file>"`. This avoids any
 * managed-code GCHandle / P/Invoke pinning that can cause AccessViolationException
 * in a PowerShell child process.
 *
 * All exports are no-ops / empty results on non-Windows platforms.
 */
import { execFile, execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, unlinkSync } from "fs";

/** List all printers installed on the local Windows system. */
export async function listWindowsPrinters(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  return new Promise((resolve) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress",
      ],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err || !stdout.trim()) { resolve([]); return; }
        try {
          const parsed: unknown = JSON.parse(stdout.trim());
          // ConvertTo-Json returns a bare string (not array) when there is only
          // one printer, so normalise to an array in all cases.
          resolve(Array.isArray(parsed) ? (parsed as string[]) : [String(parsed)]);
        } catch {
          resolve([]);
        }
      },
    );
  });
}

/**
 * Send a ZPL label to a named Windows printer.
 *
 * Writes the ZPL string to a temp file, then calls:
 *   cmd /c print /D:"<printerName>" "<tempFilePath>"
 *
 * The Windows print command hands the file directly to the spooler with the
 * Zebra driver, which interprets the ZPL. Using a temp file avoids any managed
 * GCHandle / P/Invoke pinning that can cause AccessViolationException.
 *
 * Throws on any failure.
 */
export function sendRawToWindowsPrinter(
  printerName: string,
  data: Buffer | string,
): void {
  if (process.platform !== "win32") {
    throw new Error("sendRawToWindowsPrinter is only supported on Windows.");
  }

  const zpl = typeof data === "string" ? data : data.toString("utf8");
  const tmpFile = join(tmpdir(), `stagship-label-${Date.now()}.zpl`);
  writeFileSync(tmpFile, zpl, "utf8");

  try {
    // Strip any embedded double-quotes from the printer name to keep the
    // cmd string safe, then pass both arguments as a single /c string so
    // cmd's own parser handles the quoting for the /D: flag and file path.
    const safeName = printerName.replace(/"/g, "");
    execSync(`cmd /c print /D:"${safeName}" "${tmpFile}"`, {
      timeout: 15_000,
      stdio: "pipe",
    });
  } finally {
    try { unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
  }
}
