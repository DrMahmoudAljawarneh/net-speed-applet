# Net Speed & IP Address — applets for the Ubuntu top panel

Two small native GNOME Shell extensions for Ubuntu 26.04 (GNOME Shell 50):

- **Net Speed** (`net-speed@drmj`) — live system stats **right** of the clock.
- **IP Address** (`ip-history@drmj`) — current public IP **left** of the clock,
  with a daily log that resets at 03:00.

```
IP 203.0.113.42   |   10:42   |   ↓ 845 KB/s   ↑ 12.3 KB/s   CPU 12%   RAM 38%
```

## Net Speed

Shows live system stats in the **center** of the top panel, just right of the
clock:

```
↓ 845 KB/s   ↑ 12.3 KB/s   CPU 12%   RAM 38%
```

The panel rates stay in **KB/s and MB/s** (no B/s or GB/s), and each value
reserves the width of its widest possible text, so the bar never shifts as the
numbers change. The download and upload arrows are small theme-colored icons
(green down, blue up) shipped with the extension. The menu still shows
auto-scaled byte values plus bit rates.

Click it for a menu with:

- current download/upload rates, in bytes **and** bits per second
- data transferred since the extension was enabled (session totals)
- CPU usage meter, per-core usage bars, core count and 1/5/15-minute load
  averages
- memory meter with used / total, available memory and swap usage
- a per-interface network breakdown (Wi-Fi, Ethernet, VPN, ...)
- **Reset session totals**

Everything comes from `/proc` — no daemon, no root access, and no network
traffic of its own. Values are sampled once a second.

## IP Address

Shows the PC's current **public** IP address in the **center** of the top panel,
immediately **left** of the clock:

```
IP 203.0.113.42
```

Private, link-local, loopback, CGNAT and container/tunnel addresses are never
shown or logged, even if a lookup service returns one. The panel reserves the
width of a full IPv4 address (`255.255.255.255`), so it does not jump when the
address changes.

The address is looked up over HTTPS every 5 minutes (60-second retries while
offline) from the first service that answers:

1. `https://api.ipify.org` (IPv4)
2. `https://ipv4.icanhazip.com` (IPv4)
3. `https://ifconfig.me/ip` (IPv4 or IPv6)

Click the applet for a menu with:

- the current public address and when it was last checked
- **Copy current IP**
- **Check now**
- the log of public addresses used since the last 03:00 reset, with the time
  range and duration of each
- **Clear log now**

While offline (or before the first lookup finishes) the panel shows
**No internet** instead of a stale address, and retries every minute. The last
address stays in the log until the next 03:00 reset, but it is not displayed.

The log is stored in
`~/.local/share/ip-history@drmj/history.json` and is cleared automatically
every day at **03:00 local time**. If the PC was off or suspended at 03:00,
the reset happens the next time the extension runs. Entries with private
addresses from older versions are discarded automatically.

## Install

```bash
cd ~/net-speed-applet
./install.sh
```

Then **log out and back in** (Wayland cannot reload GNOME Shell in place).
The IP applet appears immediately left of the clock and the speed applet
immediately right of it.

Manual install, if you prefer:

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r ~/net-speed-applet/net-speed@drmj \
      ~/net-speed-applet/ip-history@drmj \
      ~/.local/share/gnome-shell/extensions/
```

Then log out and back in, and enable them once with
`gnome-extensions enable net-speed@drmj` and
`gnome-extensions enable ip-history@drmj` (or the Extensions app).

## Uninstall

```bash
./install.sh --uninstall
```

Then log out and back in. Your IP log in
`~/.local/share/ip-history@drmj/history.json` is kept; delete that directory
if you want it gone too.

## Files

```
net-speed-applet/
├── install.sh                 # install / enable / uninstall both applets
├── dev-nested.sh              # run a nested Shell for development
├── net-speed@drmj/
│   ├── metadata.json          # UUID, name, supported shell versions
│   ├── extension.js           # all of the logic
│   ├── stylesheet.css         # panel/menu styling
│   ├── net-speed-down-symbolic.svg
│   └── net-speed-up-symbolic.svg
└── ip-history@drmj/
    ├── metadata.json
    ├── extension.js           # address detection, history, 03:00 reset
    └── stylesheet.css
```

The IP log is data, not part of the extension, so it lives under
`~/.local/share/ip-history@drmj/` rather than inside the extension folder.

## Where the numbers come from

### Net Speed

| Metric | Source |
| --- | --- |
| Download / upload | `/proc/net/dev` byte deltas, all interfaces except `lo` |
| CPU | `/proc/stat`, idle+iowait vs total, plus per-core counters for the bars |
| Memory | `/proc/meminfo`, `MemTotal` − `MemAvailable`, `MemAvailable`, swap |
| Load average | `/proc/loadavg` (menu only) |

VPN traffic also shows up on the physical interface; the per-interface list in
the menu makes that clear. Session totals start when the extension loads, not
at boot.

### IP Address

| Metric | Source |
| --- | --- |
| Public address | HTTPS lookup via ipify / icanhazip / ifconfig.me |
| Log | `~/.local/share/ip-history@drmj/history.json`, reset at 03:00 |

The lookup service sees your public IP (it has to, to answer) and the request
itself, but no other data is sent. Private, CGNAT, loopback and link-local
results are rejected before they reach the panel or the log.

## Customizing

### Net Speed

- **Refresh rate** — `REFRESH_INTERVAL_MS` at the top of
  `net-speed@drmj/extension.js` (default `1000` ms).
- **Placement** — in `enable()`:

  ```js
  Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'center');
  ```

  `1` puts it immediately right of the clock (`0` would be left), and
  `_keepRightOfClock()` keeps it there when the panel is rebuilt after
  unlocking. Change `'center'` to `'right'` / `'left'` for the outer groups.
- **Panel units** — the panel uses `formatKbMbSpeed()` (KB/s below 1 MB/s,
  MB/s above). Change that function to alter the units; if you change the
  formatting, update the probe strings in `_fixLabelWidths()` (for example
  `'9999 MB/s'`) so the reserved width still fits the widest value. The menu
  is independent and always shows auto-scaled bytes and bits.
- **Arrow colors** — `.net-speed-arrow-down` / `.net-speed-arrow-up` in
  `stylesheet.css`. The SVGs are symbolic, so the shell recolors them from the
  CSS `color` property and they follow light/dark themes.
- **Meters** — the CPU/memory accent colors are the `-net-speed-accent` custom
  properties near the bottom of `stylesheet.css`.
- **Ignore an interface** (e.g. a VPN) — add its name next to the `lo` check
  in `readCounters()`.
- **Hide CPU or RAM** — remove (or `.hide()`) the corresponding
  `box.add_child(this._cpuLabel)` / `box.add_child(this._ramLabel)` lines in
  `_init()`.

### IP Address

- **Check interval** — `CHECK_INTERVAL_SECONDS` (default `300` s) and
  `RETRY_INTERVAL_SECONDS` (default `60` s while offline) in
  `ip-history@drmj/extension.js`.
- **Reset time** — `RESET_HOUR` (default `3`, i.e. 03:00 local time).
- **Placement** — in `enable()`:

  ```js
  Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'center');
  ```

  `0` puts it immediately left of the clock, and `_keepLeftOfClock()` keeps
  it there when the panel is rebuilt after unlocking.
- **Lookup services** — `PUBLIC_IP_ENDPOINTS` at the top of `extension.js`;
  they are tried in order. Results are only accepted if they parse as a public
  IPv4/IPv6 address (`isPublicIPv4()` / `isPublicIPv6()`).
- **History location** — `HISTORY_PATH` near the top of `extension.js`.
  Delete the file to start the log fresh. `MAX_HISTORY_ENTRIES` caps a day's
  log at 200 entries.

## Development

After editing files, run `./dev-nested.sh`. It refreshes the installed copy and
opens a nested GNOME Shell window with the applet; close the window when done,
edit, and run it again. On GNOME 49+ this needs the `mutter-dev-bin` package
(the nested-shell viewer); the script tells you if it is missing. Logging out
and back in works too, but is slower.

Do not call `gnome-extensions list`/`info` while the nested shell is still
starting: GNOME 50's extension helper can race the shell and print harmless
"Argument string may not be null" criticals in that window.

Useful when something does not show up:

```bash
# extension state / errors
gnome-extensions info net-speed@drmj
gnome-extensions info ip-history@drmj

# live shell log
journalctl -f -o cat /usr/bin/gnome-shell
```

Look for lines mentioning `net-speed`, `ip-history` or `JS ERROR`.

## Notes and limitations

- Speeds are sampled every second, so short bursts may look spiky.
- Fixed label widths are measured from the widest possible value at startup
  (for example `9999 MB/s` and `255.255.255.255`); numbers change inside that
  space without moving the panel. If you change the desktop font size later,
  the labels grow only if the text actually needs more room.
- CPU percentage is across all cores (e.g. one busy core on an 8-core machine
  shows about 12%). The per-core bars under the CPU meter show each core
  separately.
- Memory "used" is `MemTotal − MemAvailable`, which counts reclaimable cache
  as available, matching most system monitors.
- Interface counters are 64-bit; the rare counter reset (driver reload,
  reconnect) is detected and skipped rather than shown as a huge spike.
- The IP applet needs `curl` (installed by default) and an internet
  connection for the public lookup. While offline the panel says
  **No internet** and retries every minute; the last known address is kept in
  the log but is not shown in the panel or menu.
- Only the public address is logged, once per change; the "first seen" time is
  when the extension noticed the change. Private addresses are never stored.
- The daily 03:00 reset is applied whenever the applet runs: if the PC was off
  or suspended at 03:00, the old log is cleared the next time it starts.
- Tested on Ubuntu 26.04 with GNOME Shell 50. The metadata also allows GNOME
  45–49, which use the same APIs, but those were not tested here.
