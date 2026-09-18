#!/usr/bin/env bash
# Install (or update) the Laika Orbit node on this machine: the agent host that runs Claude sessions
# and terminals for Laika Orbit, as a service that starts with the machine.
#
#   ./install.sh             install or update
#   ./install.sh --capped    for a machine with work of its own (cameras, a server): one job at a
#                            time, at the lowest CPU priority. Kept on later updates; --uncapped lifts it.
#
# The agent host listens on 127.0.0.1 only. The Mac that built this bundle reaches it through
# SSH, with a key this installer allows to open a tunnel to that one port and to rsync into
# ~/orbit-work, and nothing else.
# Run it as the user the sessions should run as; it asks for sudo only to install an SSH server
# or announce the machine on the network.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/bundle.env"
CAP=keep
for a in "$@"; do
  case "$a" in
    --capped) CAP=on ;;
    --uncapped) CAP=off ;;
    *) echo "unknown option $a (use --capped or --uncapped)" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
fail() {
  printf '\033[31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; elif command -v sudo >/dev/null; then sudo "$@"; else return 1; fi
}

[ "$(id -u)" = 0 ] && warn "Installing as root: sessions will run as root. Run as your own user unless that is what you want."

# ---------------------------------------------------------------- platform ----
case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "This bundle installs on Linux or macOS." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) cpu=x64 ;;
  aarch64 | arm64) cpu=arm64 ;;
  *) fail "Unsupported processor: $(uname -m)" ;;
esac
[ "$os-$cpu" = "$TARGET" ] || fail "This bundle is for $TARGET; this machine needs orbit-node-$os-$cpu.tar.gz"
if [ "$os" = linux ] && (ldd --version 2>&1 || true) | grep -qi musl; then
  fail "This machine uses musl (Alpine?); the bundle needs glibc."
fi


# the official Node build links libatomic, which minimal installs leave out
if ! "$HERE/bin/node" --version >/dev/null 2>&1; then
  if [ "$os" = linux ]; then
    bold "Installing libatomic, which Node needs (sudo)"
    if command -v apt-get >/dev/null; then
      as_root apt-get update -qq && as_root apt-get install -y -qq libatomic1
    elif command -v dnf >/dev/null; then
      as_root dnf install -y libatomic
    elif command -v pacman >/dev/null; then
      as_root pacman -S --noconfirm gcc-libs
    fi || true
  fi
  "$HERE/bin/node" --version >/dev/null || fail "The bundled Node does not run here: $("$HERE/bin/node" --version 2>&1 | head -1)"
fi

if [ "$os" = linux ]; then
  DEST="${XDG_DATA_HOME:-$HOME/.local/share}/orbit-node"
  CONF="${XDG_CONFIG_HOME:-$HOME/.config}/orbit-node"
else
  DEST="$HOME/Library/Application Support/orbit-node"
  CONF="$DEST/config"
fi
NODE="$DEST/bin/node"
USER_NAME="$(id -un)"
USER_SHELL="$(getent passwd "$USER_NAME" 2>/dev/null | cut -d: -f7 || true)"
[ -n "$USER_SHELL" ] || USER_SHELL="${SHELL:-/bin/bash}"

# ------------------------------------------------------------------- stop ----
stop_service() {
  if [ "$os" = linux ]; then
    systemctl --user stop orbit-node 2>/dev/null || true
    pkill -f "$NODE agent-host.mjs" 2>/dev/null || true
  else
    launchctl bootout "gui/$(id -u)/com.laika.orbit-node" 2>/dev/null || true
  fi
}
stop_service

# ------------------------------------------------------------------ files ----
bold "Installing to $DEST"
mkdir -p "$DEST/brain" "$CONF"
rm -rf "$DEST/app" "$DEST/bin"
cp -R "$HERE/app" "$HERE/bin" "$DEST/"
cp "$HERE/uninstall.sh" "$HERE/bundle.env" "$HERE/README.txt" "$HERE/NODE-LICENSE" "$DEST/"
chmod 755 "$DEST/uninstall.sh" "$NODE"
find "$DEST/app/node_modules" \( -name claude -o -name spawn-helper \) -type f -exec chmod 755 {} +
(umask 077 && cp "$HERE/token" "$CONF/token")
chmod 600 "$CONF/token"

# a cap chosen before survives an update unless this run says otherwise
if [ "$CAP" = keep ]; then
  if [ -f "$DEST/start.sh" ] && grep -q AGENT_MAX_JOBS "$DEST/start.sh"; then CAP=on; else CAP=off; fi
fi
CAPPED=""
if [ "$CAP" = on ]; then
  CAPPED="export AGENT_MAX_JOBS='1'
export AGENT_JOB_NICE='19'"
  bold "Capped: one job at a time, at the lowest CPU priority"
fi

# start.sh is the one place the service's settings live; systemd, launchd and cron all run it
cat >"$DEST/start.sh" <<EOF
#!/bin/sh
export AGENT_PORT='$PORT'
export AGENT_TOKEN_FILE='$CONF/token'
export BRAIN_ROOT='$DEST'
export SHELL='$USER_SHELL'
# tools set up for jobs (a current ffmpeg, Blender, npm) come before the system's own
export PATH='$DEST/bin:$HOME/orbit-work/.tools/bin:$PATH'
$CAPPED
cd '$DEST/app' && exec '$NODE' agent-host.mjs
EOF
chmod 755 "$DEST/start.sh"

# -------------------------------------------------------------------- key ----
# the Mac's key may forward to the agent host's port and sync projects into the work folder with
# rsync, and do nothing else: no shell, no other commands, no other folders
bold "Allowing Laika Orbit's key to reach the agent host"
WORK="$HOME/orbit-work"
mkdir -p "$HOME/.ssh" "$WORK/.tools/bin"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
if ! command -v rsync >/dev/null && [ "$os" = linux ]; then
  if command -v apt-get >/dev/null; then as_root apt-get install -y -qq rsync; elif command -v dnf >/dev/null; then as_root dnf install -y rsync; elif command -v pacman >/dev/null; then as_root pacman -S --noconfirm rsync; fi || true
fi
RRSYNC="$(command -v rrsync || true)"
if [ -n "$RRSYNC" ] && command -v rsync >/dev/null; then
  KEYCMD="$RRSYNC $WORK"
else
  KEYCMD="echo Laika Orbit node: tunnel only"
  warn "rrsync not found: Laika Orbit can reach the agent host but cannot sync projects here (install rsync 3.2.4 or newer)."
fi
KEYLINE="restrict,port-forwarding,permitopen=\"127.0.0.1:$PORT\",command=\"$KEYCMD\" $(cat "$HERE/authorized_key")"
{
  grep -v ' orbit-node$' "$HOME/.ssh/authorized_keys" || true
  echo "$KEYLINE"
} >"$HOME/.ssh/authorized_keys.orbit"
mv "$HOME/.ssh/authorized_keys.orbit" "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"

# ---------------------------------------------------------------- service ----
bold "Starting the agent host"
service=none
if [ "$os" = linux ]; then
  if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
    mkdir -p "$HOME/.config/systemd/user"
    cat >"$HOME/.config/systemd/user/orbit-node.service" <<EOF
[Unit]
Description=Laika Orbit node: Claude sessions and terminals for Laika Orbit
After=network-online.target

[Service]
ExecStart="$DEST/start.sh"
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable orbit-node 2>/dev/null
    systemctl --user restart orbit-node
    service=systemd
    # keep the service running with nobody logged in, and start it at boot
    if ! loginctl enable-linger "$USER_NAME" 2>/dev/null; then
      as_root loginctl enable-linger "$USER_NAME" || warn "Could not enable lingering: the agent host stops when you log out. Run: sudo loginctl enable-linger $USER_NAME"
    fi
  else
    # no user systemd (a container, WSL without systemd): run it now, and at boot through cron
    nohup "$DEST/start.sh" >>"$DEST/agent-host.log" 2>&1 &
    service=nohup
    if command -v crontab >/dev/null; then
      { crontab -l 2>/dev/null | grep -v 'orbit-node/start.sh' || true; echo "@reboot '$DEST/start.sh' >>'$DEST/agent-host.log' 2>&1"; } | crontab -
      service=cron
    else
      warn "No systemd user session and no cron: the agent host will not start again after a reboot. Run $DEST/start.sh"
    fi
  fi
else
  PLIST="$HOME/Library/LaunchAgents/com.laika.orbit-node.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.laika.orbit-node</string>
  <key>ProgramArguments</key><array><string>$DEST/start.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DEST/agent-host.log</string>
  <key>StandardErrorPath</key><string>$DEST/agent-host.log</string>
</dict>
</plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  service=launchd
fi

# ------------------------------------------------------------- SSH server ----
listening() { "$NODE" -e "require('net').connect($1,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; }
if ! listening 22; then
  if [ "$os" = darwin ]; then
    warn "SSH is off. Turn on System Settings → General → Sharing → Remote Login."
  else
    bold "Installing an SSH server (sudo)"
    if command -v apt-get >/dev/null; then
      as_root apt-get update -qq && as_root apt-get install -y openssh-server && as_root systemctl enable --now ssh
    elif command -v dnf >/dev/null; then
      as_root dnf install -y openssh-server && as_root systemctl enable --now sshd
    elif command -v pacman >/dev/null; then
      as_root pacman -S --noconfirm openssh && as_root systemctl enable --now sshd
    fi || true
    listening 22 || warn "No SSH server is listening on port 22: install and start openssh-server, or Laika Orbit cannot connect."
  fi
fi

# -------------------------------------------------- announce on the network ----
# so Laika Orbit can list this machine without being told its address
if [ "$os" = linux ] && [ -d /etc/avahi/services ]; then
  as_root tee /etc/avahi/services/orbit-node.service >/dev/null <<EOF || warn "Could not announce this machine on the network; add it in Laika Orbit by address."
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">Laika Orbit on %h</name>
  <service>
    <type>_laikaorbit._tcp</type>
    <port>22</port>
    <txt-record>user=$USER_NAME</txt-record>
    <txt-record>agent=$PORT</txt-record>
  </service>
</service-group>
EOF
fi

# ------------------------------------------------------------------ check ----
for _ in $(seq 1 30); do
  if "$NODE" -e "
    fetch('http://127.0.0.1:$PORT/health', { headers: { 'x-agent-token': require('fs').readFileSync('$CONF/token', 'utf8').trim() } })
      .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; then
    ok=1
    break
  fi
  sleep 1
done
[ "${ok:-}" = 1 ] || fail "The agent host did not answer on 127.0.0.1:$PORT. See: $([ $service = systemd ] && echo "journalctl --user -u orbit-node" || echo "$DEST/agent-host.log")"

ADDRS="$("$NODE" -e "
  const all = Object.values(require('os').networkInterfaces()).flat()
  console.log(all.filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address).join('  '))")"
echo
bold "✓ Laika Orbit node is running ($service), agent host on 127.0.0.1:$PORT"
echo "  Add this machine in Laika Orbit:  $USER_NAME@$(hostname)   ($ADDRS)"
echo "  Remove it again:             '$DEST/uninstall.sh'"
