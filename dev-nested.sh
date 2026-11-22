#!/usr/bin/env bash
# Open a nested GNOME Shell (a window on your desktop) with the applet in it.
# Wayland cannot reload the real shell, so this is the quick way to test edits.
#
# GNOME 49+ replaced `--nested` with `--devkit`, and the windowed viewer lives
# in mutter-devkit (Ubuntu package: mutter-dev-bin). Without it, log out and
# back in instead to test in the real session.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$HERE/install.sh" >/dev/null

if gnome-shell --help 2>&1 | grep -q -- '--devkit'; then
    if [[ ! -x /usr/libexec/mutter-devkit ]]; then
        cat >&2 <<'EOF'
mutter-devkit is not installed, so the nested shell cannot open a window.

Either install it once:
    sudo apt install mutter-dev-bin

or log out and back in to load the applet in your real session.
EOF
        exit 1
    fi
    echo "Starting nested shell. Close its window to quit."
    exec dbus-run-session -- gnome-shell --devkit --wayland
fi

# GNOME 48 and earlier.
echo "Starting nested shell. Close its window to quit."
exec dbus-run-session -- gnome-shell --nested --wayland
