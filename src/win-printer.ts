/**
 * Windows raw printer interface — no native addon required.
 *
 * Printing uses the Win32 winspool.drv API via inline C# compiled by
 * PowerShell Add-Type. The job is submitted with pDataType="RAW" so ZPL
 * bytes reach the Zebra driver unmodified.
 */
import { execFile, execFileSync } from "child_process";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, unlinkSync } from "fs";

/** Packaged Electron apps often have a stripped PATH — resolve PowerShell explicitly. */
export function resolvePowerShellExe(): string {
  const windir = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const candidates = [
    join(windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    join(windir, "Sysnative", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "powershell.exe";
}

/** List all printers installed on the local Windows system. */
export async function listWindowsPrinters(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const ps = resolvePowerShellExe();
  return new Promise((resolve) => {
    execFile(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress",
      ],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve([]);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout.trim());
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

  const safeName = printerName.replace(/'/g, "''");

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

  const ps = resolvePowerShellExe();
  try {
    execFileSync(
      ps,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmpPs1],
      { timeout: 30_000, stdio: "pipe", windowsHide: true },
    );
  } finally {
    try {
      unlinkSync(tmpZpl);
    } catch {
      /* best-effort */
    }
    try {
      unlinkSync(tmpPs1);
    } catch {
      /* best-effort */
    }
  }
}
