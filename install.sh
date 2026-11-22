#!/usr/bin/env bash
# Install (or remove) the panel applets for the current user:
#   net-speed@drmj   network/CPU/RAM readout, right of the clock
#   ip-history@drmj  current IP address and daily log, left of the clock
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"
UUIDS=("net-speed@drmj" "ip-history@drmj")

enable_extension() {
    local uuid="$1"

    # The running shell does not know about a freshly copied extension yet, so
    # the D-Bus call usually fails. Fall back to editing enabled-extensions
    # directly; GNOME picks it up at the next login.
    if gnome-extensions enable "$uuid" 2>/dev/null; then
        return
    fi

    local current
    current="$(gsettings get org.gnome.shell enabled-extensions)"

    if [[ "$current" == *"'$uuid'"* ]]; then
        :
    elif [[ "$current" == "@as []" || "$current" == "[]" ]]; then
        gsettings set org.gnome.shell enabled-extensions "['$uuid']"
    else
        gsettings set org.gnome.shell enabled-extensions "${current%]}, '$uuid']"
    fi
}

if [[ "${1:-}" == "--uninstall" ]]; then
    for uuid in "${UUIDS[@]}"; do
        gnome-extensions disable "$uuid" 2>/dev/null || true
        rm -rf "${EXTENSIONS_DIR:?}/$uuid"
        echo "Removed ${EXTENSIONS_DIR:?}/$uuid"
    done
    echo
    echo "Log out and back in to finish removing the applets."
    echo "The IP log is kept in ${XDG_DATA_HOME:-$HOME/.local/share}/ip-history@drmj/history.json"
    exit 0
fi

for uuid in "${UUIDS[@]}"; do
    src="$HERE/$uuid"
    dest="$EXTENSIONS_DIR/$uuid"

    if [[ ! -f "$src/metadata.json" ]]; then
        echo "error: $src/metadata.json not found" >&2
        exit 1
    fi

    mkdir -p "$dest"
    cp -f "$src/metadata.json" "$src/extension.js" "$src/stylesheet.css" "$dest"/
    [[ -f "$src/prefs.js" ]] && cp -f "$src/prefs.js" "$dest"/

    if [[ -d "$src/schemas" ]]; then
        mkdir -p "$dest/schemas"
        cp -f "$src/schemas"/*.gschema.xml "$dest/schemas"/
        glib-compile-schemas "$dest/schemas"
    fi

    # Optional bundled icons.
    for icon in "$src"/*-symbolic.svg; do
        [[ -e "$icon" ]] && cp -f "$icon" "$dest"/
    done

    enable_extension "$uuid"
    echo "Installed and enabled $uuid"
done

echo
echo "Log out and back in to load the applets. The IP address then appears"
echo "left of the clock, and the network/CPU/RAM readout right of it."
echo "Click either one for details."
