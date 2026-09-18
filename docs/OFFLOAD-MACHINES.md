# Offload machines

The machines this Mac sends heavy work to: how each is reached, what it can run, and how work
picks one. Code: `packages/app/machines.mjs` (list, routing), `windows.mjs` (Windows transport),
`offload.mjs` (the command), `tools/windows-node/` (what runs on a Windows machine).

## The list

`brain/nodes.local.json` (not in git). Everything past name/user/host is optional. An entry without
it, like box1's, is a Linux machine with an agent host, exactly as before.

```json
{
  "machines": [
    { "name": "box1", "user": "devuser", "host": "192.168.1.20", "port": 22 },
    { "name": "win1", "os": "windows", "user": "devuser", "host": "192.168.1.21",
      "can": { "gpu": true }, "limits": { "jobs": 2, "reserve": 4e9 } }
  ]
}
```

- `os`: `linux` (default), `windows`, `mac`.
- `can`: overrides what the machine reports: `gpu` (a name, `true`, or `false`), `browsers`, `simulators`.
- `limits`: `jobs` is how many jobs this Mac sends there at once. `reserve` is the memory left free there.
- The rest comes from the machine itself: cores, memory, GPUs, Unity versions, tools, and whether
  someone is signed in at the screen (Windows).

## How each kind is reached

| | Linux / Mac (box1) | Windows |
|---|---|---|
| connection | ssh tunnel to the agent host (loopback :7420) | ssh to Windows' own OpenSSH |
| what the key may do | tunnel + rrsync into `~/orbit-work` | run `C:\laika\gate.ps1` only (forced command) |
| files | rsync (one transfer at a time: rrsync) | tar over ssh, from a manifest diff |
| jobs | agent host `/jobs` | gate `start` / `follow` / `kill`, run by `runner.ps1` |
| memory guard | refuse below reserve + systemd slice cap | refuse below reserve + job-object memory cap |
| cleanup | agent host keeps an hour of jobs | same, plus finished scheduled tasks, temp tars, copies unused for 14 days, `offload clean` |

**Why tar over ssh for Windows.** Windows ships `tar.exe` (bsdtar) and OpenSSH, so nothing extra
is installed. rsync would need WSL or Cygwin: a second system to maintain, slow NTFS access from
WSL, and paths translated both ways. scp can't tell what changed, so it would resend a whole Unity
project every time, and it can't delete. Instead the Mac fetches a manifest (path, size, mtime),
sends one tar of what differs plus a list of removals, and pulls outputs back the same way. That
matches rsync `-a --delete` going up and `--update` coming down, in two round trips.

**Why a desktop session for GPU work.** A process started over ssh runs in a background session.
There, rendering can come out black, which is box1's dark-render problem. GPU jobs (Unity,
Blender, captures) run as a scheduled task in the signed-in user's desktop session instead, so
the box needs automatic sign-in. Other jobs run in the background through WMI, so they outlive the
ssh connection.

## Routing

`chooseMachine({ gpu, posix, unity, memory })`:

- **GPU work** (Unity, Blender, captures, browsers, renders, bakes) goes to a machine that renders
  properly first: a real GPU and, on Windows, someone signed in. Next choice is any machine with a
  GPU, then (as before any existed) any machine. So box1 still takes GPU work when nothing better
  is online, with a note that it may come out dark.
- **CPU work** goes to any machine, least busy first.
- **Shell scripts** (`sh`, `bash`, `./x.sh`, `make`) go only to machines that aren't Windows.
  ffmpeg-offload stays on Linux, since its staging and ffmpeg build are Unix-specific.
- `offload run --needs gpu|cpu` overrides the guess. `offload where` shows the pick.

The load watcher and chats use the same routes. The app writes `~/.laika/machines.json` when it
polls the machines. The load watcher names the machine new work goes to ("new ones go to win1").
`/resume-offload` tells chats to leave out `--on`.

## Commands

```
offload health [--json]              each machine: reachable or why not, what it can run, routes
offload where [--needs gpu|cpu]      where a job would go now
offload add user@host --os windows --name win1
offload windows-kit                  ~/.laika/node/windows-kit: setup.ps1, gate, runner, checklist, public key
offload clean --on win1              drop this folder's copy there
```

## Verified, and not

Verified on 2026-09-18, without the Windows box:
- `offload health` and `offload where` against box1, and with an unreachable Windows entry.
- gate.ps1's file verbs (manifest, recv with deletions, send with a missing path), end to end
  from windows.mjs through a stand-in ssh that runs gate.ps1 under PowerShell 7 on macOS.
- All three .ps1 files parse, and runner.ps1's C# compiles (Roslyn, not PowerShell 5.1's compiler).
- The machines card in a browser, against a throwaway server.
- Affected unit tests: machines, nodes, loadwatch, fleet-work, ffmpeg-offload.

Only verifiable on the box:
- setup.ps1 on real Windows: the OpenSSH install, the firewall rule, sshd_config, the keys files
  and their ACLs, the forced command through the PowerShell default shell.
- Binary stdin and stdout through Windows sshd into PowerShell 5.1 (the tar stream).
- health (CIM, nvidia-smi, Unity Hub paths), start through WMI and scheduled tasks, runner.ps1
  under 5.1 (Add-Type with the old C# compiler), the job-object memory cap, kill.
- Whether GPU work renders correctly in the desktop session (the point of all this).
