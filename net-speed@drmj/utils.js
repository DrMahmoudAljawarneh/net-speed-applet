/* Pure formatting and filtering helpers for net-speed@drmj.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export const BIT_UNITS = ['bit', 'Kbit', 'Mbit', 'Gbit', 'Tbit'];

/**
 * Formats a byte count (or rate) with a sensible number of decimals.
 *
 * @param {number} value value in bytes
 * @param {string[]} units unit names, starting at bytes
 * @returns {string} e.g. "12.34 MB" or "0 B"
 */
export function formatMagnitude(value, units) {
    if (!Number.isFinite(value) || value < 1)
        return `0 ${units[0]}`;

    let scaled = value;
    let index = 0;
    // 999.5 rather than 1000 so rounding below cannot print "1000 KB".
    while (scaled >= 999.5 && index < units.length - 1) {
        scaled /= 1000;
        index++;
    }

    const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    return `${scaled.toFixed(decimals)} ${units[index]}`;
}

export function formatSpeed(bytesPerSecond) {
    return `${formatMagnitude(bytesPerSecond, BYTE_UNITS)}/s`;
}

export function formatBitrate(bytesPerSecond) {
    return `${formatMagnitude(bytesPerSecond * 8, BIT_UNITS)}/s`;
}

export function formatValue(value) {
    const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return value.toFixed(decimals);
}

/**
 * Panel rates stay in KB/s and MB/s (never B/s or GB/s), which keeps the
 * readout compact and predictable.
 */
export function formatKbMbSpeed(bytesPerSecond) {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0)
        return '0.00 KB/s';
    // 999.5 KB rounds to 1000, so switch to MB before that.
    if (bytesPerSecond >= 999_500)
        return `${formatValue(bytesPerSecond / 1_000_000)} MB/s`;
    return `${formatValue(bytesPerSecond / 1000)} KB/s`;
}

export function formatKbpsMbpsSpeed(bytesPerSecond) {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0)
        return '0.00 Kbps';
    const bitsPerSecond = bytesPerSecond * 8;
    if (bitsPerSecond >= 999_500)
        return `${formatValue(bitsPerSecond / 1_000_000)} Mbps`;
    return `${formatValue(bitsPerSecond / 1000)} Kbps`;
}

export function formatPanelSpeed(bytesPerSecond, speedUnit) {
    return speedUnit === 'bits'
        ? formatKbpsMbpsSpeed(bytesPerSecond)
        : formatKbMbSpeed(bytesPerSecond);
}

/**
 * Parses a comma-separated list of interface names or '*' wildcard patterns
 * into compiled RegExps.
 *
 * @param {string} raw e.g. "docker0, veth*, virbr*"
 * @returns {RegExp[]}
 */
export function parseIgnoredPatterns(raw) {
    if (typeof raw !== 'string' || raw.trim().length === 0)
        return [];

    return raw.split(',')
        .map(part => part.trim())
        .filter(part => part.length > 0)
        .map(pattern => {
            const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*');
            return new RegExp(`^${escaped}$`);
        });
}

/**
 * Returns true if an interface name matches any compiled ignore pattern.
 *
 * @param {string} name interface name
 * @param {RegExp[]} patterns compiled patterns from parseIgnoredPatterns
 * @returns {boolean}
 */
export function isInterfaceIgnored(name, patterns) {
    if (!patterns || patterns.length === 0)
        return false;
    return patterns.some(re => re.test(name));
}

/**
 * Formats the menu footer string for the given polling interval.
 *
 * @param {number} intervalMs polling interval in milliseconds
 * @returns {string}
 */
export function formatIntervalFooter(intervalMs) {
    const seconds = intervalMs / 1000;
    if (seconds === 1)
        return 'Sampled every second';
    return `Sampled every ${seconds} s`;
}

/**
 * Returns the CSS threshold class for a 0–100 percentage, or '' if normal.
 *
 * @param {number} percent 0–100
 * @returns {string}
 */
export function thresholdClass(percent) {
    if (percent >= 95)
        return 'net-speed-crit';
    if (percent >= 80)
        return 'net-speed-warn';
    return '';
}
