/* ip-history@drmj
 *
 * Shows the current public IP address in the GNOME top panel, immediately
 * left of the clock, and keeps a daily log of the public addresses this PC
 * has used. The log is cleared automatically every day at the configured hour.
 *
 * The public address is looked up over HTTPS via libsoup3 (ipify, icanhazip,
 * ifconfig.me). Private/link-local/loopback/reserved addresses are never shown
 * or logged, even if a lookup service misbehaves.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    formatClock,
    formatDuration,
    parsePublicAddress,
    maskIpAddress,
    countryCodeToFlag,
    isVpnInterfaceName,
    latestResetBoundary,
    nextResetBoundary,
    formatFooterText,
} from './utils.js';

const DEFAULT_CHECK_INTERVAL_SECONDS = 300;
const RETRY_INTERVAL_SECONDS = 60;
const NETWORK_DEBOUNCE_SECONDS = 2;
const REQUEST_TIMEOUT_SECONDS = 10;
const DEFAULT_RESET_HOUR = 3;
// Never keep more than this many entries in one day's log.
const MAX_HISTORY_ENTRIES = 200;
// Throttle disk writes while the active entry's "last seen" time ticks up.
const SAVE_INTERVAL_SECONDS = 60;

// HTTPS is mandatory: an on-path attacker must not be able to feed us a bogus address.
const PUBLIC_IP_ENDPOINTS = [
    'https://api.ipify.org',
    'https://ipv4.icanhazip.com',
    'https://ifconfig.me/ip',
];

const HISTORY_PATH = GLib.build_filenamev(
    [GLib.get_user_data_dir(), 'ip-history@drmj', 'history.json']);
const PROC_NET_DEV_FILE = Gio.File.new_for_path('/proc/net/dev');
const TEXT_DECODER = new TextDecoder();

/**
 * Checks /proc/net/dev for any active VPN tunnel interface.
 *
 * @returns {boolean}
 */
function detectVpnActive() {
    try {
        const [ok, contents] = PROC_NET_DEV_FILE.load_contents(null);
        if (!ok)
            return false;
        const text = TEXT_DECODER.decode(contents);
        for (const line of text.split('\n')) {
            const match = line.match(/^\s*([^:\s]+):/);
            if (match && isVpnInterfaceName(match[1]))
                return true;
        }
    } catch (e) {
        // Non-fatal
    }
    return false;
}

const IpIndicator = GObject.registerClass(
class IpIndicator extends PanelMenu.Button {
    _init(settings, openPreferences) {
        super._init(0.5, 'IP Address');
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._settingsChangedIds = [];
        this.menu.box.add_style_class_name('ip-menu');

        this._checkTimeoutId = 0;
        this._resetTimeoutId = 0;
        this._debounceTimeoutId = 0;
        this._networkMonitorId = 0;
        this._lastSave = 0;
        this._dirty = false;
        this._fetchInFlight = false;
        this._cancellable = null;
        this._geoCancellable = null;
        this._geoInfo = null;
        this._geoCountry = '';
        this._geoIp = null;
        this._vpnActive = false;
        this._stopped = false;

        this._publicIp = null;
        this._online = false;
        this._lastChecked = 0;
        this._lastReset = 0;
        this._history = [];

        this._httpSession = new Soup.Session({
            timeout: REQUEST_TIMEOUT_SECONDS,
            user_agent: 'ip-history@drmj',
        });

        this._loadHistory();

        const box = new St.BoxLayout({
            style_class: 'ip-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._vpnIcon = new St.Icon({
            icon_name: 'network-vpn-symbolic',
            icon_size: 13,
            style_class: 'ip-vpn-icon',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._vpnIcon);

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
            this._vpnActive = detectVpnActive();
            this._refreshLabels();
            this._refreshHistory();
        });
    }

    _getCheckInterval() {
        return this._settings?.get_int('check-interval') ?? DEFAULT_CHECK_INTERVAL_SECONDS;
    }

    _getResetHour() {
        return this._settings?.get_int('reset-hour') ?? DEFAULT_RESET_HOUR;
    }

    _isGeoEnabled() {
        return this._settings?.get_boolean('enable-geo') ?? true;
    }

    _isFlagShown() {
        return this._settings?.get_boolean('show-flag') ?? true;
    }

    _isMaskEnabled() {
        return this._settings?.get_boolean('mask-ip') ?? false;
    }

    _isVpnIconEnabled() {
        return this._settings?.get_boolean('show-vpn-icon') ?? true;
    }

    _isNotifyEnabled() {
        return this._settings?.get_boolean('notify-on-change') ?? true;
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
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD, this._publicIp);
        });
        this.menu.addMenuItem(this._copyItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Check now');
        refreshItem.setOrnament(PopupMenu.Ornament.HIDDEN);
        refreshItem.connect('activate', () => this._fetchPublicIp(true));
        this.menu.addMenuItem(refreshItem);

        this._maskSwitch = new PopupMenu.PopupSwitchMenuItem(
            'Mask IP in panel', this._isMaskEnabled());
        this._maskSwitch.connect('toggled', (_item, state) => {
            if (this._settings)
                this._settings.set_boolean('mask-ip', state);
        });
        this.menu.addMenuItem(this._maskSwitch);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._historyHeader = new PopupMenu.PopupMenuItem('Log', {
            reactive: false,
        });
        this._historyHeader.setOrnament(PopupMenu.Ornament.HIDDEN);
        this._historyHeader.label.add_style_class_name('ip-section-header');
        this.menu.addMenuItem(this._historyHeader);

        this._historyScroll = new St.ScrollView({
            style_class: 'ip-history-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._historySection = new PopupMenu.PopupMenuSection();
        this._historyScroll.add_child(this._historySection.actor);
        this.menu.box.add_child(this._historyScroll);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const clearItem = new PopupMenu.PopupMenuItem('Clear log now');
        clearItem.setOrnament(PopupMenu.Ornament.HIDDEN);
        clearItem.connect('activate', () => {
            this._history = [];
            this._lastReset = latestResetBoundary(Date.now(), this._getResetHour());
            this._markDirty();
            this._saveHistory();
            this._recordPublicIp();
            this._refreshHistory();
        });
        this.menu.addMenuItem(clearItem);

        if (this._openPreferences) {
            const prefsItem = new PopupMenu.PopupMenuItem('Preferences');
            prefsItem.setOrnament(PopupMenu.Ornament.HIDDEN);
            prefsItem.connect('activate', () => this._openPreferences());
            this.menu.addMenuItem(prefsItem);
        }

        this._footerItem = new PopupMenu.PopupMenuItem(
            formatFooterText(this._getCheckInterval(), this._getResetHour()),
            {reactive: false});
        this._footerItem.setOrnament(PopupMenu.Ornament.HIDDEN);
        this._footerItem.label.add_style_class_name('ip-menu-footer');
        this.menu.addMenuItem(this._footerItem);
    }

    _connectSettings() {
        if (!this._settings || this._settingsChangedIds.length > 0)
            return;

        this._settingsChangedIds.push(
            this._settings.connect('changed::mask-ip', () => {
                this._maskSwitch.setToggleState(this._isMaskEnabled());
                this._refreshLabels();
            }),
            this._settings.connect('changed::show-flag', () => this._refreshLabels()),
            this._settings.connect('changed::show-vpn-icon', () => this._refreshLabels()),
            this._settings.connect('changed::enable-geo', () => {
                if (!this._isGeoEnabled()) {
                    this._geoInfo = null;
                    this._geoCountry = '';
                    this._geoIp = null;
                } else if (this._online && this._publicIp && this._geoIp !== this._publicIp) {
                    this._fetchGeoInfo(this._publicIp);
                }
                this._refreshLabels();
            }),
            this._settings.connect('changed::check-interval', () => {
                this._updateFooter();
                if (!this._stopped && !this._fetchInFlight)
                    this._scheduleCheck(this._getCheckInterval());
            }),
            this._settings.connect('changed::reset-hour', () => {
                this._updateFooter();
                this._rescheduleReset();
                this._refreshHistory();
            })
        );
    }

    _disconnectSettings() {
        for (const id of this._settingsChangedIds)
            this._settings?.disconnect(id);
        this._settingsChangedIds = [];
    }

    _updateFooter() {
        this._footerItem.label.text =
            formatFooterText(this._getCheckInterval(), this._getResetHour());
    }

    _loadHistory() {
        try {
            const file = Gio.File.new_for_path(HISTORY_PATH);
            const [ok, contents] = file.load_contents(null);
            if (!ok)
                return;

            const data = JSON.parse(TEXT_DECODER.decode(contents));
            if (typeof data.lastReset === 'number')
                this._lastReset = data.lastReset;

            if (Array.isArray(data.entries)) {
                const valid = data.entries.filter(entry =>
                    entry && typeof entry.address === 'string' &&
                    parsePublicAddress(entry.address) === entry.address &&
                    Number.isFinite(entry.firstSeen) &&
                    Number.isFinite(entry.lastSeen));

                if (valid.length !== data.entries.length)
                    this._markDirty();

                this._history = valid
                    .map(entry => ({
                        address: entry.address,
                        firstSeen: entry.firstSeen,
                        lastSeen: entry.lastSeen,
                        vpn: Boolean(entry.vpn),
                    }))
                    .slice(-MAX_HISTORY_ENTRIES);
            }
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return;
            log(`ip-history: could not load history: ${e.message}`);
        }
    }

    _saveHistory() {
        const payload = JSON.stringify({
            version: 3,
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
     * Clears the log when the most recent reset boundary has been crossed,
     * even if the PC was suspended or switched off at the time.
     */
    _applyDailyReset() {
        const boundary = latestResetBoundary(Date.now(), this._getResetHour());
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

        const nextBoundary = nextResetBoundary(Date.now(), this._getResetHour());
        const seconds = Math.max(1, nextBoundary - Math.floor(Date.now() / 1000));
        this._resetTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, seconds, () => {
                this._resetTimeoutId = 0;
                this._onDailyReset();
                return GLib.SOURCE_REMOVE;
            });
    }

    _rescheduleReset() {
        if (this._resetTimeoutId) {
            GLib.source_remove(this._resetTimeoutId);
            this._resetTimeoutId = 0;
        }
        if (!this._stopped)
            this._scheduleReset();
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

    _onNetworkChanged() {
        if (this._stopped)
            return;
        this._vpnActive = detectVpnActive();
        this._refreshLabels();

        if (this._debounceTimeoutId)
            GLib.source_remove(this._debounceTimeoutId);

        this._debounceTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, NETWORK_DEBOUNCE_SECONDS, () => {
                this._debounceTimeoutId = 0;
                this._fetchPublicIp();
                return GLib.SOURCE_REMOVE;
            });
    }

    start() {
        this._connectSettings();
        if (this._checkTimeoutId || this._fetchInFlight)
            return;

        this._stopped = false;
        this._vpnActive = detectVpnActive();
        this._fixLabelWidth();
        this._applyDailyReset();
        this._updateFooter();
        this._refreshLabels();
        this._scheduleReset();

        this._networkMonitorId = Gio.NetworkMonitor.get_default()
            .connect('network-changed', () => this._onNetworkChanged());

        this._fetchPublicIp();
    }

    _cancelActiveRequests() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._geoCancellable) {
            this._geoCancellable.cancel();
            this._geoCancellable = null;
        }
    }

    stop() {
        this._stopped = true;
        this._fetchInFlight = false;
        this._cancelActiveRequests();
        this._httpSession?.abort();
        this._disconnectSettings();

        if (this._networkMonitorId) {
            Gio.NetworkMonitor.get_default()
                .disconnect(this._networkMonitorId);
            this._networkMonitorId = 0;
        }

        if (this._debounceTimeoutId) {
            GLib.source_remove(this._debounceTimeoutId);
            this._debounceTimeoutId = 0;
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

    destroy() {
        this.stop();
        super.destroy();
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

    _fetchPublicIp(force = false) {
        if (this._stopped)
            return;
        if (this._fetchInFlight) {
            if (!force)
                return;
            this._cancellable?.cancel();
            this._cancellable = null;
        }

        this._fetchInFlight = true;
        this._cancellable = new Gio.Cancellable();
        this._refreshLabels();
        this._tryEndpoint(0, this._cancellable);
    }

    _tryEndpoint(index, cancellable) {
        if (this._stopped || cancellable.is_cancelled())
            return;

        if (index >= PUBLIC_IP_ENDPOINTS.length) {
            this._fetchInFlight = false;
            this._cancellable = null;
            this._onFetchFailed();
            return;
        }

        const url = PUBLIC_IP_ENDPOINTS[index];
        const message = Soup.Message.new('GET', url);
        if (!message) {
            this._tryEndpoint(index + 1, cancellable);
            return;
        }

        this._httpSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (session, result) => {
                if (this._stopped || cancellable.is_cancelled())
                    return;

                let output = null;
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (message.status_code === Soup.Status.OK && bytes)
                        output = TEXT_DECODER.decode(bytes.get_data());
                } catch (e) {
                    // Try the next service.
                }

                const address = parsePublicAddress(output);
                if (address)
                    this._setPublicIp(address);
                else
                    this._tryEndpoint(index + 1, cancellable);
            });
    }

    _onFetchFailed() {
        if (this._stopped)
            return;

        this._online = false;
        this._vpnActive = detectVpnActive();
        this._refreshLabels();
        this._refreshHistory();
        this._scheduleCheck(RETRY_INTERVAL_SECONDS);
    }

    _setPublicIp(address) {
        if (this._stopped)
            return;

        const previousIp = this._publicIp;
        const ipChanged = Boolean(previousIp && previousIp !== address);

        this._fetchInFlight = false;
        this._cancellable = null;
        this._online = true;
        this._vpnActive = detectVpnActive();
        this._lastChecked = Math.floor(Date.now() / 1000);
        this._publicIp = address;

        if (ipChanged) {
            this._geoInfo = null;
            this._geoCountry = '';
            this._geoIp = null;

            if (this._isNotifyEnabled()) {
                Main.notify(
                    'Public IP changed',
                    `${previousIp} → ${address}`);
            }
        }

        this._recordPublicIp();
        this._maybeSave();
        this._refreshLabels();
        this._refreshHistory();
        this._scheduleCheck(this._getCheckInterval());

        if (this._isGeoEnabled() && this._geoIp !== address)
            this._fetchGeoInfo(address);
    }

    _fetchGeoInfo(address) {
        if (this._stopped)
            return;

        this._geoCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._geoCancellable = cancellable;

        const url = `https://ipinfo.io/${encodeURIComponent(address)}/json`;
        const message = Soup.Message.new('GET', url);
        if (!message)
            return;

        this._httpSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (session, result) => {
                if (this._stopped || cancellable.is_cancelled() || this._publicIp !== address)
                    return;

                try {
                    const bytes = session.send_and_read_finish(result);
                    if (message.status_code !== Soup.Status.OK || !bytes)
                        return;

                    const data = JSON.parse(TEXT_DECODER.decode(bytes.get_data()));
                    const org = typeof data.org === 'string'
                        ? data.org.replace(/^AS\d+\s+/, '').trim()
                        : '';
                    const parts = [data.country, data.city, org]
                        .filter(part => typeof part === 'string' && part.trim().length > 0);
                    if (parts.length > 0) {
                        this._geoInfo = parts.join(' · ');
                        this._geoCountry = typeof data.country === 'string' ? data.country.trim() : '';
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
            if (last.lastSeen !== now || last.vpn !== this._vpnActive) {
                last.lastSeen = now;
                last.vpn = this._vpnActive;
                this._markDirty();
            }
            return;
        }

        this._history.push({
            address: this._publicIp,
            firstSeen: now,
            lastSeen: now,
            vpn: this._vpnActive,
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

        this._vpnIcon.visible = this._vpnActive && this._isVpnIconEnabled();

        const flag = online && this._isFlagShown() && this._geoIp === address
            ? countryCodeToFlag(this._geoCountry)
            : '';
        const flagPrefix = flag ? `${flag} ` : '';
        const panelAddress = online
            ? (this._isMaskEnabled() ? maskIpAddress(address) : address)
            : '';

        this._panelLabel.set_text(online
            ? `${flagPrefix}IP ${panelAddress}`
            : checking ? 'IP —' : 'No internet');

        const now = Math.floor(Date.now() / 1000);
        const stale = online && this._lastChecked > 0 &&
            (now - this._lastChecked) > this._getCheckInterval() * 2;
        if (stale)
            this._panelLabel.add_style_class_name('ip-panel-stale');
        else
            this._panelLabel.remove_style_class_name('ip-panel-stale');

        this.accessible_name = online
            ? `Public IP address ${this._isMaskEnabled() ? 'masked' : address}`
            : checking ? 'Looking up public IP address' : 'No internet';

        this._copyItem.visible = online;

        if (!this.menu.isOpen)
            return;

        if (online) {
            this._currentValue.text = flag ? `${flag} ${address}` : address;
            const geo = this._geoIp === address && this._geoInfo
                ? `${this._geoInfo} · `
                : '';
            const vpnText = this._vpnActive ? 'VPN · ' : '';
            const checked = this._lastChecked
                ? `checked ${formatClock(this._lastChecked)}`
                : 'Public IP';
            this._currentInfo.text = `${vpnText}${geo}${checked}`;
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

        const resetTime = this._lastReset ||
            latestResetBoundary(Date.now(), this._getResetHour());
        this._historyHeader.label.text = `Log since ${formatClock(resetTime)}`;

        this._historySection.removeAll();

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

        // Show newest first so recent IPs are immediately visible.
        for (let i = this._history.length - 1; i >= 0; i--) {
            const entry = this._history[i];
            const active = this._online &&
                i === this._history.length - 1 &&
                entry.address === this._publicIp;
            const lastSeen = active ? now : entry.lastSeen;
            const duration = formatDuration(lastSeen - entry.firstSeen);

            const item = new PopupMenu.PopupBaseMenuItem({
                style_class: 'ip-history-row',
            });
            item.setOrnament(PopupMenu.Ornament.HIDDEN);
            item.connect('activate', () => {
                St.Clipboard.get_default().set_text(
                    St.ClipboardType.CLIPBOARD, entry.address);
            });

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

            const infoText = entry.vpn ? `${duration} · VPN` : duration;
            const info = new St.Label({
                text: infoText,
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

export default class IpHistoryExtension extends Extension {
    enable() {
        this._indicator = new IpIndicator(
            this.getSettings(),
            () => this.openPreferences());
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
