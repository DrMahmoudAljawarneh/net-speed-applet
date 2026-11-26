/* net-speed@drmj
 *
 * Shows live download/upload throughput, CPU usage and memory usage in the
 * GNOME top panel.
 *
 * Everything comes from /proc, so no extra daemon or permissions are needed:
 *   /proc/net/dev   network byte counters (all interfaces except loopback)
 *   /proc/stat      aggregate CPU time and per-core counters
 *   /proc/meminfo   MemTotal / MemAvailable / Swap
 *   /proc/loadavg   load averages, shown in the menu only
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

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
} from './utils.js';

const DEFAULT_REFRESH_INTERVAL_MS = 1000;
// Samples further apart than this (resume from suspend, heavy stall) are
// treated as a fresh baseline instead of producing a bogus giant rate.
const MAX_SAMPLE_GAP_SECONDS = 10;
const GRAPH_HISTORY_LEN = 60;

const PROC_NET_DEV_FILE = Gio.File.new_for_path('/proc/net/dev');
const PROC_STAT_FILE = Gio.File.new_for_path('/proc/stat');
const PROC_MEMINFO_FILE = Gio.File.new_for_path('/proc/meminfo');
const PROC_LOADAVG_FILE = Gio.File.new_for_path('/proc/loadavg');

const TEXT_DECODER = new TextDecoder();

// Only log a failing /proc file once, otherwise a persistent problem would
// flood the journal every second.
const loggedReadFailures = new Set();

/**
 * Reads a whole /proc file as text.
 *
 * @param {Gio.File} file file to read
 * @returns {string|null}
 */
function readTextFile(file) {
    try {
        const [ok, contents] = file.load_contents(null);
        if (!ok)
            return null;
        return TEXT_DECODER.decode(contents);
    } catch (e) {
        const path = file.get_path() ?? 'file';
        if (!loggedReadFailures.has(path)) {
            loggedReadFailures.add(path);
            log(`net-speed: failed to read ${path}: ${e.message}`);
        }
        return null;
    }
}

/**
 * Reads /proc/net/dev and returns a map of interface name to byte counters.
 *
 * @returns {Map<string, {rx: number, tx: number}>|null}
 */
function readCounters() {
    const text = readTextFile(PROC_NET_DEV_FILE);
    if (!text)
        return null;

    const counters = new Map();
    for (const line of text.split('\n')) {
        const match = line.match(/^\s*([^:\s]+):\s*(.+)$/);
        if (!match)
            continue;

        const [, name, rest] = match;
        if (name === 'lo')
            continue;

        // Layout: rx bytes, rx packets, ... (8 fields) then
        //         tx bytes, tx packets, ... (8 fields)
        const fields = rest.trim().split(/\s+/).map(f => Number.parseInt(f, 10));
        if (fields.length < 9 || fields.some(f => Number.isNaN(f)))
            continue;

        counters.set(name, {rx: fields[0], tx: fields[8]});
    }

    return counters;
}

/**
 * Reads CPU times from /proc/stat, both aggregate and per core.
 *
 * @returns {{total: number, idle: number, cores: {total: number, idle: number}[]}|null}
 *     jiffies
 */
function readCpuTimes() {
    const text = readTextFile(PROC_STAT_FILE);
    if (!text)
        return null;

    let aggregate = null;
    const cores = [];

    for (const line of text.split('\n')) {
        const match = line.match(/^cpu(\d*)\s+(.+)$/);
        if (!match)
            continue;

        const fields = match[2].trim().split(/\s+/)
            .slice(0, 8)
            .map(f => Number.parseInt(f, 10));
        // user nice system idle iowait irq softirq steal
        if (fields.length < 8 || fields.some(f => Number.isNaN(f)))
            continue;

        const times = {
            total: fields.reduce((sum, value) => sum + value, 0),
            idle: fields[3] + fields[4],
        };

        if (match[1] === '')
            aggregate = times;
        else
            cores.push(times);
    }

    if (!aggregate)
        return null;

    return {...aggregate, cores};
}

/**
 * Reads memory and swap usage from /proc/meminfo.
 *
 * @returns {{total: number, used: number, available: number,
 *     swapTotal: number, swapUsed: number}|null} bytes
 */
function readMemory() {
    const text = readTextFile(PROC_MEMINFO_FILE);
    if (!text)
        return null;

    let total = 0;
    let available = 0;
    let swapTotal = 0;
    let swapFree = 0;

    for (const line of text.split('\n')) {
        const match = line.match(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)/);
        if (!match)
            continue;

        const value = Number.parseInt(match[2], 10) * 1024;
        switch (match[1]) {
        case 'MemTotal':
            total = value;
            break;
        case 'MemAvailable':
            available = value;
            break;
        case 'SwapTotal':
            swapTotal = value;
            break;
        case 'SwapFree':
            swapFree = value;
            break;
        }
    }

    if (total <= 0)
        return null;

    return {
        total,
        available,
        used: Math.max(0, total - available),
        swapTotal,
        swapUsed: Math.max(0, swapTotal - swapFree),
    };
}

function readLoadAverage() {
    const text = readTextFile(PROC_LOADAVG_FILE);
    if (!text)
        return null;

    const parts = text.trim().split(/\s+/);
    if (parts.length < 3)
        return null;

    return parts.slice(0, 3).join(' · ');
}

/* Panel and menu icons are sized in pixels (not em), so the layout is
 * independent of the theme font. */
const PANEL_ICON_SIZE = 13;
const MENU_ICON_SIZE = 12;

/**
 * Builds a themed, symbolic arrow icon shipped with the extension.
 *
 * @param {string} iconDir extension directory
 * @param {'down'|'up'} direction arrow direction
 * @param {number} size icon size in pixels
 * @returns {St.Icon}
 */
function makeArrowIcon(iconDir, direction, size) {
    const path = GLib.build_filenamev(
        [iconDir, `net-speed-${direction}-symbolic.svg`]);
    return new St.Icon({
        gicon: new Gio.FileIcon({file: Gio.File.new_for_path(path)}),
        icon_size: size,
        style_class: `net-speed-arrow net-speed-arrow-${direction}`,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

/**
 * Appends a rounded rectangle to the current cairo path.
 */
function roundedRectangle(cr, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);

    cr.moveTo(x + r, y);
    cr.lineTo(x + width - r, y);
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    cr.lineTo(x + width, y + height - r);
    cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    cr.lineTo(x + r, y + height);
    cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    cr.lineTo(x, y + r);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

/**
 * Horizontal rounded meter used for CPU and memory in the menu.
 */
const LevelMeter = GObject.registerClass(
class LevelMeter extends St.DrawingArea {
    _init(styleClass) {
        this._fraction = 0;
        this._accent = null;

        super._init({
            style_class: `net-speed-meter ${styleClass}`,
            height: 6,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    set fraction(value) {
        value = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
        if (value === this._fraction)
            return;

        this._fraction = value;
        this.queue_repaint();
    }

    vfunc_style_changed() {
        this._accent = this.get_theme_node().get_color('-net-speed-accent');
        super.vfunc_style_changed();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const foreground = this.get_theme_node().get_foreground_color();

        cr.save();
        roundedRectangle(cr, 0, 0, width, height, height / 2);
        cr.clip();

        cr.setSourceRGBA(foreground.red / 255, foreground.green / 255,
            foreground.blue / 255, 0.18);
        cr.paint();

        const fillWidth = width * this._fraction;
        if (fillWidth > 0) {
            const accent = this._accent ?? foreground;
            cr.setSourceColor(accent);
            cr.rectangle(0, 0, Math.max(height, fillWidth), height);
            cr.fill();
        }

        cr.restore();
        cr.$dispose();
    }
});

/**
 * A row of tiny vertical bars, one per CPU core.
 */
const CoreBars = GObject.registerClass(
class CoreBars extends St.DrawingArea {
    _init() {
        this._cores = [];
        this._accent = null;

        super._init({
            style_class: 'net-speed-cores',
            height: 20,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    set cores(values) {
        this._cores = Array.isArray(values) ? values : [];
        this.queue_repaint();
    }

    vfunc_style_changed() {
        this._accent = this.get_theme_node().get_color('-net-speed-accent');
        super.vfunc_style_changed();
    }

    vfunc_repaint() {
        const cores = this._cores;
        if (cores.length === 0)
            return;

        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const foreground = this.get_theme_node().get_foreground_color();
        const gap = cores.length > 12 ? 1 : 2;
        const barWidth = Math.max(2,
            (width - gap * (cores.length - 1)) / cores.length);
        const radius = Math.min(2, barWidth / 2);
        const accent = this._accent ?? foreground;

        for (let i = 0; i < cores.length; i++) {
            const x = i * (barWidth + gap);

            roundedRectangle(cr, x, 0, barWidth, height, radius);
            cr.setSourceRGBA(foreground.red / 255, foreground.green / 255,
                foreground.blue / 255, 0.16);
            cr.fill();

            const fraction = Math.max(0, Math.min(1, cores[i] / 100));
            const fillHeight = height * fraction;
            if (fillHeight <= 0)
                continue;

            roundedRectangle(cr, x, height - Math.max(2, fillHeight),
                barWidth, Math.max(2, fillHeight), radius);
            cr.setSourceColor(accent);
            cr.fill();
        }

        cr.$dispose();
    }
});

/**
 * 60-sample sparkline graph showing live download and upload throughput.
 */
const SpeedGraph = GObject.registerClass(
class SpeedGraph extends St.DrawingArea {
    _init() {
        this._samples = [];
        this._downColor = null;
        this._upColor = null;

        super._init({
            style_class: 'net-speed-graph',
            height: 44,
            x_expand: true,
        });
    }

    set samples(values) {
        this._samples = Array.isArray(values) ? values : [];
        this.queue_repaint();
    }

    vfunc_style_changed() {
        const node = this.get_theme_node();
        this._downColor = node.get_color('-net-speed-down');
        this._upColor = node.get_color('-net-speed-up');
        super.vfunc_style_changed();
    }

    _drawSeries(cr, width, height, values, maxRate, color) {
        const count = values.length;
        if (count < 2)
            return;

        const padY = 3;
        const plotH = Math.max(1, height - padY * 2);
        const stepX = width / (GRAPH_HISTORY_LEN - 1);
        const startX = width - (count - 1) * stepX;

        const yFor = val => padY + plotH * (1 - Math.min(1, Math.max(0, val / maxRate)));

        // Area fill
        cr.moveTo(startX, height);
        for (let i = 0; i < count; i++)
            cr.lineTo(startX + i * stepX, yFor(values[i]));
        cr.lineTo(startX + (count - 1) * stepX, height);
        cr.closePath();
        cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, 0.22);
        cr.fill();

        // Stroke line
        cr.moveTo(startX, yFor(values[0]));
        for (let i = 1; i < count; i++)
            cr.lineTo(startX + i * stepX, yFor(values[i]));
        cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, 0.95);
        cr.setLineWidth(1.5);
        cr.stroke();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const foreground = this.get_theme_node().get_foreground_color();

        cr.save();
        roundedRectangle(cr, 0, 0, width, height, 4);
        cr.clip();

        // Subtle background
        cr.setSourceRGBA(foreground.red / 255, foreground.green / 255,
            foreground.blue / 255, 0.08);
        cr.paint();

        // Horizontal reference lines (33% and 66%)
        cr.setSourceRGBA(foreground.red / 255, foreground.green / 255,
            foreground.blue / 255, 0.10);
        cr.setLineWidth(1);
        for (const frac of [0.33, 0.66]) {
            const y = Math.round(height * frac) + 0.5;
            cr.moveTo(0, y);
            cr.lineTo(width, y);
            cr.stroke();
        }

        const samples = this._samples;
        if (samples.length >= 2) {
            let maxRate = 10_000; // 10 KB/s floor so idle noise stays flat
            for (const s of samples) {
                if (s.rx > maxRate)
                    maxRate = s.rx;
                if (s.tx > maxRate)
                    maxRate = s.tx;
            }

            const downColor = this._downColor ?? foreground;
            const upColor = this._upColor ?? foreground;

            this._drawSeries(cr, width, height, samples.map(s => s.rx), maxRate, downColor);
            this._drawSeries(cr, width, height, samples.map(s => s.tx), maxRate, upColor);
        }

        cr.restore();
        cr.$dispose();
    }
});

const NetSpeedIndicator = GObject.registerClass(
class NetSpeedIndicator extends PanelMenu.Button {
    _init(iconDir, settings, openPreferences) {
        super._init(0.5, 'Net Speed');
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._settingsChangedIds = [];
        this.menu.box.add_style_class_name('net-speed-menu');

        this._iconDir = iconDir;
        this._timeoutId = 0;
        this._paused = false;
        this._previousCounters = null;
        this._previousCpu = null;
        this._previousSampleTime = 0;

        this._rates = new Map();
        this._rxRate = 0;
        this._txRate = 0;
        this._sessionRx = 0;
        this._sessionTx = 0;
        this._history = [];
        this._selectedInterface = null;
        this._ignoredPatterns = [];

        this._cpuUsage = 0;
        this._coreUsage = [];
        this._coreCount = 0;
        this._memUsed = 0;
        this._memTotal = 0;
        this._memAvailable = 0;
        this._swapUsed = 0;
        this._swapTotal = 0;

        this._interfaceItems = new Map();

        const box = new St.BoxLayout({
            style_class: 'net-speed-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const networkBox = new St.BoxLayout({
            style_class: 'net-speed-group',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._downLabel = new St.Label({
            style_class: 'net-speed-label',
            text: '0.00 KB/s',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._upLabel = new St.Label({
            style_class: 'net-speed-label',
            text: '0.00 KB/s',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const downBox = new St.BoxLayout({
            style_class: 'net-speed-pair',
            y_align: Clutter.ActorAlign.CENTER,
        });
        downBox.add_child(makeArrowIcon(iconDir, 'down', PANEL_ICON_SIZE));
        downBox.add_child(this._downLabel);

        const upBox = new St.BoxLayout({
            style_class: 'net-speed-pair',
            y_align: Clutter.ActorAlign.CENTER,
        });
        upBox.add_child(makeArrowIcon(iconDir, 'up', PANEL_ICON_SIZE));
        upBox.add_child(this._upLabel);

        networkBox.add_child(downBox);
        networkBox.add_child(upBox);
        box.add_child(networkBox);

        this._cpuLabel = new St.Label({
            style_class: 'net-speed-label',
            text: 'CPU 0%',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._ramLabel = new St.Label({
            style_class: 'net-speed-label',
            text: 'RAM 0%',
            y_align: Clutter.ActorAlign.CENTER,
        });

        box.add_child(this._cpuLabel);
        box.add_child(this._ramLabel);
        this.add_child(box);

        // Middle-click opens System Monitor.
        this.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === Clutter.BUTTON_MIDDLE) {
                this._openSystemMonitor();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._buildMenu();
        this._applySettings();

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen)
                return;
            const width = Math.max(300, Math.ceil(this.get_width()));
            this.menu.box.set_style(`min-width: ${width}px;`);
            this._syncInterfaceItems();
            this._refreshLabels();
        });
    }

    _openSystemMonitor() {
        const appSystem = Shell.AppSystem.get_default();
        const candidates = [
            'org.gnome.SystemMonitor.desktop',
            'gnome-system-monitor.desktop',
            'io.missioncenter.MissionCenter.desktop',
        ];
        for (const id of candidates) {
            const app = appSystem.lookup_app(id);
            if (app) {
                app.activate();
                return;
            }
        }
        try {
            Gio.Subprocess.new(['gnome-system-monitor'], Gio.SubprocessFlags.NONE);
        } catch (e) {
            log(`net-speed: could not launch system monitor: ${e.message}`);
        }
    }

    _copyText(text) {
        if (!text)
            return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    }

    _buildMenu() {
        this.menu.removeAll();

        this._downRow = this._addValueRow('Download', 'down');
        this._upRow = this._addValueRow('Upload', 'up');
        this._sessionRow = this._addValueRow('Session');

        // Throughput sparkline section
        this._graphItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            activate: false,
            hover: false,
            can_focus: false,
            style_class: 'net-speed-detail',
        });
        this._graphItem.setOrnament(PopupMenu.Ornament.HIDDEN);

        const graphBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'net-speed-graph-box',
        });
        const graphHeader = new St.BoxLayout({
            x_expand: true,
            style_class: 'net-speed-graph-header',
        });
        this._graphTitle = new St.Label({
            text: 'Throughput',
            style_class: 'net-speed-detail-caption',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._graphPeak = new St.Label({
            text: '',
            style_class: 'net-speed-graph-peak',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        graphHeader.add_child(this._graphTitle);
        graphHeader.add_child(this._graphPeak);
        this._speedGraph = new SpeedGraph();
        graphBox.add_child(graphHeader);
        graphBox.add_child(this._speedGraph);
        this._graphItem.add_child(graphBox);
        this.menu.addMenuItem(this._graphItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._cpuDetail = this._addDetailItem('CPU', 'net-speed-meter-cpu');
        this._addCoreRow(this._cpuDetail.box);

        this._memDetail = this._addDetailItem('Memory', 'net-speed-meter-ram');
        this._swapInfo = new St.Label({
            text: '',
            style_class: 'net-speed-detail-info',
            x_expand: true,
        });
        this._memDetail.box.add_child(this._swapInfo);

        this._interfaceSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this._interfaceSeparator.visible = false;
        this.menu.addMenuItem(this._interfaceSeparator);

        this._interfaceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._interfaceSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const resetItem = new PopupMenu.PopupMenuItem('Reset session totals');
        resetItem.setOrnament(PopupMenu.Ornament.HIDDEN);
        resetItem.connect('activate', () => {
            this._sessionRx = 0;
            this._sessionTx = 0;
            this._refreshLabels();
        });
        this.menu.addMenuItem(resetItem);

        if (this._openPreferences) {
            const prefsItem = new PopupMenu.PopupMenuItem('Preferences');
            prefsItem.setOrnament(PopupMenu.Ornament.HIDDEN);
            prefsItem.connect('activate', () => this._openPreferences());
            this.menu.addMenuItem(prefsItem);
        }

        this._footerItem = new PopupMenu.PopupMenuItem('Sampled every second', {
            reactive: false,
        });
        this._footerItem.setOrnament(PopupMenu.Ornament.HIDDEN);
        this._footerItem.label.add_style_class_name('net-speed-menu-footer');
        this.menu.addMenuItem(this._footerItem);
    }

    /**
     * Adds a clickable "title ... value" row that copies its value on click.
     */
    _addValueRow(titleText, direction = null) {
        const item = new PopupMenu.PopupBaseMenuItem({
            style_class: 'net-speed-row',
        });
        item.setOrnament(PopupMenu.Ornament.HIDDEN);

        const box = new St.BoxLayout({
            x_expand: true,
            style_class: 'net-speed-row-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        if (direction)
            box.add_child(makeArrowIcon(this._iconDir, direction, MENU_ICON_SIZE));

        const title = new St.Label({
            text: titleText,
            style_class: 'net-speed-row-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const value = new St.Label({
            text: '',
            style_class: 'net-speed-row-value',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        item.connect('activate', () => this._copyText(value.text));

        box.add_child(title);
        box.add_child(value);
        item.add_child(box);
        this.menu.addMenuItem(item);

        return {item, value};
    }

    /**
     * Adds a CPU/memory block: title + percentage, a meter and a detail line.
     */
    _addDetailItem(titleText, meterStyle) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            activate: false,
            hover: false,
            can_focus: false,
            style_class: 'net-speed-detail',
        });
        item.setOrnament(PopupMenu.Ornament.HIDDEN);

        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'net-speed-detail-box',
        });

        const header = new St.BoxLayout({
            x_expand: true,
            style_class: 'net-speed-detail-header',
        });
        const title = new St.Label({
            text: titleText,
            style_class: 'net-speed-detail-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const value = new St.Label({
            text: '',
            style_class: 'net-speed-detail-value',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(title);
        header.add_child(value);
        box.add_child(header);

        const meter = new LevelMeter(meterStyle);
        box.add_child(meter);

        const info = new St.Label({
            text: '',
            style_class: 'net-speed-detail-info',
            x_expand: true,
        });
        box.add_child(info);

        item.add_child(box);
        this.menu.addMenuItem(item);

        return {item, box, value, meter, info};
    }

    /**
     * Adds the per-core bar strip below the CPU detail line.
     */
    _addCoreRow(parentBox) {
        const row = new St.BoxLayout({
            x_expand: true,
            style_class: 'net-speed-cores-row',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const label = new St.Label({
            text: 'Cores',
            style_class: 'net-speed-detail-caption',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._coreMeter = new CoreBars();
        row.add_child(label);
        row.add_child(this._coreMeter);
        parentBox.add_child(row);
    }

    _connectSettings() {
        if (!this._settings || this._settingsChangedIds.length > 0)
            return;

        this._settingsChangedIds.push(
            this._settings.connect('changed::show-cpu', () => this._applySettings()),
            this._settings.connect('changed::show-ram', () => this._applySettings()),
            this._settings.connect('changed::show-graph', () => this._applySettings()),
            this._settings.connect('changed::color-thresholds', () => this._refreshLabels()),
            this._settings.connect('changed::ignored-interfaces', () => {
                this._applySettings();
                this._syncInterfaceItems();
                this._refreshLabels();
            }),
            this._settings.connect('changed::speed-unit', () => {
                this._fixLabelWidths();
                this._refreshLabels();
            }),
            this._settings.connect('changed::refresh-interval', () => {
                this._applySettings();
                if (!this._paused && this._timeoutId)
                    this._restartTimer();
            })
        );
    }

    _disconnectSettings() {
        for (const id of this._settingsChangedIds)
            this._settings?.disconnect(id);
        this._settingsChangedIds = [];
    }

    _getRefreshInterval() {
        return this._settings?.get_int('refresh-interval') ?? DEFAULT_REFRESH_INTERVAL_MS;
    }

    _startTimer() {
        if (this._timeoutId || this._paused)
            return;

        this._timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            this._getRefreshInterval(),
            () => {
                this._sample();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopTimer() {
        if (!this._timeoutId)
            return;
        GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    setPaused(paused) {
        if (this._paused === paused)
            return;
        this._paused = paused;
        if (paused) {
            this._stopTimer();
        } else {
            this._previousCounters = null;
            this._previousCpu = null;
            this._sample();
            this._startTimer();
        }
    }

    start() {
        this._connectSettings();
        this._applySettings();
        this._fixLabelWidths();
        if (this._timeoutId || this._paused)
            return;

        this._sample();
        this._startTimer();
    }

    stop() {
        this._stopTimer();
        this._disconnectSettings();
    }

    destroy() {
        this.stop();
        super.destroy();
    }

    _applySettings() {
        if (!this._settings)
            return;
        this._cpuLabel.visible = this._settings.get_boolean('show-cpu');
        this._ramLabel.visible = this._settings.get_boolean('show-ram');
        this._graphItem.visible = this._settings.get_boolean('show-graph');
        this._ignoredPatterns = parseIgnoredPatterns(
            this._settings.get_string('ignored-interfaces'));
        this._footerItem.label.text = formatIntervalFooter(this._getRefreshInterval());
    }

    /**
     * Reserves the width of the widest possible value for every metric, so
     * changing numbers never reflow the panel.
     */
    _fixLabelWidths() {
        const speedProbe = this._settings?.get_string('speed-unit') === 'bits'
            ? '9999 Mbps'
            : '9999 MB/s';
        const probes = [
            [this._downLabel, speedProbe],
            [this._upLabel, speedProbe],
            [this._cpuLabel, 'CPU 100%'],
            [this._ramLabel, 'RAM 100%'],
        ];

        for (const [label, probe] of probes) {
            const text = label.text;
            label.set_text(probe);
            const [, natural] = label.get_preferred_width(-1);
            label.set_style(`min-width: ${Math.ceil(natural)}px;`);
            label.set_text(text);
        }
    }

    _sample() {
        const now = GLib.get_monotonic_time();
        const counters = readCounters();
        const cpu = readCpuTimes();
        const memory = readMemory();

        if (counters) {
            if (this._previousCounters) {
                const elapsed = (now - this._previousSampleTime) / 1e6;
                if (elapsed > 0 && elapsed <= MAX_SAMPLE_GAP_SECONDS)
                    this._updateRates(counters, elapsed);
                else
                    this._clearRates();
            }
            this._previousCounters = counters;
            this._previousSampleTime = now;
        } else {
            this._previousCounters = null;
        }

        if (cpu) {
            this._coreCount = cpu.cores.length;
            if (this._previousCpu)
                this._updateCpu(cpu);
            else
                this._coreUsage = cpu.cores.map(() => 0);
            this._previousCpu = cpu;
        } else {
            this._previousCpu = null;
        }

        if (memory) {
            this._memUsed = memory.used;
            this._memTotal = memory.total;
            this._memAvailable = memory.available;
            this._swapUsed = memory.swapUsed;
            this._swapTotal = memory.swapTotal;
        }

        this._refreshLabels();
    }

    _updateRates(counters, elapsed) {
        const rates = new Map();
        let rxTotal = 0;
        let txTotal = 0;

        for (const [name, current] of counters) {
            if (isInterfaceIgnored(name, this._ignoredPatterns))
                continue;

            const previous = this._previousCounters.get(name);
            if (!previous)
                continue;

            const rxDelta = current.rx - previous.rx;
            const txDelta = current.tx - previous.tx;

            if (rxDelta < 0 || txDelta < 0)
                continue;

            const rxRate = rxDelta / elapsed;
            const txRate = txDelta / elapsed;

            rates.set(name, {rx: rxRate, tx: txRate});
            rxTotal += rxRate;
            txTotal += txRate;
            this._sessionRx += rxDelta;
            this._sessionTx += txDelta;
        }

        this._rates = rates;
        if (this._selectedInterface && !rates.has(this._selectedInterface))
            this._selectedInterface = null;

        const active = this._selectedInterface
            ? rates.get(this._selectedInterface)
            : null;
        this._rxRate = active ? active.rx : rxTotal;
        this._txRate = active ? active.tx : txTotal;

        this._history.push({rx: this._rxRate, tx: this._txRate});
        if (this._history.length > GRAPH_HISTORY_LEN)
            this._history.shift();
    }

    _updateCpu(cpu) {
        const totalDelta = cpu.total - this._previousCpu.total;
        const idleDelta = cpu.idle - this._previousCpu.idle;
        if (totalDelta > 0 && idleDelta >= 0) {
            const usage = 100 * (1 - idleDelta / totalDelta);
            this._cpuUsage = Math.min(100, Math.max(0, usage));
        }

        this._coreCount = cpu.cores.length;
        this._coreUsage = cpu.cores.map((core, index) => {
            const previous = this._previousCpu.cores[index];
            if (!previous)
                return 0;

            const coreTotal = core.total - previous.total;
            const coreIdle = core.idle - previous.idle;
            if (coreTotal <= 0 || coreIdle < 0)
                return 0;

            return Math.min(100,
                Math.max(0, 100 * (1 - coreIdle / coreTotal)));
        });
    }

    _clearRates() {
        this._rates = new Map();
        this._rxRate = 0;
        this._txRate = 0;
    }

    _applyThresholdStyle(actor, percent) {
        actor.remove_style_class_name('net-speed-warn');
        actor.remove_style_class_name('net-speed-crit');
        if (this._settings && !this._settings.get_boolean('color-thresholds'))
            return;
        const cls = thresholdClass(percent);
        if (cls)
            actor.add_style_class_name(cls);
    }

    _syncInterfaceItems() {
        const names = [...this._rates.keys()].sort();
        const existing = [...this._interfaceItems.keys()];

        this._interfaceSeparator.visible = names.length > 0;

        if (names.length === existing.length &&
            names.every((name, i) => name === existing[i])) {
            this._updateInterfaceOrnaments();
            return;
        }

        for (const {item} of this._interfaceItems.values())
            item.destroy();
        this._interfaceItems.clear();

        for (const name of names) {
            const item = new PopupMenu.PopupBaseMenuItem({
                style_class: 'net-speed-row',
            });

            const box = new St.BoxLayout({
                x_expand: true,
                style_class: 'net-speed-row-box',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const title = new St.Label({
                text: name,
                style_class: 'net-speed-iface-name',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const value = new St.Label({
                text: '',
                style_class: 'net-speed-iface-value',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });

            item.connect('activate', () => {
                this._selectedInterface =
                    this._selectedInterface === name ? null : name;
                this._history = [];
                this._updateInterfaceOrnaments();
                this._refreshLabels();
            });

            box.add_child(title);
            box.add_child(value);
            item.add_child(box);
            this._interfaceSection.addMenuItem(item);
            this._interfaceItems.set(name, {item, title, value});
        }

        this._updateInterfaceOrnaments();
    }

    _updateInterfaceOrnaments() {
        for (const [name, {item, title}] of this._interfaceItems) {
            const pinned = this._selectedInterface === name;
            item.setOrnament(pinned ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            if (pinned)
                title.add_style_class_name('net-speed-iface-active');
            else
                title.remove_style_class_name('net-speed-iface-active');
        }
    }

    _refreshLabels() {
        const speedUnit = this._settings?.get_string('speed-unit') ?? 'bytes';
        const down = formatPanelSpeed(this._rxRate, speedUnit);
        const up = formatPanelSpeed(this._txRate, speedUnit);
        const cpu = Math.round(this._cpuUsage);
        const memory = this._memTotal > 0
            ? Math.round(100 * this._memUsed / this._memTotal)
            : 0;

        this._downLabel.set_text(down);
        this._upLabel.set_text(up);
        this._cpuLabel.set_text(`CPU ${cpu}%`);
        this._ramLabel.set_text(`RAM ${memory}%`);
        this._applyThresholdStyle(this._cpuLabel, cpu);
        this._applyThresholdStyle(this._ramLabel, memory);
        this.accessible_name =
            `Download ${down}, upload ${up}, CPU ${cpu}%, memory ${memory}%`;

        if (!this.menu.isOpen)
            return;

        this._syncInterfaceItems();

        this._downRow.value.text =
            `${formatSpeed(this._rxRate)} · ${formatBitrate(this._rxRate)}`;
        this._upRow.value.text =
            `${formatSpeed(this._txRate)} · ${formatBitrate(this._txRate)}`;
        this._sessionRow.value.text =
            `↓ ${formatMagnitude(this._sessionRx, BYTE_UNITS)}` +
            ` · ↑ ${formatMagnitude(this._sessionTx, BYTE_UNITS)}`;

        if (this._graphItem.visible) {
            const scope = this._selectedInterface
                ? `Throughput (${this._selectedInterface})`
                : 'Throughput';
            this._graphTitle.text = scope;
            let peakRx = 0;
            let peakTx = 0;
            for (const s of this._history) {
                if (s.rx > peakRx)
                    peakRx = s.rx;
                if (s.tx > peakTx)
                    peakTx = s.tx;
            }
            this._graphPeak.text =
                `Peak ↓ ${formatSpeed(peakRx)} · ↑ ${formatSpeed(peakTx)}`;
            this._speedGraph.samples = this._history;
        }

        const load = readLoadAverage();
        this._cpuDetail.value.text = `${cpu}%`;
        this._applyThresholdStyle(this._cpuDetail.value, cpu);
        this._cpuDetail.meter.fraction = this._cpuUsage / 100;
        this._cpuDetail.info.text =
            `${this._coreCount} ${this._coreCount === 1 ? 'core' : 'cores'}` +
            ` · load ${load ?? '—'}`;
        this._coreMeter.cores = this._coreUsage;

        this._memDetail.value.text = `${memory}%`;
        this._applyThresholdStyle(this._memDetail.value, memory);
        this._memDetail.meter.fraction = memory / 100;
        this._memDetail.info.text =
            `${formatMagnitude(this._memUsed, BYTE_UNITS)} of ` +
            `${formatMagnitude(this._memTotal, BYTE_UNITS)} · ` +
            `${formatMagnitude(this._memAvailable, BYTE_UNITS)} available`;

        const hasSwap = this._swapTotal > 0;
        this._swapInfo.visible = hasSwap;
        this._swapInfo.text = hasSwap
            ? `Swap ${formatMagnitude(this._swapUsed, BYTE_UNITS)} of ` +
              `${formatMagnitude(this._swapTotal, BYTE_UNITS)}`
            : '';

        for (const [name, {value}] of this._interfaceItems) {
            const rate = this._rates.get(name);
            if (!rate)
                continue;
            value.text = `↓ ${formatSpeed(rate.rx)} · ↑ ${formatSpeed(rate.tx)}`;
        }
    }
});

export default class NetSpeedExtension extends Extension {
    enable() {
        const iconDir = typeof this.dir === 'string'
            ? this.dir
            : this.dir.get_path();
        this._indicator = new NetSpeedIndicator(
            iconDir,
            this.getSettings(),
            () => this.openPreferences());
        // Center group, immediately right of the clock.
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'center');
        this._keepRightOfClock();
        this._indicator.start();

        // On session-mode changes (lock/unlock, user switch) pause polling
        // while locked and keep ourselves right of the clock.
        this._sessionModeUpdatedId = Main.sessionMode.connect('updated', () => {
            this._indicator?.setPaused(Main.sessionMode.isLocked);
            this._keepRightOfClock();
        });
    }

    _keepRightOfClock() {
        const container = this._indicator?.container;
        const clock = Main.panel.statusArea.dateMenu?.container;
        const box = clock?.get_parent();
        if (!container || !box)
            return;

        const children = box.get_children();
        const clockIndex = children.indexOf(clock);
        const selfIndex = children.indexOf(container);

        if (clockIndex < 0 || selfIndex === clockIndex + 1)
            return;

        // Already somewhere to the right of the clock: leave it alone.
        if (selfIndex > clockIndex)
            return;

        container.get_parent()?.remove_child(container);
        box.insert_child_at_index(container, box.get_children().indexOf(clock) + 1);
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
