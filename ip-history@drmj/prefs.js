import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class IpHistoryPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const displayGroup = new Adw.PreferencesGroup({
            title: 'Panel & Privacy',
            description: 'Customize how your public IP address appears in the top bar.',
        });
        page.add(displayGroup);

        const maskRow = new Adw.SwitchRow({
            title: 'Mask IP in panel',
            subtitle: 'Hide most digits in the top bar for screen sharing',
        });
        settings.bind('mask-ip', maskRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(maskRow);

        const flagRow = new Adw.SwitchRow({
            title: 'Show country flag',
            subtitle: 'Display the country flag emoji next to the IP address',
        });
        settings.bind('show-flag', flagRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(flagRow);

        const vpnRow = new Adw.SwitchRow({
            title: 'Show VPN indicator',
            subtitle: 'Display a lock icon when a VPN interface is active',
        });
        settings.bind('show-vpn-icon', vpnRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(vpnRow);

        const notifyRow = new Adw.SwitchRow({
            title: 'Notify on IP change',
            subtitle: 'Show a desktop notification whenever your public IP changes',
        });
        settings.bind('notify-on-change', notifyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(notifyRow);

        const lookupGroup = new Adw.PreferencesGroup({
            title: 'Lookup & Log',
            description: 'Configure polling frequency, geolocation, and daily log reset.',
        });
        page.add(lookupGroup);

        const geoRow = new Adw.SwitchRow({
            title: 'Look up location and ISP',
            subtitle: 'Query ipinfo.io once per IP change for country, city, and ISP',
        });
        settings.bind('enable-geo', geoRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        lookupGroup.add(geoRow);

        const intervalRow = new Adw.SpinRow({
            title: 'Check interval (seconds)',
            subtitle: 'How often to check the current public IP (60–3600 s)',
            adjustment: new Gtk.Adjustment({
                lower: 60,
                upper: 3600,
                step_increment: 60,
                page_increment: 300,
                value: settings.get_int('check-interval'),
            }),
        });
        settings.bind('check-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        lookupGroup.add(intervalRow);

        const resetHourRow = new Adw.SpinRow({
            title: 'Daily log reset hour',
            subtitle: 'Local hour (0–23) when the daily IP log is automatically cleared',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 23,
                step_increment: 1,
                page_increment: 3,
                value: settings.get_int('reset-hour'),
            }),
        });
        settings.bind('reset-hour', resetHourRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        lookupGroup.add(resetHourRow);
    }
}
