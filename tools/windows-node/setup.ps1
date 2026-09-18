#Requires -RunAsAdministrator
# Laika Orbit: make this Windows machine ready to run work for the Mac. Run once, as the account
# the work should run as, from an elevated PowerShell in the folder the Mac's kit was copied to:
#
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# What it does, each step safe to run again:
#   1. installs and starts the OpenSSH server, starting with Windows
#   2. makes Windows PowerShell the shell SSH sessions get
#   3. lets SSH in from this local network only (Private network, local subnet), never the internet
#   4. turns password logins over SSH off: keys only
#   5. puts the Mac's Laika Orbit key (laika-orbit.pub, beside this script) in the authorized keys,
#      tied to gate.ps1, so that key can run Laika Orbit's jobs and nothing else (no shell)
#   6. makes C:\laika with the gate, the runner, the work folder and a config.json
#   7. turns on long paths, and keeps the machine awake while on mains power
#   8. reports the GPU, Unity, Node, git and the address to give the Mac
#
# Nothing secret is in this kit: laika-orbit.pub is a public key. The private key never leaves the
# Mac. Undo: remove the laika-orbit line from the authorized keys file it names, and C:\laika.
param(
  [string]$PublicKeyFile = (Join-Path $PSScriptRoot 'laika-orbit.pub'),
  [string]$Root = 'C:\laika',
  [int]$MaxJobs = 2,
  [int]$ReserveGB = 4,
  [ValidateSet('Idle', 'BelowNormal', 'Normal')][string]$Priority = 'BelowNormal',
  [switch]$KeepPasswordLogin
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Step([string]$s) { Write-Host "`n== $s" -ForegroundColor Cyan }
function Ok([string]$s) { Write-Host "   ok   $s" -ForegroundColor Green }
function Warn([string]$s) { Write-Host "   !!   $s" -ForegroundColor Yellow }
$warnings = New-Object System.Collections.Generic.List[string]
function Later([string]$s) { Warn $s; $warnings.Add($s) }

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$me = $id.Name
# by SID, which icacls takes for any account, a Microsoft account's included
$meSid = "*$($id.User.Value)"
if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this from an elevated PowerShell (Run as administrator).' }

# ------------------------------------------------------------------ 0. kit ----
Step 'Checking the kit'
foreach ($f in @('gate.ps1', 'runner.ps1')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $f))) { throw "$f is missing: copy the whole kit folder from the Mac" }
}
if (-not (Test-Path -LiteralPath $PublicKeyFile)) { throw "No public key at $PublicKeyFile. On the Mac: offload windows-kit" }
$key = (Get-Content -Raw -LiteralPath $PublicKeyFile).Trim()
if ($key -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$') { throw "$PublicKeyFile is not an ed25519 public key" }
$keyBody = ($key -split '\s+')[0..1] -join ' '
Ok "public key $($keyBody.Substring(0, 30))..."
Ok "account $me"

# --------------------------------------------------------------- 1. sshd ----
Step 'OpenSSH server'
$cap = Get-WindowsCapability -Online | Where-Object { $_.Name -like 'OpenSSH.Server*' } | Select-Object -First 1
if (-not $cap) { throw 'This Windows has no OpenSSH Server feature to install (Windows 10 1809 or newer is needed).' }
if ($cap.State -ne 'Installed') {
  Write-Host '   installing (a few minutes; Windows Update must be reachable)...'
  Add-WindowsCapability -Online -Name $cap.Name | Out-Null
  Ok 'installed'
} else { Ok 'already installed' }
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
Ok "sshd running, starts with Windows"

# ------------------------------------------------------- 2. default shell ----
Step 'PowerShell as the SSH shell'
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $ps -PropertyType String -Force | Out-Null
Ok $ps

# ------------------------------------------------------------ 3. firewall ----
Step 'Firewall: SSH from this local network only'
$rule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
if (-not $rule) {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Program "$env:SystemRoot\System32\OpenSSH\sshd.exe" | Out-Null
}
Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Enabled True -Profile Private -RemoteAddress LocalSubnet
Ok 'port 22 open on Private networks, to addresses on this subnet only; closed on Public and Domain'
$profiles = @(Get-NetConnectionProfile)
foreach ($p in $profiles) {
  if ($p.NetworkCategory -eq 'Public') { Later "Network '$($p.Name)' is Public, so SSH is closed on it. Settings > Network & internet > (your connection) > Private network." }
  else { Ok "network '$($p.Name)' is $($p.NetworkCategory)" }
}

# ---------------------------------------------------------- 4. sshd_config ----
Step 'SSH logins: keys only'
$conf = "$env:ProgramData\ssh\sshd_config"
for ($i = 0; $i -lt 20 -and -not (Test-Path -LiteralPath $conf); $i++) { Start-Sleep -Milliseconds 500 }
$lines = @(Get-Content -LiteralPath $conf)
# our settings go at the very top: sshd takes the first value it reads, and a Match block ends
# the global section, so appending would not work
$ours = @('# Laika Orbit (setup.ps1): keys only')
if (-not $KeepPasswordLogin) { $ours += 'PasswordAuthentication no' }
$ours += 'PubkeyAuthentication yes'
$rest = @($lines | Where-Object { $_ -notmatch '^# Laika Orbit \(setup\.ps1\)' -and $_ -notmatch '^(PasswordAuthentication|PubkeyAuthentication)\s' })
$new = $ours + $rest
if (($new -join "`n") -ne ($lines -join "`n")) {
  Copy-Item -LiteralPath $conf -Destination "$conf.laika-backup" -Force
  Set-Content -LiteralPath $conf -Value $new -Encoding ascii
  Ok "updated (backup: $conf.laika-backup)"
} else { Ok 'already set' }
if ($KeepPasswordLogin) { Later 'Password logins over SSH are still on (-KeepPasswordLogin).' }

# ----------------------------------------------------------------- 6. files ----
# (before the key, whose forced command names the gate's path)
Step "Laika Orbit folder $Root"
foreach ($d in @($Root, "$Root\work", "$Root\jobs", "$Root\tmp", "$Root\used")) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'gate.ps1') -Destination "$Root\gate.ps1" -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runner.ps1') -Destination "$Root\runner.ps1" -Force
# only this account, SYSTEM and Administrators can see or change it (the gate is what the key runs)
& icacls.exe $Root /inheritance:r /grant:r "${meSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
$config = "$Root\config.json"
if (-not (Test-Path -LiteralPath $config)) {
  @{ work = "$Root\work"; maxJobs = $MaxJobs; reserveGB = $ReserveGB; priority = $Priority; keepDays = 14 } | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding ascii
  Ok "config.json: $MaxJobs jobs at a time, $ReserveGB GB kept for Windows, priority $Priority"
} else { Ok 'config.json kept as it was' }
Ok "gate.ps1 and runner.ps1 in $Root; project copies go in $Root\work"

# ------------------------------------------------------------------- 5. key ----
Step "The Mac's Laika Orbit key"
# sshd reads an administrator's keys from ProgramData and anyone else's from their profile. Which
# applies is decided by group membership, which is unreliable to read for Microsoft accounts, so the
# key goes in both; the file sshd does not read for this account is ignored.
$gateCmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Root\gate.ps1"
$line = "restrict,command=`"$gateCmd`" $keyBody laika-orbit"
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.ssh" | Out-Null
$files = @(
  @{ path = "$env:ProgramData\ssh\administrators_authorized_keys"; acl = @('*S-1-5-32-544:F', '*S-1-5-18:F') },
  @{ path = "$env:USERPROFILE\.ssh\authorized_keys"; acl = @("${meSid}:F", '*S-1-5-18:F', '*S-1-5-32-544:F') }
)
foreach ($f in $files) {
  $existing = @()
  if (Test-Path -LiteralPath $f.path) { $existing = @(Get-Content -LiteralPath $f.path | Where-Object { $_ -and $_ -notmatch ' laika-orbit$' -and $_ -notlike "*$keyBody*" }) }
  Set-Content -LiteralPath $f.path -Value ($existing + $line) -Encoding ascii
  & icacls.exe $f.path /inheritance:r /grant:r @($f.acl) | Out-Null
  Ok "$($f.path)"
}
Ok 'the key may run the gate only: no shell, no forwarding'
Restart-Service sshd
Ok 'sshd restarted'

# -------------------------------------------------------------- 7. system ----
Step 'System settings'
New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -PropertyType DWord -Force | Out-Null
Ok 'long paths on (Unity projects nest deep)'
& powercfg.exe /change standby-timeout-ac 0 | Out-Null
& powercfg.exe /change hibernate-timeout-ac 0 | Out-Null
Ok 'no sleep or hibernate on mains power (the screen may still turn off)'
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { Later 'tar.exe is missing: Windows 10 1803 or newer has it. Files cannot move without it.' }

# -------------------------------------------------------------- 8. report ----
Step 'This machine'
$env:SSH_ORIGINAL_COMMAND = 'health'
$raw = & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$Root\gate.ps1"
Remove-Item Env:SSH_ORIGINAL_COMMAND
$h = $null
try { $h = ($raw | Out-String | ConvertFrom-Json).body.machine } catch { Later "The gate did not answer its own health check: $raw" }
if ($h) {
  Ok "$($h.hostname): $($h.osVersion), $($h.cores) cores, $([math]::Round($h.memTotal / 1GB)) GB memory"
  if ($h.gpus.Count) { foreach ($g in $h.gpus) { Ok "GPU  $($g.name)$(if ($g.memTotal) { ", $([math]::Round($g.memTotal / 1GB)) GB" })$(if ($g.driver) { ", driver $($g.driver)" })" } }
  else { Later 'No GPU found. Install the NVIDIA (or AMD) driver, then run this again.' }
  if (-not @($h.gpus | Where-Object { $_.util -ne $null }).Count -and $h.gpus.Count) { Warn 'nvidia-smi not found: GPU load will not show in Orbit (it comes with the NVIDIA driver)' }
  if ($h.unity.Count) { Ok "Unity $($h.unity -join ', ')" } else { Later 'No Unity editor found under Unity Hub. Install the versions your projects use (Unity Hub > Installs).' }
  if ($h.tools.node) { Ok "Node $($h.tools.node)" } else { Later 'Node is not installed (nodejs.org, LTS). Needed for builds and captures.' }
  if ($h.tools.git) { Ok "$($h.tools.git)" } else { Warn 'git is not installed (git-scm.com). Optional: projects arrive without .git.' }
  if ($h.tools.tar) { Ok "tar: $($h.tools.tar)" }
  if ($h.browsers.Count) { Ok "browsers: $($h.browsers -join ', ')" } else { Warn 'no browsers found for captures (Chrome, Edge or Playwright)' }
  if ($h.desktop) { Ok "signed in at the screen as $($h.desktopUser): GPU work runs in this desktop session" }
  else { Later 'Nobody is signed in at the screen, so GPU work would run in the background session, where renders can come out black. Set up automatic sign-in (see the checklist).' }
}
$dev = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue
if (-not $dev -or $dev.AllowDevelopmentWithoutDevLicense -ne 1) { Warn 'Developer Mode is off: symbolic links in projects will not unpack (Settings > System > For developers).' }

$ips = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -ExpandProperty IPAddress)
Step 'Next, on the Mac'
foreach ($ip in $ips) { Write-Host "   offload add $env:USERNAME@$ip --os windows --name win1" -ForegroundColor White }
Write-Host '   offload health'
if ($warnings.Count) {
  Step 'Still to do'
  foreach ($w in $warnings) { Write-Host "   - $w" -ForegroundColor Yellow }
}
