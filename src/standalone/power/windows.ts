import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { complete, RunStore } from "../../core/run/store.js";

const exec = promisify(execFile);

/** Bounded, noninteractive Windows OS queries. No user text is interpolated. */
export async function windowsPowerShell(script: string): Promise<string> {
  const command = Buffer.from(`$ErrorActionPreference='Stop'; ${script}`, "utf16le").toString("base64");
  const { stdout } = await exec("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", command],
    { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return stdout.trim();
}

function requirePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid Windows PID");
}

export async function windowsStartToken(pid: number): Promise<string | null> {
  requirePid(pid);
  try {
    const value = await windowsPowerShell(`$p=[Diagnostics.Process]::GetProcessById(${pid}); try { $p.StartTime.ToUniversalTime().Ticks.ToString() } finally { $p.Dispose() }`);
    return /^\d+$/.test(value) ? `windows:${value}` : null;
  } catch { return null; }
}

export async function windowsListenerPid(port: number): Promise<number> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid TCP port");
  // Query all listeners then filter: a genuinely absent port is an empty result,
  // while provider/access failures still throw (never an empty success).
  const raw = await windowsPowerShell(`ConvertTo-Json -Compress -InputObject @(@(Get-NetTCPConnection -State Listen) | Where-Object { $_.LocalPort -eq ${port} } | Select-Object -ExpandProperty OwningProcess -Unique)`);
  const values: unknown = JSON.parse(raw || "[]");
  if (!Array.isArray(values) || values.length !== 1 || !Number.isSafeInteger(values[0]) || values[0] <= 0) {
    throw new Error(`cannot identify a unique listener PID on port ${port}; inspect the service manually`);
  }
  return values[0] as number;
}

export interface WindowsProcess {
  pid: number;
  parent: number;
  token: string | null;
  command: string | null;
}

/** CIM parent links alone are insufficient: a parent PID may have been reused.
 * Capture creation identities, retaining unreadable rows to fail closed. */
export async function windowsProcesses(): Promise<WindowsProcess[]> {
  const raw = await windowsPowerShell(`ConvertTo-Json -Compress -InputObject @(
    Get-CimInstance Win32_Process | ForEach-Object {
      $row=$_; $token=$null; $p=$null
      try {
        $p=[Diagnostics.Process]::GetProcessById([int]$row.ProcessId)
        $ticks=$p.StartTime.ToUniversalTime().Ticks
        if ([Math]::Abs($ticks-$row.CreationDate.ToUniversalTime().Ticks) -lt 10) { $token='windows:'+$ticks.ToString() }
      } catch {} finally { if ($null -ne $p) { $p.Dispose() } }
      @{pid=[int]$row.ProcessId; parent=[int]$row.ParentProcessId; token=$token; command=$row.CommandLine}
    }
  )`);
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows) || rows.some(row => !row || !Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.parent) ||
    !(row.token === null || /^windows:\d+$/.test(row.token)) || !(row.command === null || typeof row.command === "string"))) {
    throw new Error("unreadable Windows process snapshot");
  }
  return rows as WindowsProcess[];
}

/** Run supervisors are excluded even before meta.json exists (startup race).
 * Over-exclusion is safe; missing command lines are never guessed. */
function runBoundary(row: WindowsProcess, protectedPids: ReadonlySet<number>): boolean {
  return protectedPids.has(row.pid) || /(?:^|[\\/])supervisor\.js"?\s+--supervise(?:\s|$)/i.test(row.command ?? "");
}

export function windowsServiceTree(rows: WindowsProcess[], root: WindowsProcess, protectedPids: ReadonlySet<number>, rootCutoff?: string): WindowsProcess[] {
  const result = [root];
  const seen = new Set([root.pid]);
  for (let i = 0; i < result.length; i++) {
    const parent = result[i]!;
    for (const row of rows) {
      if (row.parent !== parent.pid || seen.has(row.pid) || runBoundary(row, protectedPids)) continue;
      if (!row.token || !parent.token || !row.command) throw new Error(`cannot attribute Windows child PID ${row.pid}`);
      // After terminating a parent, only recover children born while its
      // original handle still pinned that PID. A reused-then-exited PID must
      // never make an unrelated new tree look like service descendants.
      if (parent.pid === root.pid && rootCutoff && BigInt(row.token.slice(8)) > BigInt(rootCutoff)) continue;
      // Older child means the numeric parent PID belongs to another instance.
      if (BigInt(row.token.slice(8)) < BigInt(parent.token.slice(8))) continue;
      seen.add(row.pid);
      result.push(row);
    }
  }
  return result;
}

/** Use the existing Store API, including supervisors outside the run root tree.
 * Unreadable metadata is a refusal, never permission to terminate a run. */
export function windowsProtectedRuns(root: string): Set<number> {
  const store = new RunStore(root);
  const protectedPids = new Set<number>([process.pid]);
  for (const id of store.list()) {
    if (id.startsWith(".")) continue;
    try {
      const meta = store.read(id);
      if (complete(meta)) continue; // Terminal history cannot reserve recycled PIDs forever.
      protectedPids.add(meta.pid);
      protectedPids.add(meta.supervisor_pid);
    } catch (error) {
      // An in-flight supervisor is excluded by command line above, even while
      // its metadata has not yet been published. Corruption is not absence.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return protectedPids;
}

/** Acquire a real handle, compare its creation time and terminate that SAME
 * handle. No taskkill /T: detached runs retain Windows parent links. */
export async function terminateWindowsProcess(row: WindowsProcess): Promise<string | null> {
  requirePid(row.pid);
  if (!row.token || !/^windows:\d+$/.test(row.token) || row.pid === process.pid) throw new Error("unverified Windows process identity");
  const cutoff = await windowsPowerShell(`
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TutPowerProcess {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static long Stop(int pid, long ticks) {
    IntPtr h=OpenProcess(0x100001 | 0x1000, false, pid);
    if (h==IntPtr.Zero) { if (Marshal.GetLastWin32Error()==87) return 0; throw new Exception("cannot open process handle"); }
    try {
      long c,e,k,u;
      if (!GetProcessTimes(h,out c,out e,out k,out u)) throw new Exception("cannot read creation time");
      if (DateTime.FromFileTimeUtc(c).Ticks!=ticks) throw new Exception("PID identity changed; refusing termination");
      long cutoff=DateTime.UtcNow.Ticks;
      if (WaitForSingleObject(h,0)==0) return cutoff;
      if (!TerminateProcess(h,1) || WaitForSingleObject(h,1500)!=0) throw new Exception("termination unconfirmed");
      return cutoff;
    } finally { CloseHandle(h); }
  }
}
'@
    [TutPowerProcess]::Stop(${row.pid},[long]'${row.token.slice(8)}')`);
  if (!/^\d+$/.test(cutoff)) throw new Error("Windows termination result unreadable");
  return cutoff === "0" ? null : cutoff;
}

export async function stopWindowsService(root: string, pid: number, token: string | null | undefined): Promise<void> {
  if (!token?.startsWith("windows:")) throw new Error("no Windows creation token recorded");
  const protectedPids = windowsProtectedRuns(root);
  if (protectedPids.has(pid)) throw new Error("service PID belongs to a run or the caller");
  let rows = await windowsProcesses();
  const leader = rows.find(row => row.pid === pid);
  if (!leader) throw new Error("service leader is gone; no Job Object container to attribute orphan descendants (documented-gap)");
  if (leader.token !== token) throw new Error("service PID identity changed or unreadable; refusing termination");
  const known = windowsServiceTree(rows, leader, protectedPids);
  const cutoffs = new Map<WindowsProcess, string>();
  // Stop parents first to close the ordinary spawn race, then refresh children
  // of every captured instance. This is bounded snapshot cleanup, not a kernel
  // container: descendants already orphaned before the snapshot remain a gap.
  for (let round = 0; round < 4; round++) {
    for (const row of known) {
      const live = rows.find(item => item.pid === row.pid);
      if (live?.token === row.token) {
        const cutoff = await terminateWindowsProcess(row);
        if (cutoff) cutoffs.set(row, cutoff);
      }
      else if (live && live.token === null) throw new Error(`cannot verify PID ${row.pid}`);
    }
    rows = await windowsProcesses();
    const excluded = windowsProtectedRuns(root);
    for (const parent of [...known]) {
      // A reused parent PID cannot establish new ancestry.
      const live = rows.find(row => row.pid === parent.pid);
      if (live && live.token !== parent.token) continue;
      const cutoff = cutoffs.get(parent);
      if (!cutoff) continue; // No verified handle means no new ancestry proof.
      for (const child of windowsServiceTree(rows, parent, excluded, cutoff).slice(1)) {
        if (!known.some(row => row.pid === child.pid && row.token === child.token)) known.push(child);
      }
    }
    if (!known.some(row => rows.some(live => live.pid === row.pid && (live.token === row.token || live.token === null)))) return;
  }
  throw new Error("Windows service tree did not stop within bounded cleanup");
}
