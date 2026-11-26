/* Pure validation, formatting, and schedule helpers for ip-history@drmj.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';

export function formatClock(unixSeconds) {
    const date = GLib.DateTime.new_from_unix_local(unixSeconds);
    return date ? date.format('%H:%M') : '—';
}

export function formatDuration(seconds) {
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

export function isPublicIPv4(address) {
    const parts = address.split('.');
    if (parts.length !== 4)
        return false;

    const octets = parts.map(part => /^\d{1,3}$/.test(part)
        ? Number.parseInt(part, 10) : NaN);
    if (octets.some(value => !Number.isInteger(value) || value < 0 || value > 255))
        return false;

    const [a, b, c] = octets;

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
    if (a === 192 && b === 88 && c === 99) // 6to4 relay anycast (deprecated)
        return false;
    if (a === 198 && (b === 18 || b === 19)) // benchmarking
        return false;
    if (a === 198 && b === 51 && c === 100) // TEST-NET-2
        return false;
    if (a === 203 && b === 0 && c === 113) // TEST-NET-3
        return false;
    if (a >= 224) // multicast and reserved
        return false;

    return true;
}

export function isPublicIPv6(address) {
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
export function parsePublicAddress(text) {
    if (!text)
        return null;

    // Some services append a newline or wrap the address in brackets.
    const value = text.trim().split(/\s+/)[0]
        .replace(/^\[/, '').replace(/\]$/, '');

    if (isPublicIPv4(value) || isPublicIPv6(value))
        return value;

    return null;
}

/**
 * Masks most digits of an IP address for screen sharing, keeping only the
 * trailing segment visible so changes remain noticeable.
 *
 * @param {string} address IPv4 or IPv6 address
 * @returns {string}
 */
export function maskIpAddress(address) {
    if (!address)
        return '—';
    if (address.includes('.')) {
        const parts = address.split('.');
        if (parts.length === 4)
            return `•••.•••.•••.${parts[3]}`;
    }
    if (address.includes(':')) {
        const parts = address.split(':').filter(p => p.length > 0);
        const tail = parts[parts.length - 1] ?? '';
        return `••••:…:${tail}`;
    }
    return '•••';
}

/**
 * Converts a 2-letter ISO 3166-1 alpha-2 country code (e.g. "US") to its
 * regional indicator flag emoji ("🇺🇸"). Returns '' for invalid input.
 *
 * @param {string} code
 * @returns {string}
 */
export function countryCodeToFlag(code) {
    if (typeof code !== 'string')
        return '';
    const upper = code.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(upper))
        return '';
    const base = 0x1F1E6;
    return String.fromCodePoint(
        base + upper.charCodeAt(0) - 65,
        base + upper.charCodeAt(1) - 65);
}

/**
 * Returns true if the network interface name looks like a VPN tunnel.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isVpnInterfaceName(name) {
    return /^(tun|tap|wg|tailscale|proton|mullvad|nordlynx|utun)\d*/i.test(name);
}

export function latestResetBoundary(nowMs = Date.now(), resetHour = 3) {
    const now = new Date(nowMs);
    const boundary = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
        resetHour, 0, 0, 0);
    if (boundary.getTime() > nowMs)
        boundary.setDate(boundary.getDate() - 1);
    return Math.floor(boundary.getTime() / 1000);
}

export function nextResetBoundary(nowMs = Date.now(), resetHour = 3) {
    const now = new Date(nowMs);
    const boundary = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
        resetHour, 0, 0, 0);
    if (boundary.getTime() <= nowMs)
        boundary.setDate(boundary.getDate() + 1);
    return Math.floor(boundary.getTime() / 1000);
}

export function formatFooterText(checkIntervalSeconds, resetHour) {
    const intervalText = checkIntervalSeconds % 60 === 0
        ? `${checkIntervalSeconds / 60} min`
        : `${checkIntervalSeconds} s`;
    const hourText = `${String(resetHour).padStart(2, '0')}:00`;
    return `Checked every ${intervalText} · log resets daily at ${hourText}`;
}
