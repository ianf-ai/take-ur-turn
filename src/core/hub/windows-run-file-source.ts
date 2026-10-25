/** Private, read-only Win32 bridge. No user input is interpolated into code.
 * NtCreateFile's RootDirectory anchors each single-component lookup. See
 * https://learn.microsoft.com/windows/win32/api/winternl/nf-winternl-ntcreatefile
 * ShareRead|ShareWrite deliberately excludes ShareDelete for the ENTIRE chain.
 */
export const WINDOWS_RUN_FILE_SOURCE = String.raw`
using System;
using System.IO;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public sealed class TutReadFile : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct US { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct OA { public int Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)] struct IOS { public IntPtr Status, Information; }
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string n, uint a, uint s, IntPtr sec, uint d, uint f, IntPtr t);
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle h, uint a, ref OA o, out IOS io, IntPtr size, uint attr, uint share, uint disposition, uint options, IntPtr ea, uint ealen);
  [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(SafeFileHandle h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle h, long pos, out long actual, uint origin);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(SafeFileHandle h, byte[] b, uint n, out uint read, IntPtr overlapped);
  readonly List<SafeFileHandle> held = new List<SafeFileHandle>();
  SafeFileHandle file; Info identity;
  static Exception Unsafe() { return new IOException("EUNSAFEPATH"); }
  static void Fail(int code) { throw new Win32Exception(code); }
  static Info Check(SafeFileHandle h, bool dir) {
    Info i;
    if (GetFileType(h) != 1) throw Unsafe(); // FILE_TYPE_DISK only
    if (!GetFileInformationByHandle(h, out i)) Fail(Marshal.GetLastWin32Error());
    if ((i.Attributes & 0x400) != 0 || ((i.Attributes & 0x10) != 0) != dir) throw Unsafe();
    return i;
  }
  static bool Same(Info a, Info b) { return a.Volume == b.Volume && a.IndexHigh == b.IndexHigh && a.IndexLow == b.IndexLow; }
  SafeFileHandle Child(SafeFileHandle parent, string name, bool dir, bool data) {
    IntPtr chars = Marshal.StringToHGlobalUni(name), ptr = IntPtr.Zero;
    try {
      US u = new US { Length = checked((ushort)(name.Length * 2)), MaximumLength = checked((ushort)(name.Length * 2 + 2)), Buffer = chars };
      ptr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(US))); Marshal.StructureToPtr(u, ptr, false);
      OA o = new OA { Length = Marshal.SizeOf(typeof(OA)), RootDirectory = parent.DangerousGetHandle(), ObjectName = ptr, Attributes = 0x40 };
      SafeFileHandle h; IOS io;
      // FILE_OPEN, FILE_OPEN_REPARSE_POINT, synchronous I/O, exact object type.
      int status = NtCreateFile(out h, 0x100080u | (data ? 1u : dir ? 0x20u : 0u), ref o, out io, IntPtr.Zero, 0, 3, 1, 0x200020u | (dir ? 1u : data ? 0x40u : 0u), IntPtr.Zero, 0);
      if (status < 0) { if (h != null) h.Dispose(); Fail((int)RtlNtStatusToDosError(status)); }
      held.Add(h); Check(h, dir); return h;
    } finally { if (ptr != IntPtr.Zero) Marshal.FreeHGlobal(ptr); Marshal.FreeHGlobal(chars); }
  }
  public TutReadFile(string pathname) {
    try {
      string p = pathname.Replace('/', '\\');
      if (!System.Text.RegularExpressions.Regex.IsMatch(p, @"^[A-Za-z]:\\[^\\]")) throw Unsafe();
      string[] parts = p.Substring(3).Split('\\');
      foreach (string part in parts) {
        if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ") ||
            part.IndexOfAny(new char[] { ':', '*', '?', '"', '<', '>', '|' }) >= 0 ||
            System.Text.RegularExpressions.Regex.IsMatch(part, @"[\x00-\x1f]|^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])($|\.)", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) throw Unsafe();
      }
      // Only the validated drive root uses a Win32 pathname; every child is
      // opened relative to the pinned parent, never via that pathname again.
      SafeFileHandle parent = CreateFileW(@"\\?\" + p.Substring(0,3), 0x1000a0, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
      if (parent.IsInvalid) { int e = Marshal.GetLastWin32Error(); parent.Dispose(); Fail(e); }
      held.Add(parent); Check(parent, true);
      for (int n=0; n<parts.Length-1; n++) parent = Child(parent, parts[n], true, false);
      SafeFileHandle observed = Child(parent, parts[parts.Length-1], false, false);
      identity = Check(observed, false);
      file = Child(parent, parts[parts.Length-1], false, true);
      if (!Same(identity, Check(file, false))) throw Unsafe();
    } catch { Dispose(); throw; }
  }
  public long Size() {
    Info i = Check(file, false);
    if (!Same(identity, i)) throw Unsafe();
    ulong size = ((ulong)i.SizeHigh << 32) | i.SizeLow;
    if (size > 9007199254740991UL) throw new IOException("unsupported log size");
    return (long)size;
  }
  public string Volume() { return identity.Volume.ToString(System.Globalization.CultureInfo.InvariantCulture); }
  public string Index() { return (((ulong)identity.IndexHigh << 32) | identity.IndexLow).ToString(System.Globalization.CultureInfo.InvariantCulture); }
  public double Modified() {
    Info i = Check(file, false);
    if (!Same(identity, i)) throw Unsafe();
    long ticks = ((long)(uint)i.Write.dwHighDateTime << 32) | (uint)i.Write.dwLowDateTime;
    return (DateTime.FromFileTimeUtc(ticks) - new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;
  }
  public string Read(long from, int count) {
    if (from < 0 || from > 9007199254740991L || count < 0 || count > 1048576) throw new IOException("invalid bounded read");
    Size(); long actual;
    if (!SetFilePointerEx(file, from, out actual, 0) || actual != from) Fail(Marshal.GetLastWin32Error());
    byte[] bytes = new byte[count]; uint read = 0;
    if (count > 0 && !ReadFile(file, bytes, (uint)count, out read, IntPtr.Zero)) Fail(Marshal.GetLastWin32Error());
    Size(); return Convert.ToBase64String(bytes, 0, (int)read);
  }
  public void Dispose() { for (int i=held.Count-1; i>=0; i--) held[i].Dispose(); held.Clear(); }
}
`;

export const WINDOWS_RUN_FILE_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$reader=$null
try {
  Add-Type -TypeDefinition '${WINDOWS_RUN_FILE_SOURCE.replace(/'/g, "''")}'
  while ($null -ne ($line=[Console]::ReadLine())) {
    $req=($line | ConvertFrom-Json)
    if ($req.once -eq $true) {
      if ($null -ne $reader) { throw 'file already open' }
      $reader=New-Object TutReadFile([string]$req.file)
      $size=$reader.Size()
      if ($req.statOnly -eq $true) {
        [Console]::WriteLine((@{size=$size;dev=$reader.Volume();ino=$reader.Index();mtimeMs=$reader.Modified()} | ConvertTo-Json -Compress)); return
      }
      if ($size -gt 1048576) { throw 'oversized meta' }
      $data=$reader.Read(0,[int]$size)
      if ($reader.Size() -lt $size -or [Convert]::FromBase64String($data).Length -ne $size) { throw 'LOG_CHANGED' }
      [Console]::WriteLine((@{data=$data} | ConvertTo-Json -Compress)); return
    }
    if ($req.op -eq 'open') {
      if ($null -ne $reader) { throw 'file already open' }
      $reader=New-Object TutReadFile([string]$req.file)
      $reply=@{size=$reader.Size();dev=$reader.Volume();ino=$reader.Index()}
    }
    elseif ($req.op -eq 'close') {
      if ($null -ne $reader) { $reader.Dispose(); $reader=$null }
      $reply=@{closed=$true}
    }
    elseif ($null -eq $reader) { throw 'no open file' }
    elseif ($req.op -eq 'stat') { $reply=@{size=$reader.Size();dev=$reader.Volume();ino=$reader.Index()} }
    elseif ($req.op -eq 'read') { $reply=@{data=$reader.Read([long]$req.from,[int]$req.count)} }
    else { throw 'invalid read operation' }
    [Console]::WriteLine(($reply | ConvertTo-Json -Compress))
  }
} catch {
  $e=$_.Exception
  while ($null -ne $e.InnerException) { $e=$e.InnerException }
  $code='EIO'
  if ($e.Message -eq 'EUNSAFEPATH') { $code='EUNSAFEPATH' }
  elseif ($e.Message -eq 'oversized meta') { $code='EFBIG' }
  elseif ($e -is [System.ComponentModel.Win32Exception]) {
    switch ($e.NativeErrorCode) { 2 {$code='ENOENT'} 3 {$code='ENOENT'} 5 {$code='EACCES'} 32 {$code='EUNSAFEPATH'} 267 {$code='EUNSAFEPATH'} 1920 {$code='EUNSAFEPATH'} }
  }
  [Console]::WriteLine((@{error=$code} | ConvertTo-Json -Compress))
} finally { if ($null -ne $reader) { $reader.Dispose() } }
`;
