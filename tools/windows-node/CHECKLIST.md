# Windows GPU box: setup checklist

One page, in order. About 30 minutes plus downloads. The script does the parts that can be scripted;
this list is the clicking it can't do.

## Before (on the Windows box, by hand)

1. **Windows up to date.** Settings › Windows Update › install everything and restart. The SSH server
   installs from Windows Update, so a stale box fails at step 1 of the script.
2. **GPU driver.** Install the current NVIDIA Studio or Game Ready driver from nvidia.com (it also
   installs `nvidia-smi`, which Orbit reads GPU load from). AMD: Adrenalin.
3. **Headless?** If the box will run with no monitor, plug in an HDMI or DisplayPort dummy plug.
   Without a display, many GPUs do not start a desktop, and renders come out black: the box1 problem.
4. **Network is Private.** Settings › Network & internet › your connection › **Private network**.
   The script lets SSH in on Private networks only.
5. **Fixed address.** On your router, reserve an IP (DHCP reservation) for this box, so the Mac's
   address for it never changes.
6. **Developer Mode on.** Settings › System › For developers › Developer Mode. Lets symbolic links
   in projects unpack.
7. **Tools:**
   - Unity Hub, and the editor versions your projects use (Hub › Installs; tick Windows Build
     Support). Use the default install folder, or set it once in Hub; the script finds both.
   - Node.js LTS (nodejs.org).
   - Git for Windows (git-scm.com). Optional.
   - Chrome. Optional: Playwright can bring its own.

## Run the script (on the Windows box)

8. On the Mac, run `offload windows-kit`. It makes a folder (`~/.laika/node/windows-kit`) with
   `setup.ps1`, `gate.ps1`, `runner.ps1`, this checklist and `laika-orbit.pub`, the Mac's **public** key
   (not a secret; the private key never leaves the Mac). Copy the folder to the box on a USB stick.
9. Start › type *PowerShell* › right-click › **Run as administrator**, then:

   ```
   cd <the copied folder>
   powershell -ExecutionPolicy Bypass -File .\setup.ps1
   ```

   It ends with a **Still to do** list if anything is missing, and prints the exact
   `offload add …` line for the Mac. Safe to run again after fixing anything.

## After (by hand)

10. **Automatic sign-in**, so GPU work runs in a real desktop session after a restart. Background
    sessions can render black, which is box1's problem. Use Sysinternals **Autologon**
    (learn.microsoft.com/sysinternals/downloads/autologon): enter the password in its window. It is
    stored encrypted by Windows, never in a file or in chat. Then set Settings › Accounts ›
    Sign-in options › *If you've been away* to **Never**.
11. **No sleep.** The script turns sleep off on mains power. If the box has a vendor power tool
    (ASUS, MSI and so on), check that it doesn't put the box to sleep anyway.

## On the Mac

12. Paste the line the script printed: `offload add <you>@<ip> --os windows --name win1`
13. `offload health`: win1 should read **online** and list its GPU, Unity versions and tools. It
    also appears under Machines in Orbit's top bar.
14. First real job: `offload unity --on win1 -- -runTests -testPlatform EditMode …` from a Unity
    project, or `offload run --on win1 --needs gpu -- node capture.mjs`.

## If something is wrong

- `offload health` says *connection refused* or *timed out*: sshd isn't running, the network is
  Public, or the address changed. On the box: `Get-Service sshd`, `Get-NetConnectionProfile`.
- It says *permission denied (publickey)*: the key didn't land. Re-run `setup.ps1`, then look at
  `C:\ProgramData\ssh\administrators_authorized_keys` for a line ending `laika-orbit`.
- Renders are black: nobody is signed in at the screen (step 10), or there is no display
  (step 3). `offload health` shows *desktop: no* when this is the case.
- Undo everything: delete the `laika-orbit` line from both authorized-keys files, delete `C:\laika`,
  and optionally `Stop-Service sshd; Set-Service sshd -StartupType Disabled`.
