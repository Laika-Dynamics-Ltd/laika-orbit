# Laika Orbit gate: the one command Laika Orbit's SSH key may run on this Windows machine.
#
# sshd runs this script for every connection made with that key (command= in the authorized keys
# file, put there by setup.ps1), whatever the Mac asked for; SSH_ORIGINAL_COMMAND says what that
# was. It answers a handful of verbs and refuses the rest, so the key cannot open a shell here:
#
#   health               this machine as JSON: cores, memory, GPUs, Unity, tools, jobs
#   manifest <dir>       the files in a project copy: path, size, modified (unix seconds)
#   recv <dir>           a tar on stdin, unpacked into the copy; .laika-delete in it lists removals
#   send <dir>           a JSON list of paths on stdin; a tar of those that exist on stdout
#   start <dir>          a job (JSON on stdin) started in the copy; the job outlives the connection
#   follow <id> <since>  a job's output from byte <since>, as server-sent events, until it exits
#   kill <id>            stop a job and everything it started
#   jobs                 recent jobs
#   clean [<dir>]        remove one project copy now, or tidy up old jobs, tasks and copies
#
# Written for Windows PowerShell 5.1, which every Windows 10 and 11 has. Everything lives under the
# folder this script is in (C:\laika): work\ (project copies), jobs\, tmp\, used\ and config.json.
# The Mac side is packages/app/windows.mjs in the Laika Orbit repo.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg = @{ work = (Join-Path $Root 'work'); maxJobs = 2; reserveGB = 4; priority = 'BelowNormal'; keepDays = 14 }
$cfgFile = Join-Path $Root 'config.json'
if (Test-Path -LiteralPath $cfgFile) {
  $loaded = Get-Content -Raw -LiteralPath $cfgFile | ConvertFrom-Json
  foreach ($p in $loaded.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
}
$Work = [string]$cfg.work
$Jobs = Join-Path $Root 'jobs'
$Tmp = Join-Path $Root 'tmp'
$Used = Join-Path $Root 'used'
foreach ($d in @($Work, $Jobs, $Tmp, $Used)) {
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

# ---------------------------------------------------------------- output ----
# Raw bytes on stdout, never PowerShell's pipeline: it would re-encode text and mangle a tar.
$Out = [Console]::OpenStandardOutput()
$Utf8 = New-Object System.Text.UTF8Encoding $false
function Say([string]$s) {
  $b = $Utf8.GetBytes($s)
  $Out.Write($b, 0, $b.Length)
  $Out.Flush()
}
function Reply([int]$status, $body) {
  Say ((@{ status = $status; body = $body } | ConvertTo-Json -Compress -Depth 8) + "`n")
}
function Refuse([int]$status, [string]$message) {
  Reply $status @{ error = $message }
  exit 2
}
function Emit($o) { Say ('data: ' + ($o | ConvertTo-Json -Compress -Depth 4) + "`n`n") }
function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Read-Stdin-Text {
  $r = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $Utf8)
  try { return $r.ReadToEnd() } finally { $r.Close() }
}

# a native program's exit code and output; PowerShell 5.1 turns a native program's stderr into
# errors, which 'Stop' would throw on
function Run-Native([string]$exe, [string[]]$argv) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $text = (& $exe @argv 2>&1 | ForEach-Object { "$_" }) -join "`n"
    return @{ code = $LASTEXITCODE; out = $text }
  } finally { $ErrorActionPreference = $old }
}

# ----------------------------------------------------------------- names ----
# a project copy's folder: the name the Mac made (packages/app/machines.mjs remoteDir), nothing else
function Dir-Of([string]$name) {
  if ($name -notmatch '^[a-z0-9][a-z0-9._-]{0,100}$') { Refuse 400 'bad folder name' }
  return (Join-Path $Work $name)
}
function Job-Dir([string]$id) {
  if ($id -notmatch '^[0-9a-f]{32}$') { Refuse 400 'bad job id' }
  return (Join-Path $Jobs $id)
}
# a path inside a project: relative, no drive, no '..', nothing Windows cannot name
function Rel-Ok([string]$p) {
  if (-not $p) { return $false }
  if ($p -match '^[\\/]' -or $p -match '^[A-Za-z]:' -or $p -match '(^|[\\/])\.\.([\\/]|$)') { return $false }
  if ($p -match '[\x00-\x1f<>"|?*:]') { return $false }
  return $true
}
function Touch-Used([string]$name) { Set-Content -LiteralPath (Join-Path $Used $name) -Value (Now-Ms) }

# --------------------------------------------------------------- machine ----
function Gpus {
  $smi = @("$env:SystemRoot\System32\nvidia-smi.exe", "$env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe") | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($smi) {
    $r = Run-Native $smi @('--query-gpu=name,utilization.gpu,memory.used,memory.total,driver_version', '--format=csv,noheader,nounits')
    if ($r.code -eq 0) {
      $list = @()
      foreach ($line in ($r.out -split "`n")) {
        $f = $line.Split(',') | ForEach-Object { $_.Trim() }
        if ($f.Count -ge 4) { $list += @{ name = $f[0]; util = [int]$f[1]; memUsed = [double]$f[2] * 1MB; memTotal = [double]$f[3] * 1MB; driver = $f[4] } }
      }
      if ($list.Count) { return $list }
    }
  }
  # no NVIDIA tools: the display adapters Windows knows, less the software and remote ones
  $list = @()
  foreach ($v in Get-CimInstance Win32_VideoController) {
    if ($v.Name -match 'Basic Display|Basic Render|Remote|Virtual|Hyper-V|Parsec|Meta Virtual') { continue }
    $list += @{ name = $v.Name; util = $null; memUsed = $null; memTotal = $null; driver = $v.DriverVersion }
  }
  return $list
}

function Unity-Dirs {
  $dirs = @("$env:ProgramFiles\Unity\Hub\Editor")
  $second = Join-Path $env:APPDATA 'UnityHub\secondaryInstallPath.json'
  if (Test-Path -LiteralPath $second) {
    try {
      $p = Get-Content -Raw -LiteralPath $second | ConvertFrom-Json
      if ($p) { $dirs += [string]$p }
    } catch {}
  }
  return $dirs
}
function Unity-Exe([string]$version) {
  if ($version -notmatch '^\d+\.\d+\.\d+[abfp]\d+$') { return $null }
  foreach ($d in Unity-Dirs) {
    $exe = Join-Path $d "$version\Editor\Unity.exe"
    if (Test-Path -LiteralPath $exe) { return $exe }
  }
  return $null
}
function Unity-Versions {
  $found = @()
  foreach ($d in Unity-Dirs) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    foreach ($v in Get-ChildItem -LiteralPath $d -Directory) {
      if (Test-Path -LiteralPath (Join-Path $v.FullName 'Editor\Unity.exe')) { $found += $v.Name }
    }
  }
  return @($found | Sort-Object -Unique)
}

function Tool-Version([string]$name, [string[]]$argv) {
  $c = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  $r = Run-Native $c.Source $argv
  if ($r.code -ne 0) { return 'installed' }
  return ($r.out -split "`n")[0].Trim()
}

function Browsers {
  $list = @()
  $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
  if ($chrome | Where-Object { Test-Path -LiteralPath $_ }) { $list += 'chrome' }
  if (Test-Path -LiteralPath "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe") { $list += 'edge' }
  $pw = Join-Path $env:LOCALAPPDATA 'ms-playwright'
  if (Test-Path -LiteralPath $pw) {
    foreach ($b in Get-ChildItem -LiteralPath $pw -Directory) { if ($b.Name -notmatch '^\.') { $list += "playwright:$($b.Name)" } }
  }
  return $list
}

# who is signed in at the screen: GPU jobs run in that session, where the GPU draws for real
function Desktop-User {
  $u = (Get-CimInstance Win32_ComputerSystem).UserName
  if ($u) { return [string]$u }
  return $null
}
function Me { return [Security.Principal.WindowsIdentity]::GetCurrent().Name }
function Desktop-Is-Mine {
  $u = Desktop-User
  return [bool]($u -and $u -ieq (Me))
}

function Memory {
  $os = Get-CimInstance Win32_OperatingSystem
  return @{ total = [double]$os.TotalVisibleMemorySize * 1KB; free = [double]$os.FreePhysicalMemory * 1KB; caption = "$($os.Caption) $($os.Version)" }
}

function Health {
  $mem = Memory
  $cpu = [int](Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
  $cores = [Environment]::ProcessorCount
  $running = @(Running-Jobs)
  return @{
    hostname = $env:COMPUTERNAME
    platform = 'win32'
    os = 'windows'
    osVersion = $mem.caption
    arch = $env:PROCESSOR_ARCHITECTURE
    user = $env:USERNAME
    cpu = $cpu
    cores = $cores
    load = [math]::Round($cores * $cpu / 100, 2)
    mem = [int](100 * ($mem.total - $mem.free) / $mem.total)
    memTotal = $mem.total
    memUsed = $mem.total - $mem.free
    memFree = $mem.free
    gpus = @(Gpus)
    unity = @(Unity-Versions)
    browsers = @(Browsers)
    tools = @{
      node = (Tool-Version 'node' @('-v'))
      git = (Tool-Version 'git' @('--version'))
      tar = (Tool-Version 'tar' @('--version'))
      ffmpeg = (Tool-Version 'ffmpeg' @('-version'))
      blender = $(if (Get-ChildItem -Path "$env:ProgramFiles\Blender Foundation\*\blender.exe" -ErrorAction SilentlyContinue) { 'installed' } else { $null })
      powershell = $PSVersionTable.PSVersion.ToString()
    }
    desktop = (Desktop-Is-Mine)
    desktopUser = (Desktop-User)
    jobs = $running.Count
    recent = @(All-Jobs | Sort-Object { [double]$_.startedAt } -Descending | Select-Object -First 12)
    work = $Work
    cap = @{ jobs = [int]$cfg.maxJobs; nice = $null; reserve = [double]$cfg.reserveGB * 1GB }
  }
}

# ------------------------------------------------------------------ jobs ----
# A job's folder holds job.json (what to run, written here), run.json (the runner's pid, written
# by runner.ps1 when it starts), out.log (everything the command printed) and exit.json (how it
# ended). A runner that died without writing exit.json leaves a job that is marked failed here.
function Job-State([string]$jd) {
  $exitF = Join-Path $jd 'exit.json'
  if (Test-Path -LiteralPath $exitF) { return (Get-Content -Raw -LiteralPath $exitF | ConvertFrom-Json) }
  $runF = Join-Path $jd 'run.json'
  $lost = $null
  if (Test-Path -LiteralPath $runF) {
    $run = Get-Content -Raw -LiteralPath $runF | ConvertFrom-Json
    if (Get-Process -Id ([int]$run.pid) -ErrorAction SilentlyContinue) { return @{ state = 'running' } }
    $lost = 'the job runner stopped without saying how the job ended'
  } elseif ((Get-Item -LiteralPath $jd).CreationTimeUtc -lt [DateTime]::UtcNow.AddSeconds(-90)) {
    $lost = 'the job runner never started'
  } else {
    return @{ state = 'running' }
  }
  $e = @{ state = 'failed'; code = $null; oom = $false; endedAt = (Now-Ms); note = $lost }
  Add-Content -LiteralPath (Join-Path $jd 'out.log') -Value "`n$lost`n"
  ($e | ConvertTo-Json -Compress) | Set-Content -LiteralPath $exitF
  return $e
}

function Job-Summary([string]$jd) {
  $spec = Get-Content -Raw -LiteralPath (Join-Path $jd 'job.json') | ConvertFrom-Json
  $st = Job-State $jd
  return @{
    id = $spec.id; dir = $spec.dir; cmd = $spec.cmd; args = @($spec.args); unity = $spec.unity
    state = $st.state; oom = [bool]$st.oom; code = $st.code; signal = $null
    startedAt = $spec.startedAt; endedAt = $st.endedAt; where = $spec.where
  }
}

function All-Jobs {
  $list = @()
  foreach ($d in Get-ChildItem -LiteralPath $Jobs -Directory) {
    if (-not (Test-Path -LiteralPath (Join-Path $d.FullName 'job.json'))) { continue }
    try { $list += (Job-Summary $d.FullName) } catch {}
  }
  return $list
}
function Running-Jobs { return @(All-Jobs | Where-Object { $_.state -eq 'running' }) }

# memory a job is expected to need when it does not say: Unity and Blender are heavy
function Need-Of($job, [string]$exe) {
  if ($job.memory -and [double]$job.memory -gt 0) { return [double]$job.memory }
  if ($job.unity) { return 3e9 }
  if ($exe -match '(^|[\\/])blender(\.exe)?$') { return 3e9 }
  if ($exe -match '(^|[\\/])ffmpeg(\.exe)?$') { return 1e9 }
  return 1.5e9
}

function Start-LaikaJob([string]$name) {
  $dir = Dir-Of $name
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { Refuse 400 "no folder $name on this machine: sync it first" }
  $job = Read-Stdin-Text | ConvertFrom-Json
  $running = @(Running-Jobs)
  if ($running | Where-Object { $_.dir -eq $name }) {
    Reply 409 @{ error = "busy: another job is running in $name"; busy = $true }
    return
  }
  $max = [int]$cfg.maxJobs
  if ($max -gt 0 -and $running.Count -ge $max) {
    Reply 409 @{ error = "busy: this machine runs $max job(s) at a time"; busy = $true }
    return
  }
  if ($job.unity) {
    $exe = Unity-Exe ([string]$job.unity)
    if (-not $exe) { Refuse 400 "Unity $($job.unity) is not installed on this machine" }
  } elseif ($job.cmd) {
    $exe = [string]$job.cmd
  } else {
    Refuse 400 'cmd or unity is required'
  }
  $mem = Memory
  $reserve = [double]$cfg.reserveGB * 1GB
  $need = Need-Of $job $exe
  if ($mem.free - $need -lt $reserve) {
    $gb = { param($b) '{0:N1}' -f ($b / 1e9) }
    Reply 409 @{ error = "busy: not enough memory ($(& $gb $mem.free) GB free, this job needs about $(& $gb $need) GB)"; busy = $true; memory = $true }
    return
  }
  foreach ($m in @($job.mkdirs)) {
    if (Rel-Ok ([string]$m)) { New-Item -ItemType Directory -Force -Path (Join-Path $dir $m) | Out-Null }
  }
  $jobEnv = @{}
  if ($job.env) { foreach ($p in $job.env.PSObject.Properties) { if ($p.Name -match '^[A-Za-z_][A-Za-z0-9_]*$') { $jobEnv[$p.Name] = [string]$p.Value } } }

  # GPU work runs in the signed-in desktop session, where the GPU renders as it does for a person;
  # anything else, or GPU work with nobody signed in, runs in the background
  $where = 'background'
  if ($job.gpu -and (Desktop-Is-Mine)) { $where = 'desktop' }

  $id = [guid]::NewGuid().ToString('N')
  $jd = Join-Path $Jobs $id
  New-Item -ItemType Directory -Force -Path $jd | Out-Null
  $spec = @{
    id = $id; dir = $name; cwd = $dir; exe = $exe; cmd = $(if ($job.unity) { $exe } else { [string]$job.cmd })
    args = @($job.args | ForEach-Object { [string]$_ }); env = $jobEnv; unity = $job.unity
    memLimit = [math]::Max([double]1e9, $mem.total - $reserve); priority = [string]$cfg.priority
    startedAt = (Now-Ms); where = $where
  }
  ($spec | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $jd 'job.json') -Encoding UTF8
  New-Item -ItemType File -Force -Path (Join-Path $jd 'out.log') | Out-Null
  Touch-Used $name

  $ps = Join-Path $PSHOME 'powershell.exe'
  $runner = Join-Path $Root 'runner.ps1'
  $argLine = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" $id"
  if ($where -eq 'desktop') {
    $action = New-ScheduledTaskAction -Execute $ps -Argument $argLine -WorkingDirectory $dir
    $principal = New-ScheduledTaskPrincipal -UserId (Me) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances Parallel
    Register-ScheduledTask -TaskName "job-$id" -TaskPath '\Laika\' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName "job-$id" -TaskPath '\Laika\'
  } else {
    # started through WMI so it is not inside this SSH session, which Windows ends with the connection
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$ps`" $argLine"; CurrentDirectory = $dir }
    if ($r.ReturnValue -ne 0) { Refuse 500 "could not start the job runner (Win32_Process.Create returned $($r.ReturnValue))" }
  }
  Reply 200 (Job-Summary $jd)
  Tidy
}

function Follow([string]$id, [string]$since) {
  $jd = Job-Dir $id
  if (-not (Test-Path -LiteralPath (Join-Path $jd 'job.json'))) { Refuse 404 'no such job' }
  $log = Join-Path $jd 'out.log'
  $pos = [long]0
  [void][long]::TryParse($since, [ref]$pos)
  $dec = $Utf8.GetDecoder()
  $buf = New-Object byte[] 65536
  $chars = New-Object char[] 65540
  for (;;) {
    # read the state first, so output written just before the exit is not missed
    $st = Job-State $jd
    if (Test-Path -LiteralPath $log) {
      $fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
      try {
        if ($pos -gt $fs.Length) { $pos = $fs.Length }
        [void]$fs.Seek($pos, 'Begin')
        while (($n = $fs.Read($buf, 0, $buf.Length)) -gt 0) {
          $pos += $n
          $c = $dec.GetChars($buf, 0, $n, $chars, 0)
          if ($c -gt 0) { Emit @{ t = 'out'; data = [string]::new($chars, 0, $c); at = $pos } }
        }
      } finally { $fs.Close() }
    }
    if ($st.state -ne 'running') {
      Emit @{ t = 'exit'; code = $st.code; signal = $null; state = $st.state; oom = [bool]$st.oom }
      Finish-Job $id
      return
    }
    Start-Sleep -Milliseconds 300
  }
}

# a finished job's scheduled task is removed; its folder (and log) stays an hour, see Tidy
function Finish-Job([string]$id) {
  Get-ScheduledTask -TaskPath '\Laika\' -TaskName "job-$id" -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue
}

function Kill-LaikaJob([string]$id) {
  $jd = Job-Dir $id
  if (-not (Test-Path -LiteralPath (Join-Path $jd 'job.json'))) { Refuse 404 'no such job' }
  # the runner watches for this file and ends the job and everything it started
  Set-Content -LiteralPath (Join-Path $jd 'kill') -Value (Now-Ms)
  Reply 200 @{ ok = $true }
}

# Cleanup after jobs: finished jobs' folders after an hour (the newest 50 at most), their scheduled
# tasks, leftover transfer files, and project copies nobody has used for keepDays. A copy is kept
# between jobs on purpose: the next sync sends only what changed, and Unity keeps its Library.
function Tidy {
  $done = @(Get-ChildItem -LiteralPath $Jobs -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'exit.json') } | Sort-Object LastWriteTimeUtc -Descending)
  $i = 0
  foreach ($d in $done) {
    $i++
    $age = [DateTime]::UtcNow - (Get-Item -LiteralPath (Join-Path $d.FullName 'exit.json')).LastWriteTimeUtc
    if ($i -gt 50 -or $age.TotalHours -gt 1) {
      Finish-Job $d.Name
      Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  Get-ChildItem -LiteralPath $Tmp -File | Where-Object { $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddHours(-12) } | Remove-Item -Force -ErrorAction SilentlyContinue
  $busy = @(Running-Jobs | ForEach-Object { $_.dir })
  foreach ($u in Get-ChildItem -LiteralPath $Used -File) {
    if ($busy -contains $u.Name) { continue }
    if ($u.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-[double]$cfg.keepDays)) {
      $copy = Join-Path $Work $u.Name
      if (Test-Path -LiteralPath $copy) { Remove-Item -LiteralPath $copy -Recurse -Force -ErrorAction SilentlyContinue }
      Remove-Item -LiteralPath $u.FullName -Force -ErrorAction SilentlyContinue
    }
  }
}

# ----------------------------------------------------------------- files ----
# Left out of a manifest, as the Mac leaves them out of a sync (SYNC_EXCLUDES in machines.mjs):
# folders at the top of a project, and names anywhere
$TopSkip = @('Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds', 'UserSettings', 'MemoryCaptures', 'Recordings')
$AnySkip = @('.git', 'node_modules', '.DS_Store', '.laika-delete')

function Walk([System.IO.DirectoryInfo]$d, [string]$rel, [System.Text.StringBuilder]$sb) {
  foreach ($e in $d.EnumerateFileSystemInfos()) {
    if ($AnySkip -contains $e.Name) { continue }
    $r = if ($rel) { "$rel/$($e.Name)" } else { $e.Name }
    if ($e -is [System.IO.DirectoryInfo]) {
      if (-not $rel -and $TopSkip -contains $e.Name) { continue }
      if ($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
      Walk $e $r $sb
    } else {
      $t = ([DateTimeOffset]$e.LastWriteTimeUtc).ToUnixTimeSeconds()
      [void]$sb.Append($r).Append("`t").Append($e.Length).Append("`t").Append($t).Append("`n")
    }
  }
}

function Manifest([string]$name) {
  $dir = Dir-Of $name
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return }
  $sb = New-Object System.Text.StringBuilder
  Walk (New-Object System.IO.DirectoryInfo $dir) '' $sb
  Say $sb.ToString()
}

function Recv([string]$name) {
  $dir = Dir-Of $name
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tmp = Join-Path $Tmp ([guid]::NewGuid().ToString('N') + '.tar')
  try {
    $in = [Console]::OpenStandardInput()
    $f = [System.IO.File]::Create($tmp)
    try { $in.CopyTo($f) } finally { $f.Close() }
    $bytes = (Get-Item -LiteralPath $tmp).Length
    if ($bytes -gt 0) {
      $r = Run-Native 'tar.exe' @('-xf', $tmp, '-C', $dir)
      if ($r.code -ne 0) { Refuse 500 "unpacking failed: $($r.out)" }
    }
    $del = Join-Path $dir '.laika-delete'
    $removed = 0
    if (Test-Path -LiteralPath $del) {
      foreach ($p in Get-Content -LiteralPath $del -Encoding UTF8) {
        if (-not (Rel-Ok $p)) { continue }
        $t = Join-Path $dir $p
        if (Test-Path -LiteralPath $t -PathType Leaf) { Remove-Item -LiteralPath $t -Force; $removed++ }
      }
      Remove-Item -LiteralPath $del -Force
    }
    Touch-Used $name
    Reply 200 @{ ok = $true; bytes = $bytes; removed = $removed }
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Send([string]$name) {
  $dir = Dir-Of $name
  $paths = @(Read-Stdin-Text | ConvertFrom-Json)
  $have = @()
  foreach ($p in $paths) {
    $p = [string]$p
    if ((Rel-Ok $p) -and (Test-Path -LiteralPath (Join-Path $dir $p))) { $have += $p } else { [Console]::Error.WriteLine("missing: $p") }
  }
  if (-not $have.Count) { return }
  $list = Join-Path $Tmp ([guid]::NewGuid().ToString('N') + '.txt')
  $tmp = "$list.tar"
  try {
    [System.IO.File]::WriteAllLines($list, [string[]]$have, $Utf8)
    $r = Run-Native 'tar.exe' @('-cf', $tmp, '-C', $dir, '-T', $list)
    if ($r.code -ne 0) { [Console]::Error.WriteLine("packing failed: $($r.out)"); exit 1 }
    $f = [System.IO.File]::OpenRead($tmp)
    try { $f.CopyTo($Out) } finally { $f.Close() }
    $Out.Flush()
  } finally {
    Remove-Item -LiteralPath $list, $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Clean([string]$name) {
  if ($name) {
    $dir = Dir-Of $name
    if (@(Running-Jobs | Where-Object { $_.dir -eq $name }).Count) { Refuse 409 "busy: a job is running in $name" }
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    Remove-Item -LiteralPath (Join-Path $Used $name) -Force -ErrorAction SilentlyContinue
  }
  Tidy
  Reply 200 @{ ok = $true }
}

# ------------------------------------------------------------------ main ----
$words = @(([string]$env:SSH_ORIGINAL_COMMAND).Trim() -split '\s+' | Where-Object { $_ })
$verb = if ($words.Count) { $words[0] } else { '' }
$a1 = if ($words.Count -gt 1) { $words[1] } else { '' }
$a2 = if ($words.Count -gt 2) { $words[2] } else { '0' }
try {
  switch ($verb) {
    'health' { Reply 200 @{ ok = $true; machine = (Health) } }
    'manifest' { Manifest $a1 }
    'recv' { Recv $a1 }
    'send' { Send $a1 }
    'start' { Start-LaikaJob $a1 }
    'follow' { Follow $a1 $a2 }
    'kill' { Kill-LaikaJob $a1 }
    'jobs' { Reply 200 @(All-Jobs) }
    'clean' { Clean $a1 }
    default { Refuse 403 "this key may only run Laika Orbit's gate (health, manifest, recv, send, start, follow, kill, jobs, clean)" }
  }
} catch {
  Reply 500 @{ error = "$($_.Exception.Message)" }
  exit 1
}
