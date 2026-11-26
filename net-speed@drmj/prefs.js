import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const REFRESH_OPTIONS = [
    {label: '0.5 seconds', ms: 500},
    {label: '1 second', ms: 1000},
    {label: '2 seconds', ms: 2000},
    {label: '5 seconds', ms: 5000},
];

export default class NetSpeedPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const signalIds = [];

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const panelGroup = new Adw.PreferencesGroup({
            title: 'Panel Display',
            description: 'Choose which metrics appear in the top panel and how speeds are formatted.',
        });
        page.add(panelGroup);

        const cpuRow = new Adw.SwitchRow({
            title: 'Show CPU usage',
            subtitle: 'Display CPU percentage next to network speeds',
        });
        settings.bind('show-cpu', cpuRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(cpuRow);

        const ramRow = new Adw.SwitchRow({
            title: 'Show RAM usage',
            subtitle: 'Display memory percentage next to CPU usage',
        });
        settings.bind('show-ram', ramRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(ramRow);

        const thresholdRow = new Adw.SwitchRow({
            title: 'Color thresholds',
            subtitle: 'Highlight CPU and RAM in amber (≥80%) and red (≥95%)',
        });
        settings.bind('color-thresholds', thresholdRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(thresholdRow);

        const unitModel = new Gtk.StringList();
        unitModel.append('Bytes per second (KB/s, MB/s)');
        unitModel.append('Bits per second (Kbps, Mbps)');

        const unitRow = new Adw.ComboRow({
            title: 'Speed unit',
            subtitle: 'Unit used for download and upload rates in the panel',
            model: unitModel,
            selected: settings.get_string('speed-unit') === 'bits' ? 1 : 0,
        });
        let syncingUnit = false;
        unitRow.connect('notify::selected', () => {
            if (syncingUnit)
                return;
            settings.set_string('speed-unit', unitRow.selected === 1 ? 'bits' : 'bytes');
        });
        signalIds.push(settings.connect('changed::speed-unit', () => {
            syncingUnit = true;
            unitRow.selected = settings.get_string('speed-unit') === 'bits' ? 1 : 0;
            syncingUnit = false;
        }));
        panelGroup.add(unitRow);

        const menuGroup = new Adw.PreferencesGroup({
            title: 'Sampling & Menu',
            description: 'Control polling frequency, graph display, and interface filtering.',
        });
        page.add(menuGroup);

        const intervalModel = new Gtk.StringList();
        for (const opt of REFRESH_OPTIONS)
            intervalModel.append(opt.label);

        const indexForInterval = ms => {
            const idx = REFRESH_OPTIONS.findIndex(o => o.ms === ms);
            return idx >= 0 ? idx : 1;
        };

        const intervalRow = new Adw.ComboRow({
            title: 'Refresh interval',
            subtitle: 'How frequently /proc counters are sampled',
            model: intervalModel,
            selected: indexForInterval(settings.get_int('refresh-interval')),
        });
        let syncingInterval = false;
        intervalRow.connect('notify::selected', () => {
            if (syncingInterval)
                return;
            const opt = REFRESH_OPTIONS[intervalRow.selected];
            if (opt)
                settings.set_int('refresh-interval', opt.ms);
        });
        signalIds.push(settings.connect('changed::refresh-interval', () => {
            syncingInterval = true;
            intervalRow.selected = indexForInterval(settings.get_int('refresh-interval'));
            syncingInterval = false;
        }));
        menuGroup.add(intervalRow);

        const graphRow = new Adw.SwitchRow({
            title: 'Show throughput graph',
            subtitle: 'Display a 60-sample download/upload sparkline in the menu',
        });
        settings.bind('show-graph', graphRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        menuGroup.add(graphRow);

        const ignoredRow = new Adw.EntryRow({
            title: 'Ignored interfaces (comma-separated, e.g. docker0, veth*)',
            text: settings.get_string('ignored-interfaces'),
        });
        settings.bind('ignored-interfaces', ignoredRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        menuGroup.add(ignoredRow);

        window.connect('close-request', () => {
            for (const id of signalIds)
                settings.disconnect(id);
            signalIds.length = 0;
        });
    }
}
