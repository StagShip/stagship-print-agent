/**
 * Windows raw printer interface — implemented entirely with PowerShell P/Invoke
 * so no native Node.js addon (and therefore no node-gyp compilation) is needed.
 *
 * Uses the same Win32 spooler APIs (OpenPrinter, WritePrinter, etc.) that
 * native addons like node-printer wrap, but invoked from a child PowerShell
 * process via inline C# Add-Type rather than a compiled .node binary.
 *
 * All exports are no-ops / empty results on non-Windows platforms.
 */
import { execFile } from "child_process";
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
 * Send raw bytes (e.g. a ZPL label) to a named Windows printer via the Win32
 * print spooler. The data type is set to "RAW" so the spooler passes the bytes
 * to the printer driver unmodified — exactly what Zebra needs for ZPL.
 *
 * Throws on any failure (printer not found, spooler error, etc.).
 */
export async function sendRawToWindowsPrinter(
  printerName: string,
  data: Buffer | string,
): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("sendRawToWindowsPrinter is only supported on Windows.");
  }

  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;

  // Write to a temp file so we don't have to worry about escaping binary data
  // inside the PowerShell script string.
  const tmpFile = join(tmpdir(), `stagship-label-${Date.now()}.bin`);
  writeFileSync(tmpFile, buf);

  // Escape single quotes in strings that get embedded in the PS script.
  const safeName = printerName.replace(/'/g, "''");
  const safePath = tmpFile.replace(/\\/g, "\\\\");

  // Inline C# that wraps the Win32 winspool.Drv P/Invoke surface.
  // Add-Type compiles it on the fly; the JIT cost is ~1-2 s on first call.
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinSpoolPrint {
    [DllImport("winspool.Drv", CharSet=CharSet.Ansi, SetLastError=true)]
    public static extern bool OpenPrinter(string printerName, out IntPtr hPrinter, IntPtr pDefault);
    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern int StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFO pDocInfo);
    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", SetLastError=true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
    public struct DOCINFO {
        public int    cbSize;
        public string pDocName;
        public string pOutputFile;
        public string pDataType;
    }
}
"@
$bytes = [System.IO.File]::ReadAllBytes('${safePath}')
$hPrinter = [IntPtr]::Zero
if (-not [WinSpoolPrint]::OpenPrinter('${safeName}', [ref]$hPrinter, [IntPtr]::Zero)) {
    throw "OpenPrinter failed for printer '${safeName}' (Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
}
try {
    $di = New-Object WinSpoolPrint+DOCINFO
    $di.cbSize   = [System.Runtime.InteropServices.Marshal]::SizeOf($di)
    $di.pDocName = 'ZPL Label'
    $di.pDataType = 'RAW'
    if ([WinSpoolPrint]::StartDocPrinter($hPrinter, 1, [ref]$di) -eq 0) {
        throw "StartDocPrinter failed (Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
    }
    try {
        [WinSpoolPrint]::StartPagePrinter($hPrinter) | Out-Null
        $gch = [System.Runtime.InteropServices.GCHandle]::Alloc(
            $bytes, [System.Runtime.InteropServices.GCHandleType]::Pinned)
        try {
            $written = 0
            if (-not [WinSpoolPrint]::WritePrinter($hPrinter, $gch.AddrOfPinnedObject(), $bytes.Length, [ref]$written)) {
                throw "WritePrinter failed (Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
            }
        } finally {
            $gch.Free()
        }
        [WinSpoolPrint]::EndPagePrinter($hPrinter) | Out-Null
    } finally {
        [WinSpoolPrint]::EndDocPrinter($hPrinter) | Out-Null
    }
} finally {
    [WinSpoolPrint]::ClosePrinter($hPrinter) | Out-Null
}
`;

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 20_000 },
        (err, _stdout, stderr) => {
          if (err) reject(new Error(stderr?.trim() || err.message));
          else resolve();
        },
      );
    });
  } finally {
    try { unlinkSync(tmpFile); } catch { /* noop — temp file cleanup is best-effort */ }
  }
}
