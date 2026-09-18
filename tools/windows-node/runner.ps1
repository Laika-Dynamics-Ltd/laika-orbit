# Laika Orbit job runner: runs one job that gate.ps1 started, to the end, apart from any SSH
# connection. gate.ps1 starts it through WMI (a background job) or a scheduled task in the
# signed-in desktop session (GPU work), with the job's id; everything else is in jobs\<id>\job.json.
#
# The command runs inside a Windows job object, which is what the memory guard and "stop
# everything it started" rest on: the job's memory is capped at this machine's memory less the
# reserve kept for Windows itself (allocations past it fail, and the job is reported as oom), it
# runs at the configured priority, and ending the job object ends every process the command
# started. Both output streams go, in order, into out.log, which gate.ps1 follow reads.
param([Parameter(Mandatory = $true)][string]$Id)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($Id -notmatch '^[0-9a-f]{32}$') { exit 2 }
$jd = Join-Path (Join-Path $Root 'jobs') $Id
$log = Join-Path $jd 'out.log'
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Write-Exit($e) {
  $tmp = Join-Path $jd 'exit.json.tmp'
  [System.IO.File]::WriteAllText($tmp, ($e | ConvertTo-Json -Compress), $Utf8)
  Move-Item -LiteralPath $tmp -Destination (Join-Path $jd 'exit.json') -Force
}
function Log-Line([string]$s) { [System.IO.File]::AppendAllText($log, "$s`r`n", $Utf8) }

[System.IO.File]::WriteAllText((Join-Path $jd 'run.json'), (@{ pid = $PID; at = (Now-Ms) } | ConvertTo-Json -Compress), $Utf8)

$cs = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class LaikaJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BASIC_LIMIT {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct EXTENDED_LIMIT {
    public BASIC_LIMIT BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
  const int ExtendedLimitInformation = 9;
  const uint LIMIT_PRIORITY_CLASS = 0x20;
  const uint LIMIT_JOB_MEMORY = 0x200;
  const uint LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMIT info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out EXTENDED_LIMIT info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  /** one argument quoted the way CommandLineToArgvW and the C runtime read it back */
  public static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"', '&', '|', '<', '>', '^', '(', ')' }) < 0) return a;
    StringBuilder sb = new StringBuilder("\"");
    for (int i = 0; i < a.Length; i++) {
      int slashes = 0;
      while (i < a.Length && a[i] == '\\') { slashes++; i++; }
      if (i == a.Length) { sb.Append('\\', slashes * 2); break; }
      if (a[i] == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); }
      else { sb.Append('\\', slashes); sb.Append(a[i]); }
    }
    sb.Append('"');
    return sb.ToString();
  }

  public static string Join(string[] args) {
    List<string> q = new List<string>();
    foreach (string a in args) q.Add(Quote(a));
    return string.Join(" ", q.ToArray());
  }

  static uint PriorityOf(string name) {
    switch ((name ?? "").ToLowerInvariant()) {
      case "idle": return 0x40;
      case "belownormal": return 0x4000;
      case "normal": return 0x20;
      default: return 0x4000;
    }
  }

  static void Pump(Stream from, FileStream to, object gate) {
    byte[] buf = new byte[16384];
    int n;
    try {
      while ((n = from.Read(buf, 0, buf.Length)) > 0) {
        lock (gate) { to.Write(buf, 0, n); to.Flush(); }
      }
    } catch (Exception) { }
  }

  /**
   * Runs file with its argument line in cwd until it exits or killFlag appears; returns
   * { exit code, 1 if it hit the memory cap, 1 if it was killed }.
   */
  public static long[] Run(string file, string argLine, string cwd, string logPath, long memLimit, string priority, string killFlag) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    EXTENDED_LIMIT info = new EXTENDED_LIMIT();
    info.BasicLimitInformation.LimitFlags = LIMIT_KILL_ON_JOB_CLOSE | LIMIT_PRIORITY_CLASS | (memLimit > 0 ? LIMIT_JOB_MEMORY : 0);
    info.BasicLimitInformation.PriorityClass = PriorityOf(priority);
    info.JobMemoryLimit = new UIntPtr((ulong)Math.Max(0, memLimit));
    if (!SetInformationJobObject(job, ExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))))
      throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());

    ProcessStartInfo psi = new ProcessStartInfo(file, argLine);
    psi.WorkingDirectory = cwd;
    psi.UseShellExecute = false;
    psi.CreateNoWindow = true;
    psi.RedirectStandardInput = true;
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;

    FileStream log = new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
    object gate = new object();
    Process p = Process.Start(psi);
    // assigned straight after starting: anything it starts from here on is in the job too
    AssignProcessToJobObject(job, p.Handle);
    p.StandardInput.Close();
    Thread a = new Thread(delegate () { Pump(p.StandardOutput.BaseStream, log, gate); });
    Thread b = new Thread(delegate () { Pump(p.StandardError.BaseStream, log, gate); });
    a.IsBackground = true; b.IsBackground = true;
    a.Start(); b.Start();

    bool killed = false;
    while (!p.WaitForExit(500)) {
      if (!killed && File.Exists(killFlag)) {
        killed = true;
        TerminateJobObject(job, 1);
      }
    }
    p.WaitForExit();
    // what the command left running is ended with it, which also closes the output pipes
    a.Join(10000);
    b.Join(10000);
    EXTENDED_LIMIT after;
    bool oom = false;
    if (memLimit > 0 && QueryInformationJobObject(job, ExtendedLimitInformation, out after, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)), IntPtr.Zero))
      oom = p.ExitCode != 0 && (double)after.PeakJobMemoryUsed.ToUInt64() >= 0.97 * memLimit;
    TerminateJobObject(job, 1);
    a.Join(5000);
    b.Join(5000);
    lock (gate) { log.Flush(); log.Close(); }
    CloseHandle(job);
    return new long[] { p.ExitCode, oom ? 1 : 0, killed ? 1 : 0 };
  }
}
'@

try {
  $spec = Get-Content -Raw -LiteralPath (Join-Path $jd 'job.json') | ConvertFrom-Json
  Add-Type -TypeDefinition $cs -Language CSharp

  # PATH as the user has it: a job started through WMI or a task can miss the user's own additions
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($spec.env) { foreach ($p in $spec.env.PSObject.Properties) { Set-Item -LiteralPath "Env:$($p.Name)" -Value ([string]$p.Value) } }

  $argv = [string[]]@($spec.args | ForEach-Object { [string]$_ })
  $exe = [string]$spec.exe
  $found = Get-Command $exe -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
  # Blender's installer does not put it on PATH: the newest under Program Files
  if (-not $found -and $exe -ieq 'blender') {
    $b = Get-ChildItem -Path "$env:ProgramFiles\Blender Foundation\*\blender.exe" -ErrorAction SilentlyContinue | Sort-Object { $_.VersionInfo.FileVersion } -Descending | Select-Object -First 1
    if ($b) { $found = Get-Command $b.FullName }
  }
  if (-not $found) {
    Log-Line "not found on this machine: $exe"
    Write-Exit @{ state = 'failed'; code = 127; oom = $false; endedAt = (Now-Ms) }
    exit 0
  }
  $path = $found.Source
  # npm, npx and pnpm are .cmd files, which only cmd.exe runs; a .ps1 runs in PowerShell
  if ($path -match '\.(cmd|bat)$') {
    $file = $env:ComSpec
    $line = '/d /s /c "' + [LaikaJob]::Join([string[]](@($path) + $argv)) + '"'
  } elseif ($path -match '\.ps1$') {
    $file = Join-Path $PSHOME 'powershell.exe'
    $line = [LaikaJob]::Join([string[]](@('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $path) + $argv))
  } else {
    $file = $path
    $line = [LaikaJob]::Join($argv)
  }

  $r = [LaikaJob]::Run($file, $line, [string]$spec.cwd, $log, [long]$spec.memLimit, [string]$spec.priority, (Join-Path $jd 'kill'))
  $code = [int]$r[0]
  $oom = $r[1] -eq 1
  $killed = $r[2] -eq 1
  if ($oom) { Log-Line "`nstopped: the job used more memory than this machine keeps for jobs" }
  $state = if ($killed) { 'killed' } elseif ($code -eq 0) { 'done' } else { 'failed' }
  Write-Exit @{ state = $state; code = $code; oom = $oom; endedAt = (Now-Ms) }
} catch {
  Log-Line "`nthe job runner failed: $($_.Exception.Message)"
  Write-Exit @{ state = 'failed'; code = $null; oom = $false; endedAt = (Now-Ms) }
}
