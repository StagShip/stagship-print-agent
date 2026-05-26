/**
 * LAN auto-discovery for raw-TCP receipt printers.
 *
 * We enumerate the workstation's IPv4 interfaces (skipping loopback +
 * link-local), derive a /24 subnet for each, and probe every host .1–.254
 * for an open port 9100. The probe is a TCP-connect with a short timeout, so
 * a typical home network sweep takes ~3-5 seconds.
 *
 * Hits are returned in the order they came back (fastest responder first).
 * Anything answering on 9100 is a candidate — Epson, Star, Bixolon, even a
 * misconfigured CUPS server. The user picks the right one in Settings.
 */
import { networkInterfaces } from "os";
import { probeIp } from "./printer";

export type DiscoveryProgress = (fraction: number) => void;

/** Workstation IPv4 subnets to scan, e.g. ["192.168.1", "10.0.0"]. */
function getLocalSubnets(): string[] {
  const ifaces = networkInterfaces();
  const subnets = new Set<string>();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family !== "IPv4") continue;
      if (iface.internal) continue;
      // Skip APIPA (169.254/16) — never reaches a real printer.
      if (iface.address.startsWith("169.254.")) continue;
      const parts = iface.address.split(".");
      if (parts.length !== 4) continue;
      subnets.add(parts.slice(0, 3).join("."));
    }
  }
  return [...subnets];
}

/**
 * Sweep every reachable /24 subnet looking for port 9100 listeners.
 *
 * @param onProgress  Called with 0..1 as the sweep advances.
 * @param port        Probe port (default 9100, the raw-TCP print port).
 * @param timeoutMs   Per-host TCP connect timeout (default 350ms).
 * @param parallelism How many simultaneous TCP probes (default 32).
 */
export async function discoverPrinters(
  onProgress?: DiscoveryProgress,
  port = 9100,
  timeoutMs = 350,
  parallelism = 32,
): Promise<string[]> {
  const subnets = getLocalSubnets();
  if (subnets.length === 0) return [];

  const found: string[] = [];
  const total = subnets.length * 254;
  let done = 0;

  for (const subnet of subnets) {
    for (let start = 1; start <= 254; start += parallelism) {
      const end = Math.min(start + parallelism - 1, 254);
      const batch: Promise<void>[] = [];
      for (let host = start; host <= end; host++) {
        const ip = `${subnet}.${host}`;
        batch.push(
          probeIp(ip, port, timeoutMs).then((ok) => {
            if (ok && !found.includes(ip)) found.push(ip);
            done++;
            onProgress?.(done / total);
          }),
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(batch);
    }
  }

  // Numeric sort by last octet so the list looks sane in the UI dropdown.
  found.sort((a, b) => {
    const oa = a.split(".").map(Number);
    const ob = b.split(".").map(Number);
    for (let i = 0; i < 4; i++) if (oa[i] !== ob[i]) return oa[i] - ob[i];
    return 0;
  });
  return found;
}
