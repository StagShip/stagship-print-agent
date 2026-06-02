/**
 * Windows raw printer interface — no native addon required.
 *
 * Printing uses the Win32 winspool.drv API via inline C# compiled by
 * PowerShell Add-Type. The job is submitted with pDataType="RAW" so ZPL
 * bytes reach the Zebra driver unmodified — the driver interprets them
 * directly rather than routing through GDI text rendering.
 *
 * The legacy `cmd /c print /D:` approach returned exit 0 on modern Windows
 * USB queues but never actually spooled the job, so it has been replaced.
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
 * Send a ZPL label to a named Windows printer using the Win32 raw print API.
 *
 * Writes the ZPL string to a temp .zpl file and a PowerShell script to a
 * temp .ps1 file. The script uses Add-Type to compile a small C# class that
 * calls OpenPrinter / StartDocPrinter (pDataType="RAW") / WritePrinter /
 * EndDocPrinter — the same sequence used by every Zebra-certified Windows
 * print utility. The RAW data type tells the spooler to pass bytes straight
 * to the driver without any GDI processing.
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
  const ts = Date.now();
  const tmpZpl = join(tmpdir(), `stagship-label-${ts}.zpl`);
  const tmpPs1 = join(tmpdir(), `stagship-print-${ts}.ps1`);
  writeFileSync(tmpZpl, zpl, "utf8");

  // Escape single quotes in values embedded in single-quoted PS strings.
  const safeName = printerName.replace(/'/g, "''");
  // tmpZpl only contains digits, letters, backslashes, colons, and dots —
  // no escaping needed for a single-quoted PS string.

  const script = `
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class RawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFOW {
        public string pDocName;
        public string pOutputFile;
        public string pDataType;
    }
    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int StartDocPrinter(IntPtr hPrinter, int Level,
        [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOW pDocInfo);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes,
        int dwCount, out int dwWritten);
    public static void Print(string printerName, string filePath) {
        byte[] bytes = File.ReadAllBytes(filePath);
        IntPtr hPrinter = IntPtr.Zero;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            throw new Exception("OpenPrinter failed (" + Marshal.GetLastWin32Error() + ")");
        try {
            var di = new DOCINFOW { pDocName = "ZPL", pOutputFile = null, pDataType = "RAW" };
            if (StartDocPrinter(hPrinter, 1, di) == 0)
                throw new Exception("StartDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");
            StartPagePrinter(hPrinter);
            IntPtr pBytes = Marshal.AllocHGlobal(bytes.Length);
            try {
                Marshal.Copy(bytes, 0, pBytes, bytes.Length);
                int written = 0;
                WritePrinter(hPrinter, pBytes, bytes.Length, out written);
            } finally {
                Marshal.FreeHGlobal(pBytes);
            }
            EndPagePrinter(hPrinter);
            EndDocPrinter(hPrinter);
        } finally {
            ClosePrinter(hPrinter);
        }
    }
}
'@
[RawPrinter]::Print('${safeName}', '${tmpZpl}')
`.trimStart();

  writeFileSync(tmpPs1, script, "utf8");

  try {
    execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpPs1}"`,
      { timeout: 30_000, stdio: "pipe" },
    );
  } finally {
    try { unlinkSync(tmpZpl); } catch { /* best-effort cleanup */ }
    try { unlinkSync(tmpPs1); } catch { /* best-effort cleanup */ }
  }
}
