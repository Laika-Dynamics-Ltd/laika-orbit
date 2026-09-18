#!/usr/bin/env bash
# Remove the Laika Orbit node from this machine: the service, the key it allowed, and its files.
# Claude Code logins (~/.claude, ~/.claude-accounts) and work folders are left alone.
set -uo pipefail

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; elif command -v sudo >/dev/null; then sudo "$@"; else return 1; fi
}

if [ "$(uname -s)" = Linux ]; then
  DEST="${XDG_DATA_HOME:-$HOME/.local/share}/orbit-node"
  CONF="${XDG_CONFIG_HOME:-$HOME/.config}/orbit-node"
  systemctl --user disable --now orbit-node 2>/dev/null
  rm -f "$HOME/.config/systemd/user/orbit-node.service"
  systemctl --user daemon-reload 2>/dev/null
  pkill -f "$DEST/bin/node agent-host.mjs" 2>/dev/null
  if command -v crontab >/dev/null && crontab -l 2>/dev/null | grep -q 'orbit-node/start.sh'; then
    crontab -l | grep -v 'orbit-node/start.sh' | crontab -
  fi
  [ -f /etc/avahi/services/orbit-node.service ] && as_root rm -f /etc/avahi/services/orbit-node.service
else
  DEST="$HOME/Library/Application Support/orbit-node"
  CONF="$DEST/config"
  launchctl bootout "gui/$(id -u)/com.laika.orbit-node" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/com.laika.orbit-node.plist"
fi

if [ -f "$HOME/.ssh/authorized_keys" ]; then
  grep -v ' orbit-node$' "$HOME/.ssh/authorized_keys" >"$HOME/.ssh/authorized_keys.orbit"
  mv "$HOME/.ssh/authorized_keys.orbit" "$HOME/.ssh/authorized_keys"
  chmod 600 "$HOME/.ssh/authorized_keys"
fi

rm -rf "$DEST" "$CONF"
echo "Laika Orbit node removed."
