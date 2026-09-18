Laika Orbit node
===========

Lets Laika Orbit on your Mac run Claude sessions and terminals on this machine.

Install (as the user the sessions should run as, not root):

  tar -xzf orbit-node-<platform>.tar.gz
  ./orbit-node-<platform>/install.sh

It installs to ~/.local/share/orbit-node (macOS: ~/Library/Application Support/orbit-node),
starts as a user service, and prints the address to add in Laika Orbit. Nothing else needs to be
installed first: Node and Claude Code come in the bundle. If no SSH server is running, the
installer installs one (it asks for sudo).

How Laika Orbit reaches it: the agent host listens on 127.0.0.1 only. The Mac that built this
bundle connects over SSH with its own key, which ~/.ssh/authorized_keys allows to open a
tunnel to that one port and to rsync projects into ~/orbit-work (through rrsync), and
nothing else (no shell, no other commands, no other folders). Offloaded runs happen there:
see packages/app/offload.mjs in the Laika Orbit repo.

Keep this bundle as private as an SSH key: it holds the token the agent host asks for.

Logs:     journalctl --user -u orbit-node     (or agent-host.log in the install folder)
Restart:  systemctl --user restart orbit-node
Remove:   ~/.local/share/orbit-node/uninstall.sh
