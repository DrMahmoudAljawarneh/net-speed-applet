import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class NetSpeedPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

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

        const unitModel = new Gtk.StringList();
        unitModel.append('Bytes per second (KB/s, MB/s)');
        unitModel.append('Bits per second (Kbps, Mbps)');

        const unitRow = new Adw.ComboRow({
            title: 'Speed unit',
            subtitle: 'Unit used for download and upload rates in the panel',
            model: unitModel,
            selected: settings.get_string('speed-unit') === 'bits' ? 1 : 0,
        });
        unitRow.connect('notify::selected', () => {
            settings.set_string('speed-unit', unitRow.selected === 1 ? 'bits' : 'bytes');
        });
        panelGroup.add(unitRow);
    }
}
