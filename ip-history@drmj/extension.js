/* ip-history@drmj
 *
 * Shows the current public IP address in the GNOME top panel, immediately
 * left of the clock, and keeps a daily log of the public addresses this PC
 * has used. The log is cleared automatically every day at 03:00 local time.
 *
 * The public address is looked up over HTTPS (ipify, icanhazip, ifconfig.me)
 * every few minutes. Private/link-local/loopback addresses are never shown or
 * logged, even if a lookup service misbehaves.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Public addresses change rarely. Five minutes keeps the panel current without
// hammering the lookup services; failures are retried sooner.
const CHECK_INTERVAL_SECONDS = 300;
const RETRY_INTERVAL_SECONDS = 60;
const REQUEST_TIMEOUT_SECONDS = 10;
// Clear the log at this local hour every day.
const RESET_HOUR = 3;
// Never keep more than this many entries in one day's log.
const MAX_HISTORY_ENTRIES = 200;
// Throttle disk writes while the active entry's "last seen" time ticks up.
const SAVE_INTERVAL_SECONDS = 60;

// [url, force IPv4]. HTTPS is mandatory: an on-path attacker must not be able
// to feed us a bogus address.
const PUBLIC_IP_ENDPOINTS = [
    ['https://api.ipify.org', true],
    ['https://ipv4.icanhazip.com', true],
    ['https://ifconfig.me/ip', false],
];

const HISTORY_PATH = GLib.build_filenamev(
    [GLib.get_user_data_dir(), 'ip-history@drmj', 'history.json']);

const loggedReadFailures = new Set();

function formatClock(unixSeconds) {
    const date = GLib.DateTime.new_from_unix_local(unixSeconds);
    return date ? date.format('%H:%M') : '—';
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0)
        return '—';
    if (seconds < 60)
        return '<1 min';

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes} min`;

    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

function isPublicIPv4(address) {
    const parts = address.split('.');
    if (parts.length !== 4)
        return false;

    const octets = parts.map(part => /^\d{1,3}$/.test(part)
        ? Number.parseInt(part, 10) : NaN);
    if (octets.some(value => !Number.isInteger(value) || value < 0 || value > 255))
        return false;

    const [a, b] = octets;

    if (a === 0 || a === 10 || a === 127) // this-network, private, loopback
        return false;
    if (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
        return false;
    if (a === 169 && b === 254) // link-local
        return false;
    if (a === 172 && b >= 16 && b <= 31) // private
        return false;
    if (a === 192 && b === 168) // private
        return false;
    if (a === 192 && b === 0) // special-purpose (192.0.0.0/24, 192.0.2.0/24)
        return false;
    if (a === 198 && (b === 18 || b === 19)) // benchmarking
        return false;
    if (a >= 224) // multicast and reserved
        return false;

    return true;
}

function isPublicIPv6(address) {
    if (!address.includes(':') || !/^[0-9a-fA-F:.]+$/.test(address))
        return false;

    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1')
        return false;
    if (/^f[cd]/.test(lower)) // unique local fc00::/7
        return false;
    if (/^fe[89ab]/.test(lower)) // link-local fe80::/10
        return false;
    if (/^ff/.test(lower)) // multicast
        return false;

    return true;
}

/**
 * Accepts plain-text output from a lookup service and returns a normalised
 * address only if it is a public one.
 *
 * @param {string} text service response
 * @returns {string|null}
 */
function parsePublicAddress(text) {
    if (!text)
        return null;

    // Some services append a newline or wrap the address in brackets.
    const value = text.trim().split(/\s+/)[0]
        .replace(/^\[/, '').replace(/\]$/, '');

    if (isPublicIPv4(value) || isPublicIPv6(value))
        return value;

    return null;
}

const IpIndicator = GObject.registerClass(
class IpIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'IP Address');
        this.menu.box.add_style_class_name('ip-menu');

        this._checkTimeoutId = 0;
        this._resetTimeoutId = 0;
        this._networkMonitorId = 0;
        this._lastSave = 0;
        this._dirty = false;
        this._fetchInFlight = false;
        this._geoInfo = null;
        this._geoIp = null;
        this._stopped = false;

        this._publicIp = null;
        this._online = false;
        this._lastChecked = 0;
        this._lastReset = 0;
        this._history = [];

        this._loadHistory();

        const box = new St.BoxLayout({
            style_class: 'ip-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._panelLabel = new St.Label({
            style_class: 'ip-panel-label',
            text: 'IP —',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._panelLabel);
        this.add_child(box);

        this._buildMenu();

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen)
                return;
            const width = Math.max(300, Math.ceil(this.get_width()));
            this.menu.box.set_style(`min-width: ${width}px;`);
            this._refreshLabels();
            this._refreshHistory();
        });
    }

    _buildMenu() {
        this.menu.removeAll();

        this._currentBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'ip-current-box',
        });

        const currentTitle = new St.Label({
            text: 'Public IP',
            style_class: 'ip-current-title',
        });
        this._currentValue = new St.Label({
            text: this._fetchInFlight ? 'Checking…' : 'Unavailable',
            style_class: 'ip-current-value',
        });
        this._currentInfo = new St.Label({
            text: '',
            style_class: 'ip-current-info',
            x_expand: true,
        });

        this._currentBox.add_child(currentTitle);
        this._currentBox.add_child(this._currentValue);
        this._currentBox.add_child(this._currentInfo);

        const currentItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            activate: false,
            hover: false,
            can_focus: false,
            style_class: 'ip-current-row',
        });
        currentItem.setOrnament(PopupMenu.Ornament.HIDDEN);
        currentItem.add_child(this._currentBox);
        this.menu.addMenuItem(currentItem);

        this._copyItem = new PopupMenu.PopupMenuItem('Copy current IP');
        this._copyItem.setOrnament(PopupMenu.Ornament.HIDDEN);
        this._copyItem.connect('activate', () => {
            if (!this._publicIp)
                return;
            const clipboard = St.Clipboard.get_default();
            clipboard.set_text(St.ClipboardType.CLIPBOARD, this._publicIp);
        });
        this.menu.addMenuItem(this._copyItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Check now');
        refreshItem.setOrnament(PopupMenu.Ornament.HIDDEN);
        refreshItem.connect('activate', () => this._fetchPublicIp());
        this.menu.addMenuItem(refreshItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._historySection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._historySection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const clearItem = new PopupMenu.PopupMenuItem('Clear log now');
        clearItem.setOrnament(PopupMenu.Ornament.HIDDEN);
        clearItem.connect('activate', () => {
            this._history = [];
            this._lastReset = latestResetBoundary();
            this._markDirty();
            this._saveHistory();
            this._recordPublicIp();
            this._refreshHistory();
        });
        this.menu.addMenuItem(clearItem);

        const footer = new PopupMenu.PopupMenuItem(
            'Public IP checked every 5 min · log resets daily at 03:00',
            {reactive: false});
        footer.setOrnament(PopupMenu.Ornament.HIDDEN);
        footer.label.add_style_class_name('ip-menu-footer');
        this.menu.addMenuItem(footer);
    }

    _loadHistory() {
        try {
            const file = Gio.File.new_for_path(HISTORY_PATH);
            const [ok, contents] = file.load_contents(null);
            if (!ok)
                return;

            const data = JSON.parse(new TextDecoder().decode(contents));
            if (typeof data.lastReset === 'number')
                this._lastReset = data.lastReset;

            if (Array.isArray(data.entries)) {
                const valid = data.entries.filter(entry =>
                    entry && typeof entry.address === 'string' &&
                    parsePublicAddress(entry.address) === entry.address &&
                    Number.isFinite(entry.firstSeen) &&
                    Number.isFinite(entry.lastSeen));

                // Old versions logged LAN addresses; drop them for good.
                if (valid.length !== data.entries.length)
                    this._markDirty();

                this._history = valid
                    .map(entry => ({
                        address: entry.address,
                        firstSeen: entry.firstSeen,
                        lastSeen: entry.lastSeen,
                    }))
                    .slice(-MAX_HISTORY_ENTRIES);
            }
        } catch (e) {
            // A missing or corrupted history is not fatal: start fresh.
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return;
            log(`ip-history: could not load history: ${e.message}`);
        }
    }

    _saveHistory() {
        const payload = JSON.stringify({
            version: 2,
            lastReset: this._lastReset,
            entries: this._history,
        }, null, 2);

        try {
            GLib.mkdir_with_parents(
                GLib.path_get_dirname(HISTORY_PATH), 0o755);
            if (!GLib.file_set_contents(HISTORY_PATH, payload))
                throw new Error('file_set_contents failed');
            this._dirty = false;
            this._lastSave = Math.floor(Date.now() / 1000);
        } catch (e) {
            log(`ip-history: could not save history: ${e.message}`);
        }
    }

    _markDirty() {
        this._dirty = true;
    }

    _maybeSave() {
        if (!this._dirty)
            return;
        const now = Math.floor(Date.now() / 1000);
        if (now - this._lastSave < SAVE_INTERVAL_SECONDS)
            return;
        this._saveHistory();
    }

    /**
     * Clears the log when the most recent 03:00 boundary has been crossed,
     * even if the PC was suspended or switched off at the time.
     */
    _applyDailyReset() {
        const boundary = latestResetBoundary();
        if (this._lastReset >= boundary)
            return false;

        this._history = [];
        this._lastReset = boundary;
        this._markDirty();
        return true;
    }

    _scheduleReset() {
        if (this._resetTimeoutId)
            return;

        const seconds = Math.max(1,
            nextResetBoundary() - Math.floor(Date.now() / 1000));
        this._resetTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, seconds, () => {
                this._resetTimeoutId = 0;
                this._onDailyReset();
                return GLib.SOURCE_REMOVE;
            });
    }

    _onDailyReset() {
        if (this._applyDailyReset()) {
            this._saveHistory();
            this._recordPublicIp();
            this._refreshLabels();
            this._refreshHistory();
        }
        this._scheduleReset();
    }

    _scheduleCheck(seconds) {
        if (this._checkTimeoutId) {
            GLib.source_remove(this._checkTimeoutId);
            this._checkTimeoutId = 0;
        }
        if (this._stopped)
            return;

        this._checkTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, Math.max(1, seconds), () => {
                this._checkTimeoutId = 0;
                this._fetchPublicIp();
                return GLib.SOURCE_REMOVE;
            });
    }

    start() {
        if (this._checkTimeoutId || this._fetchInFlight)
            return;

        this._stopped = false;
        this._fixLabelWidth();
        this._applyDailyReset();
        this._refreshLabels();
        this._scheduleReset();

        // React to a Wi-Fi drop/reconnect immediately instead of waiting for
        // the next poll, so "No internet" appears right away.
        this._networkMonitorId = Gio.NetworkMonitor.get_default()
            .connect('network-changed', () => this._fetchPublicIp());

        this._fetchPublicIp();
    }

    stop() {
        this._stopped = true;
        this._fetchInFlight = false;
        this._geoInfo = null;
        this._geoIp = null;

        if (this._networkMonitorId) {
            Gio.NetworkMonitor.get_default()
                .disconnect(this._networkMonitorId);
            this._networkMonitorId = 0;
        }

        if (this._checkTimeoutId) {
            GLib.source_remove(this._checkTimeoutId);
            this._checkTimeoutId = 0;
        }
        if (this._resetTimeoutId) {
            GLib.source_remove(this._resetTimeoutId);
            this._resetTimeoutId = 0;
        }
        if (this._dirty)
            this._saveHistory();
    }

    /**
     * Reserves the width of the widest common IPv4 text so the panel does not
     * reflow when the address changes.
     */
    _fixLabelWidth() {
        const text = this._panelLabel.text;
        this._panelLabel.set_text('IP 255.255.255.255');
        const [, natural] = this._panelLabel.get_preferred_width(-1);
        this._panelLabel.set_style(`min-width: ${Math.ceil(natural)}px;`);
        this._panelLabel.set_text(text);
    }

    _fetchPublicIp() {
        if (this._stopped || this._fetchInFlight)
            return;

        this._fetchInFlight = true;
        this._refreshLabels();
        this._tryEndpoint(0);
    }

    _tryEndpoint(index) {
        if (this._stopped)
            return;

        if (index >= PUBLIC_IP_ENDPOINTS.length) {
            this._fetchInFlight = false;
        this._geoInfo = null;
        this._geoIp = null;
            this._onFetchFailed();
            return;
        }

        const [url, forceIPv4] = PUBLIC_IP_ENDPOINTS[index];
        const argv = [
            'curl', '--silent', '--show-error', '--fail', '--location',
            '--max-time', `${REQUEST_TIMEOUT_SECONDS}`,
            '--user-agent', 'ip-history@drmj',
        ];
        if (forceIPv4)
            argv.push('--ipv4');
        argv.push(url);

        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            if (!loggedReadFailures.has('curl')) {
                loggedReadFailures.add('curl');
                log(`ip-history: failed to run curl: ${e.message}`);
            }
            this._tryEndpoint(PUBLIC_IP_ENDPOINTS.length);
            return;
        }

        proc.communicate_utf8_async(null, null, (subprocess, result) => {
            if (this._stopped)
                return;

            let output = null;
            try {
                const [, stdout] = subprocess.communicate_utf8_finish(result);
                if (subprocess.get_successful())
                    output = stdout;
            } catch (e) {
                // Try the next service.
            }

            const address = parsePublicAddress(output);
            if (address)
                this._setPublicIp(address);
            else
                this._tryEndpoint(index + 1);
        });
    }

    _onFetchFailed() {
        if (this._stopped)
            return;

        this._online = false;
        this._refreshLabels();
        this._refreshHistory();
        this._scheduleCheck(RETRY_INTERVAL_SECONDS);
    }

    _setPublicIp(address) {
        if (this._stopped)
            return;

        this._fetchInFlight = false;
        this._geoInfo = null;
        this._geoIp = null;
        this._online = true;
        this._lastChecked = Math.floor(Date.now() / 1000);
        this._publicIp = address;

        this._recordPublicIp();
        this._maybeSave();
        this._refreshLabels();
        this._refreshHistory();
        this._scheduleCheck(CHECK_INTERVAL_SECONDS);

        if (this._geoIp !== address)
            this._fetchGeoInfo(address);
    }

    _fetchGeoInfo(address) {
        if (this._stopped)
            return;

        const argv = [
            'curl', '--silent', '--show-error', '--fail', '--location',
            '--max-time', `${REQUEST_TIMEOUT_SECONDS}`,
            '--user-agent', 'ip-history@drmj',
            `https://ipinfo.io/${encodeURIComponent(address)}/json`,
        ];

        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            return;
        }

        proc.communicate_utf8_async(null, null, (subprocess, result) => {
            if (this._stopped || this._publicIp !== address)
                return;

            try {
                const [, stdout] = subprocess.communicate_utf8_finish(result);
                if (!subprocess.get_successful() || !stdout)
                    return;

                const data = JSON.parse(stdout);
                const org = typeof data.org === 'string'
                    ? data.org.replace(/^AS\d+\s+/, '').trim()
                    : '';
                const parts = [data.country, data.city, org]
                    .filter(part => typeof part === 'string' && part.trim().length > 0);
                if (parts.length > 0) {
                    this._geoInfo = parts.join(' · ');
                    this._geoIp = address;
                    this._refreshLabels();
                }
            } catch (e) {
                // Geo metadata is optional; ignore parse/network errors.
            }
        });
    }

    /**
     * Appends or extends the history entry for the public address.
     */
    _recordPublicIp() {
        if (!this._publicIp || !this._online)
            return;

        const now = Math.floor(Date.now() / 1000);
        const last = this._history[this._history.length - 1];

        if (last && last.address === this._publicIp) {
            if (last.lastSeen !== now) {
                last.lastSeen = now;
                this._markDirty();
            }
            return;
        }

        this._history.push({
            address: this._publicIp,
            firstSeen: now,
            lastSeen: now,
        });

        if (this._history.length > MAX_HISTORY_ENTRIES)
            this._history.splice(0, this._history.length - MAX_HISTORY_ENTRIES);

        this._markDirty();
        this._saveHistory();
        this._refreshHistory();
    }

    _refreshLabels() {
        const address = this._publicIp;
        const online = this._online && Boolean(address);
        // Before the first lookup finishes there is no "offline" verdict yet.
        const checking = this._fetchInFlight && !this._lastChecked;

        this._panelLabel.set_text(online
            ? `IP ${address}`
            : checking ? 'IP —' : 'No internet');
        this.accessible_name = online
            ? `Public IP address ${address}`
            : checking ? 'Looking up public IP address' : 'No internet';

        this._copyItem.visible = online;

        if (!this.menu.isOpen)
            return;

        if (online) {
            this._currentValue.text = address;
            const geo = this._geoIp === address && this._geoInfo
                ? `${this._geoInfo} · `
                : '';
            const checked = this._lastChecked
                ? `checked ${formatClock(this._lastChecked)}`
                : 'Public IP';
            this._currentInfo.text = `${geo}${checked}`;
        } else {
            this._currentValue.text = checking ? 'Checking…' : 'No internet';
            this._currentInfo.text = checking
                ? 'Looking up your public IP address'
                : 'No internet connection — retrying every minute';
        }
    }

    _refreshHistory() {
        if (!this._historySection)
            return;

        this._historySection.removeAll();

        const header = new PopupMenu.PopupMenuItem(
            `Log since ${formatClock(this._lastReset || latestResetBoundary())}`, {
                reactive: false,
            });
        header.setOrnament(PopupMenu.Ornament.HIDDEN);
        header.label.add_style_class_name('ip-section-header');
        this._historySection.addMenuItem(header);

        if (this._history.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('No addresses recorded yet', {
                reactive: false,
            });
            empty.setOrnament(PopupMenu.Ornament.HIDDEN);
            empty.label.add_style_class_name('ip-empty');
            this._historySection.addMenuItem(empty);
            return;
        }

        const now = Math.floor(Date.now() / 1000);

        for (const entry of this._history) {
            const active = this._online &&
                entry === this._history[this._history.length - 1] &&
                entry.address === this._publicIp;
            const lastSeen = active ? now : entry.lastSeen;
            const duration = formatDuration(lastSeen - entry.firstSeen);

            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                activate: false,
                hover: false,
                can_focus: false,
                style_class: 'ip-history-row',
            });
            item.setOrnament(PopupMenu.Ornament.HIDDEN);

            const box = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'ip-history-box',
            });

            const top = new St.BoxLayout({
                x_expand: true,
                style_class: 'ip-history-top',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const address = new St.Label({
                text: entry.address,
                style_class: 'ip-address-name',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const time = new St.Label({
                text: active
                    ? `${formatClock(entry.firstSeen)} → now`
                    : `${formatClock(entry.firstSeen)} → ${formatClock(entry.lastSeen)}`,
                style_class: 'ip-address-time',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });

            top.add_child(address);
            top.add_child(time);

            const info = new St.Label({
                text: duration,
                style_class: 'ip-address-info',
                x_expand: true,
            });

            box.add_child(top);
            box.add_child(info);
            item.add_child(box);
            this._historySection.addMenuItem(item);
        }
    }
});

function latestResetBoundary(nowMs = Date.now()) {
    const now = new Date(nowMs);
    const boundary = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
        RESET_HOUR, 0, 0, 0);
    if (boundary.getTime() > nowMs)
        boundary.setDate(boundary.getDate() - 1);
    return Math.floor(boundary.getTime() / 1000);
}

function nextResetBoundary(nowMs = Date.now()) {
    const now = new Date(nowMs);
    const boundary = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
        RESET_HOUR, 0, 0, 0);
    if (boundary.getTime() <= nowMs)
        boundary.setDate(boundary.getDate() + 1);
    return Math.floor(boundary.getTime() / 1000);
}

export default class IpHistoryExtension extends Extension {
    enable() {
        this._indicator = new IpIndicator();
        // Center group, immediately left of the clock.
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'center');
        this._keepLeftOfClock();
        this._indicator.start();

        // The shell rebuilds the center group on lock/unlock and user switches;
        // put the applet back on the left of the clock if that moves it.
        this._sessionModeUpdatedId = Main.sessionMode.connect('updated', () => {
            this._keepLeftOfClock();
        });
    }

    _keepLeftOfClock() {
        const container = this._indicator?.container;
        const clock = Main.panel.statusArea.dateMenu?.container;
        const box = clock?.get_parent();
        if (!container || !box)
            return;

        const children = box.get_children();
        const clockIndex = children.indexOf(clock);
        const selfIndex = children.indexOf(container);

        if (clockIndex < 0 || selfIndex === clockIndex - 1)
            return;

        // Already somewhere to the left of the clock: leave it alone.
        if (selfIndex >= 0 && selfIndex < clockIndex)
            return;

        container.get_parent()?.remove_child(container);
        box.insert_child_at_index(container, box.get_children().indexOf(clock));
        container.show();
    }

    disable() {
        if (this._sessionModeUpdatedId) {
            Main.sessionMode.disconnect(this._sessionModeUpdatedId);
            this._sessionModeUpdatedId = 0;
        }

        if (!this._indicator)
            return;

        this._indicator.stop();
        this._indicator.destroy();
        this._indicator = null;
    }
}
