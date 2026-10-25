param([switch]$Launch, [Parameter(Mandatory=$true)][string]$Pipe,
  [Parameter(Mandatory=$true)][string]$RunId, [Parameter(Mandatory=$true)][string]$Attempt,
  [Parameter(Mandatory=$true)][string]$Nonce)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'native.cs')
if ($Launch) {
  $exe = Join-Path $PSHOME 'powershell.exe'
  $argv = @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-Pipe',$Pipe,'-RunId',$RunId,'-Attempt',$Attempt,'-Nonce',$Nonce)
  $child = [TutRunNative]::Broker($exe,$argv,(Get-Location).Path)
  try { @{pid=$child.pid;created=([TutRunNative]::Created($child.process)).ToString()} | ConvertTo-Json -Compress }
  finally { [void][TutRunNative]::CloseHandle($child.thread); [void][TutRunNative]::CloseHandle($child.process) }
  exit 0
}
$server = $null; $job = [IntPtr]::Zero; $target = $null
$created = ([TutRunNative]::Created([System.Diagnostics.Process]::GetCurrentProcess().Handle)).ToString()
$binding = @{protocol='windows-console-v1';run_id=$RunId;attempt_id=$Attempt;broker_pid=$PID;broker_creation_time=$created;nonce=$Nonce}
# Side-effect receipts live for the broker lifetime. Read-only replies have a
# finite replay window; retired sequences are rejected, never executed again.
$readOnlyReplayLimit = 64
$readOnlySeqs = New-Object 'System.Collections.Generic.Queue[string]'
$cache = @{}; $lastSeq = 0; $stage = 0; $stopOperation = $null; $createdTarget = $false
function Reply($request, $value, $errorText) {
  $reply = $binding.Clone(); $reply.seq = $request.seq
  if ($null -ne $errorText) { $reply.error = $errorText } else { $reply.value = $value }
  return ($reply | ConvertTo-Json -Depth 24 -Compress)
}
function Observe {
  $alive = [TutRunNative]::Alive($target.process)
  $members = @([TutRunNative]::Members($job))
  $observation = @{root_exited=(-not $alive);job_empty=($members.Count -eq 0)}
  if (-not $alive) { $observation.exit_code = [TutRunNative]::ExitCode($target.process) }
  return $observation
}
try {
  $server = [TutRunNative]::Pipe($Pipe)
  # A broker without a supervisor never creates a target. No reconnect/takeover.
  if (-not $server.WaitForConnectionAsync().Wait(15000)) { throw 'observer-lost: connection deadline' }
  while ($true) {
    $raw = [TutRunNative]::ReadFrame($server)
    if ($null -eq $raw) { break }
    $request = $raw | ConvertFrom-Json
    $errorText = $null
    foreach ($key in $binding.Keys) { if ($request.$key -cne $binding[$key]) { $errorText = 'identity-unverified: stale broker binding'; break } }
    if ($null -eq $errorText -and ($request.seq -isnot [long] -and $request.seq -isnot [int])) { $errorText = 'preflight-rejected: invalid sequence' }
    if ($null -eq $errorText -and $cache.ContainsKey([string]$request.seq)) {
      $prior = $cache[[string]$request.seq]
      if ($prior.raw -ceq $raw) { [TutRunNative]::WriteFrame($server,$prior.reply); continue }
      $errorText = 'preflight-rejected: same sequence with different content'
    }
    if ($null -eq $errorText -and $request.seq -gt 0 -and $request.seq -le $lastSeq) { $errorText = 'preflight-rejected: read-only replay window expired' }
    if ($null -eq $errorText -and $request.seq -ne ($lastSeq + 1)) { $errorText = 'preflight-rejected: non-monotonic sequence' }
    if ($null -eq $errorText -and ($request.deadline_ms -lt 1 -or $request.deadline_ms -gt 5000)) { $errorText = 'preflight-rejected: invalid deadline' }
    if ($null -ne $errorText) { [TutRunNative]::WriteFrame($server,(Reply $request $null $errorText)); continue }
    $lastSeq = $request.seq; $value = $null; $fatal = $false
    try {
      if ($request.operation -eq 'create-target') {
        if ($createdTarget) { throw 'preflight-rejected: target already created' }
        $p = $request.payload
        if (-not $p.argv -or $p.argv.Count -lt 1 -or $p.argv[0] -match '\.(cmd|bat)$' -or -not [System.IO.Path]::IsPathRooted($p.argv[0])) { throw 'preflight-rejected: absolute native executable required' }
        if ($p.job_id -notmatch '^[a-f0-9]{32}$') { throw 'preflight-rejected: invalid job identity' }
        $environment = New-Object 'System.Collections.Generic.SortedDictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($property in $p.env.PSObject.Properties) {
          if ($property.Name.Contains('=') -or $property.Name.Contains([char]0) -or ([string]$property.Value).Contains([char]0)) { throw 'preflight-rejected: invalid environment' }
          $environment[$property.Name] = [string]$property.Value
        }
        $entries = @($environment.GetEnumerator() | ForEach-Object { $_.Key + '=' + $_.Value })
        $envBlock = [string]::Join([char]0,$entries) + [char]0 + [char]0
        $job = [TutRunNative]::Job()
        $arguments = @(); if ($p.argv.Count -gt 1) { $arguments = @($p.argv | Select-Object -Skip 1) }
        $target = [TutRunNative]::Suspended($p.argv[0],[string[]]$arguments,$p.cwd,$p.log,$envBlock)
        $createdTarget = $true
        [TutRunNative]::Assign($job,$target.process)
        $rootCreated = ([TutRunNative]::Created($target.process)).ToString()
        [TutRunNative]::Resume($target.thread)
        $value = @{pid=$target.pid;read_only_replay_window=$readOnlyReplayLimit;identity=@{attempt_id=$Attempt;broker_pid=$PID;broker_creation_time=$created;root_creation_time=$rootCreated;job_id=$p.job_id}}
      } elseif (-not $createdTarget) { throw 'preflight-rejected: no owned target' }
      elseif ($request.operation -eq 'challenge') { $value = @{challenge=$request.payload.challenge}; [void](Observe) }
      elseif ($request.operation -eq 'observe') { $value = Observe }
      elseif ($request.operation -in @('break','taskkill-tree','taskkill-tree-force')) {
        $expected = @('break','taskkill-tree','taskkill-tree-force')
        if ($stage -ge 3 -or $request.operation -cne $expected[$stage]) { throw 'preflight-rejected: duplicate/skipped control stage' }
        if ($request.payload.operation -notmatch '^[a-f0-9]{32}$') { throw 'preflight-rejected: invalid stop operation' }
        if ($null -ne $stopOperation -and $stopOperation -cne $request.payload.operation) { throw 'preflight-rejected: stop operation changed' }
        $stopOperation = $request.payload.operation
        # Reserve the stage before any native call; failure is terminal, never retried.
        $stage++; $receipts = @()
        if ($request.operation -eq 'break') {
          if ([TutRunNative]::Alive($target.process)) {
            $owned = [TutRunNative]::Owned($job,$target.pid)
            try {
              if ([TutRunNative]::Created($owned) -ne [TutRunNative]::Created($target.process)) { throw 'identity-unverified: root changed' }
              [TutRunNative]::Break($target.pid)
              $receipts += @{pid=$target.pid;creation_time=([TutRunNative]::Created($owned)).ToString();return_code=0}
            } finally { [void][TutRunNative]::CloseHandle($owned) }
          }
        } else {
          $watch = [System.Diagnostics.Stopwatch]::StartNew()
          $ownedMembers = @()
          try {
            # Pin every identity before the first tree operation can remove other members.
            foreach ($member in @([TutRunNative]::Members($job))) {
              $ownedMembers += @{pid=$member;handle=([TutRunNative]::Owned($job,$member))}
            }
            foreach ($member in $ownedMembers) {
              if (-not [TutRunNative]::Alive($member.handle)) { continue }
              $budget = [int]$request.deadline_ms - [int]$watch.ElapsedMilliseconds - 100
              if ($budget -le 0) { throw 'delivery-uncertain: member control deadline' }
              $code = [TutRunNative]::Taskkill($member.pid,($request.operation -eq 'taskkill-tree-force'),$budget)
              $receipts += @{pid=$member.pid;creation_time=([TutRunNative]::Created($member.handle)).ToString();return_code=$code}
            }
          } finally { foreach ($member in $ownedMembers) { [void][TutRunNative]::CloseHandle($member.handle) } }
        }
        $value = @{targets=@($receipts)}
      } else { throw 'preflight-rejected: unsupported operation' }
    } catch { $errorText = $_.Exception.Message; $fatal = $true }
    $response = Reply $request $value $errorText
    $cache[[string]$request.seq] = @{raw=$raw;reply=$response}
    if ($request.operation -in @('observe','challenge')) {
      $readOnlySeqs.Enqueue([string]$request.seq)
      if ($readOnlySeqs.Count -gt $readOnlyReplayLimit) { $cache.Remove($readOnlySeqs.Dequeue()) }
    }
    [TutRunNative]::WriteFrame($server,$response)
    if ($fatal) { break }
  }
} finally {
  # Deliberately no KILL_ON_JOB_CLOSE, TerminateJobObject or process cleanup.
  # Loss of observer leaves targets alive and the supervisor retains occupancy.
  if ($null -ne $target) { [void][TutRunNative]::CloseHandle($target.thread); [void][TutRunNative]::CloseHandle($target.process) }
  if ($job -ne [IntPtr]::Zero) { [void][TutRunNative]::CloseHandle($job) }
  if ($null -ne $server) { $server.Dispose() }
}
