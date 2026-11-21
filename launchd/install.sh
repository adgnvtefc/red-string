#!/bin/sh
# Installs (or reinstalls) the relay LaunchAgent. Safe to rerun after editing the plist.
# The plist says __HOME__ where your home folder goes (plists can't use ~); this fills it in.
set -eu
cd "$(dirname "$0")/.."
mkdir -p -m 700 ~/.red-string
mkdir -p ~/.red-string/logs ~/Library/LaunchAgents
label=com.hanmo.red-string
target=~/Library/LaunchAgents/"$label.plist"
sed "s|__HOME__|$HOME|g" "launchd/$label.plist" > "$target"
plutil -lint "$target" >/dev/null
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$target"
echo "loaded $label"
