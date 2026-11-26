/* Unit tests for pure helpers in net-speed@drmj and ip-history@drmj.
 * Run with: gjs -m tests/test_utils.js
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {
    BYTE_UNITS,
    formatMagnitude,
    formatSpeed,
    formatBitrate,
    formatPanelSpeed,
    parseIgnoredPatterns,
    isInterfaceIgnored,
    formatIntervalFooter,
    thresholdClass,
} from '../net-speed@drmj/utils.js';

import {
    formatDuration,
    isPublicIPv4,
    isPublicIPv6,
    parsePublicAddress,
    maskIpAddress,
    countryCodeToFlag,
    isVpnInterfaceName,
    latestResetBoundary,
    nextResetBoundary,
    formatFooterText,
} from '../ip-history@drmj/utils.js';

let passed = 0;
let failed = 0;

function assertEq(actual, expected, label) {
    if (actual === expected) {
        passed++;
    } else {
        failed++;
        printerr(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    }
}

// --- net-speed@drmj/utils.js ---

assertEq(formatMagnitude(0, BYTE_UNITS), '0 B', 'magnitude 0');
assertEq(formatMagnitude(512, BYTE_UNITS), '512 B', 'magnitude 512 B');
assertEq(formatMagnitude(999.5, BYTE_UNITS), '1.00 KB', 'magnitude 999.5 rolls to KB');
assertEq(formatMagnitude(12_340, BYTE_UNITS), '12.3 KB', 'magnitude 12.3 KB');
assertEq(formatMagnitude(1_500_000, BYTE_UNITS), '1.50 MB', 'magnitude 1.50 MB');
assertEq(formatSpeed(1000), '1.00 KB/s', 'formatSpeed 1 KB/s');
assertEq(formatBitrate(125_000), '1.00 Mbit/s', 'formatBitrate 1 Mbit/s');

assertEq(formatPanelSpeed(0, 'bytes'), '0.00 KB/s', 'panel bytes 0');
assertEq(formatPanelSpeed(500_000, 'bytes'), '500 KB/s', 'panel bytes 500 KB/s');
assertEq(formatPanelSpeed(999_500, 'bytes'), '1.00 MB/s', 'panel bytes 999.5 KB rolls to MB');
assertEq(formatPanelSpeed(125_000, 'bits'), '1.00 Mbps', 'panel bits 1 Mbps');
assertEq(formatPanelSpeed(0, 'bits'), '0.00 Kbps', 'panel bits 0');

const ignored = parseIgnoredPatterns('docker0, veth*, virbr*');
assertEq(isInterfaceIgnored('docker0', ignored), true, 'ignore exact docker0');
assertEq(isInterfaceIgnored('veth1a2b3c', ignored), true, 'ignore wildcard veth*');
assertEq(isInterfaceIgnored('virbr0-nic', ignored), true, 'ignore wildcard virbr*');
assertEq(isInterfaceIgnored('wlan0', ignored), false, 'keep wlan0');
assertEq(isInterfaceIgnored('eth0', parseIgnoredPatterns('')), false, 'empty ignore list');

assertEq(formatIntervalFooter(1000), 'Sampled every second', 'footer 1s');
assertEq(formatIntervalFooter(500), 'Sampled every 0.5 s', 'footer 0.5s');
assertEq(formatIntervalFooter(2000), 'Sampled every 2 s', 'footer 2s');

assertEq(thresholdClass(0), '', 'threshold 0%');
assertEq(thresholdClass(79), '', 'threshold 79%');
assertEq(thresholdClass(80), 'net-speed-warn', 'threshold 80%');
assertEq(thresholdClass(94), 'net-speed-warn', 'threshold 94%');
assertEq(thresholdClass(95), 'net-speed-crit', 'threshold 95%');
assertEq(thresholdClass(100), 'net-speed-crit', 'threshold 100%');

// --- ip-history@drmj/utils.js ---

assertEq(formatDuration(-1), '—', 'duration negative');
assertEq(formatDuration(30), '<1 min', 'duration <1 min');
assertEq(formatDuration(300), '5 min', 'duration 5 min');
assertEq(formatDuration(3600), '1 h', 'duration 1 h');
assertEq(formatDuration(5400), '1 h 30 min', 'duration 1 h 30 min');

// Public IPv4
assertEq(isPublicIPv4('1.1.1.1'), true, '1.1.1.1 public');
assertEq(isPublicIPv4('8.8.8.8'), true, '8.8.8.8 public');
assertEq(isPublicIPv4('10.0.0.1'), false, 'RFC1918 10/8');
assertEq(isPublicIPv4('127.0.0.1'), false, 'loopback');
assertEq(isPublicIPv4('100.64.0.1'), false, 'CGNAT');
assertEq(isPublicIPv4('169.254.1.1'), false, 'link-local');
assertEq(isPublicIPv4('172.16.0.1'), false, 'RFC1918 172.16/12');
assertEq(isPublicIPv4('192.168.1.1'), false, 'RFC1918 192.168/16');
assertEq(isPublicIPv4('192.0.2.1'), false, 'TEST-NET-1');
assertEq(isPublicIPv4('192.88.99.1'), false, '6to4 relay anycast');
assertEq(isPublicIPv4('198.18.0.1'), false, 'benchmarking');
assertEq(isPublicIPv4('198.51.100.1'), false, 'TEST-NET-2');
assertEq(isPublicIPv4('203.0.113.42'), false, 'TEST-NET-3');
assertEq(isPublicIPv4('224.0.0.1'), false, 'multicast');
assertEq(isPublicIPv4('999.1.1.1'), false, 'invalid octet');

// Public IPv6
assertEq(isPublicIPv6('2606:4700:4700::1111'), true, 'Cloudflare IPv6 public');
assertEq(isPublicIPv6('::1'), false, 'IPv6 loopback');
assertEq(isPublicIPv6('fe80::1'), false, 'IPv6 link-local');
assertEq(isPublicIPv6('fc00::1'), false, 'IPv6 ULA fc');
assertEq(isPublicIPv6('fd12:3456::1'), false, 'IPv6 ULA fd');
assertEq(isPublicIPv6('ff02::1'), false, 'IPv6 multicast');

assertEq(parsePublicAddress('  [1.1.1.1]\n'), '1.1.1.1', 'parsePublicAddress trims & strips brackets');
assertEq(parsePublicAddress('192.168.1.1\n'), null, 'parsePublicAddress rejects private');

assertEq(maskIpAddress('1.2.3.42'), '•••.•••.•••.42', 'mask IPv4');
assertEq(maskIpAddress('2606:4700:4700::1111'), '••••:…:1111', 'mask IPv6');

assertEq(countryCodeToFlag('US'), '🇺🇸', 'flag US');
assertEq(countryCodeToFlag('de'), '🇩🇪', 'flag de lowercase');
assertEq(countryCodeToFlag('USA'), '', 'flag invalid length');
assertEq(countryCodeToFlag(''), '', 'flag empty');

assertEq(isVpnInterfaceName('tun0'), true, 'VPN tun0');
assertEq(isVpnInterfaceName('wg0'), true, 'VPN wg0');
assertEq(isVpnInterfaceName('tailscale0'), true, 'VPN tailscale0');
assertEq(isVpnInterfaceName('proton0'), true, 'VPN proton0');
assertEq(isVpnInterfaceName('wlp3s0'), false, 'non-VPN wlp3s0');
assertEq(isVpnInterfaceName('eth0'), false, 'non-VPN eth0');

// Reset boundaries
const beforeReset = new Date(2026, 5, 10, 2, 30, 0).getTime();
const afterReset = new Date(2026, 5, 10, 4, 0, 0).getTime();
assertEq(
    latestResetBoundary(beforeReset, 3),
    Math.floor(new Date(2026, 5, 9, 3, 0, 0).getTime() / 1000),
    'latestResetBoundary before 03:00 is previous day');
assertEq(
    latestResetBoundary(afterReset, 3),
    Math.floor(new Date(2026, 5, 10, 3, 0, 0).getTime() / 1000),
    'latestResetBoundary after 03:00 is same day');
assertEq(
    nextResetBoundary(beforeReset, 3),
    Math.floor(new Date(2026, 5, 10, 3, 0, 0).getTime() / 1000),
    'nextResetBoundary before 03:00 is same day');
assertEq(
    nextResetBoundary(afterReset, 3),
    Math.floor(new Date(2026, 5, 11, 3, 0, 0).getTime() / 1000),
    'nextResetBoundary after 03:00 is next day');

assertEq(formatFooterText(300, 3), 'Checked every 5 min · log resets daily at 03:00', 'footer 300s 03:00');
assertEq(formatFooterText(90, 14), 'Checked every 90 s · log resets daily at 14:00', 'footer 90s 14:00');

print(`Tests completed: ${passed} passed, ${failed} failed`);
if (failed > 0)
    imports.system.exit(1);
