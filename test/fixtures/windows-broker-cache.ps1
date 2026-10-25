param([Parameter(Mandatory=$true)][string]$BrokerScript, [int]$Polls=4000)
$ErrorActionPreference='Stop'
# Run the product protocol loop with a deterministic native boundary. This tests
# retained broker state, not Win32 process control or a measured OOM threshold.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
public class CacheTestPipe { public Task WaitForConnectionAsync(){return Task.FromResult(true);} public void Dispose(){} }
public struct CacheTestChild { public IntPtr process,thread; public uint pid; }
public static class TutRunNative {
 public static Queue<string> Input=new Queue<string>();
 public static List<string> Output=new List<string>();
 public static int Creates=0, Breaks=0, Observes=0;
 public static long Created(IntPtr h){return 1234;}
 public static CacheTestPipe Pipe(string name){return new CacheTestPipe();}
 public static bool CloseHandle(IntPtr h){return true;}
 public static IntPtr Job(){return new IntPtr(3);}
 public static CacheTestChild Suspended(string exe,string[] args,string cwd,string log,string env){Creates++;return new CacheTestChild{process=new IntPtr(1),thread=new IntPtr(2),pid=222};}
 public static void Assign(IntPtr job,IntPtr process){}
 public static void Resume(IntPtr thread){}
 public static bool Alive(IntPtr h){return true;}
 public static uint[] Members(IntPtr job){Observes++;return new uint[]{222};}
 public static uint ExitCode(IntPtr process){return 0;}
 public static IntPtr Owned(IntPtr job,uint pid){return new IntPtr(1);}
 public static void Break(uint pid){Breaks++;}
 public static string ReadFrame(CacheTestPipe stream){return Input.Count==0?null:Input.Dequeue();}
 public static void WriteFrame(CacheTestPipe stream,string value){Output.Add(value);}
}
'@
function Add-Type { param([string]$Path) } # Only the native import is replaced.
function Frame($seq,$op,$payload=@{},$nonce='cache-test') {
  return (@{protocol='windows-console-v1';run_id='cache-test';attempt_id='cache-test';broker_pid=$PID;broker_creation_time='1234';nonce=$nonce;seq=$seq;operation=$op;deadline_ms=5000;payload=$payload} | ConvertTo-Json -Depth 8 -Compress)
}
$create=Frame 1 'create-target' @{argv=@((Join-Path $PSScriptRoot 'unused.exe'));cwd=$PSScriptRoot;log=(Join-Path $PSScriptRoot 'unused.log');env=@{};job_id=('b'*32)}
$break=Frame 2 'break' @{operation=('a'*32)}
[TutRunNative]::Input.Enqueue($create); [TutRunNative]::Input.Enqueue($break)
$firstRead=$null; $lastRead=$null
for ($n=0; $n -lt $Polls; $n++) {
  $lastRead=if ($n % 2 -eq 0) { Frame ($n+3) 'observe' } else { Frame ($n+3) 'challenge' @{challenge=('challenge-'+$n)} }
  if ($n -eq 0) { $firstRead=$lastRead }
  [TutRunNative]::Input.Enqueue($lastRead)
}
# Read-only window, binding and retained lifecycle/control replays.
[TutRunNative]::Input.Enqueue($lastRead)
[TutRunNative]::Input.Enqueue((Frame ($Polls+2) 'observe' @{changed=$true}))
[TutRunNative]::Input.Enqueue((Frame ($Polls+2) 'observe' @{} 'old'))
[TutRunNative]::Input.Enqueue($firstRead)
[TutRunNative]::Input.Enqueue($create)
[TutRunNative]::Input.Enqueue($break)
[TutRunNative]::Input.Enqueue((Frame 2 'break' @{operation=('c'*32)}))
[TutRunNative]::Input.Enqueue((Frame ($Polls+4) 'observe'))
# Even with a fresh sequence the action cannot run twice. This closes the broker.
[TutRunNative]::Input.Enqueue((Frame ($Polls+3) 'break' @{operation=('a'*32)}))
. $BrokerScript -Pipe cache-test -RunId cache-test -Attempt cache-test -Nonce cache-test
$replies=[TutRunNative]::Output
$offset=$Polls+2
if (($replies[0] | ConvertFrom-Json).value.read_only_replay_window -ne 64) { throw 'missing replay window advertisement' }
if ($replies[$offset] -cne $replies[$offset-1]) { throw 'in-window reply changed' }
$errors=@('different content','stale broker binding','read-only replay window expired')
for($n=0;$n -lt 3;$n++) { if (($replies[$offset+$n+1] | ConvertFrom-Json).error -notmatch $errors[$n]) { throw ('wrong rejection: '+$n) } }
if ($replies[$offset+4] -cne $replies[0] -or $replies[$offset+5] -cne $replies[1]) { throw 'lifecycle/control receipt was evicted' }
if (($replies[$offset+6] | ConvertFrom-Json).error -notmatch 'different content') { throw 'control collision accepted' }
if (($replies[$offset+7] | ConvertFrom-Json).error -notmatch 'non-monotonic') { throw 'sequence gap accepted' }
if (($replies[$offset+8] | ConvertFrom-Json).error -notmatch 'duplicate/skipped') { throw 'new sequence replayed action' }
if ([TutRunNative]::Creates -ne 1 -or [TutRunNative]::Breaks -ne 1 -or [TutRunNative]::Observes -ne $Polls) { throw 'a replay repeated native work' }
# Two permanent receipts, 64 read-only receipts, one terminal rejection.
if ($cache.Count -ne 67 -or $readOnlySeqs.Count -ne 64) { throw 'replay state grew beyond its bound' }
$chars=0; foreach($entry in $cache.Values){$chars+=$entry.raw.Length+$entry.reply.Length}
@{polls=$Polls;cache_entries=$cache.Count;read_only_entries=$readOnlySeqs.Count;retained_utf16_bytes=2*$chars;creates=[TutRunNative]::Creates;breaks=[TutRunNative]::Breaks;observes=[TutRunNative]::Observes;replays='verified'} | ConvertTo-Json -Compress
