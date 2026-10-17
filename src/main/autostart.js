'use strict';
/* Start at login on Linux: an XDG autostart entry, ~/.config/autostart/issuemon.desktop (or $XDG_CONFIG_HOME), which
   GNOME, KDE and other desktops run at login. It starts IssueMon with HIDDEN_FLAG, so only the tray icon appears.
   macOS uses Electron's login items instead (main.js). */

const nodeFs = require('node:fs');
const path = require('node:path');

const HIDDEN_FLAG = '--hidden';

/** The autostart entry's path: $XDG_CONFIG_HOME/autostart, else ~/.config/autostart. */
function autostartFile({ env = process.env, homedir }) {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir, '.config'), 'autostart', 'issuemon.desktop');
}

/** One argument of an Exec line, as the Desktop Entry Specification asks: inside double quotes, ", `, $ and \ get a
 *  backslash; then the general escape rule of string values doubles every backslash; and % is written %% everywhere. */
function execArg(arg) {
  const escaped = arg.replace(/%/g, '%%');
  if (/^[A-Za-z0-9_\-./+=:@,%]+$/.test(arg)) return escaped;
  return `"${escaped.replace(/(["`$\\])/g, '\\$1')}"`.replace(/\\/g, '\\\\');
}

/** The text of the autostart entry for the executable at exec (for an AppImage: the AppImage file itself). */
function desktopEntry(exec) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=IssueMon',
    'Comment=Keep an eye on Jira issues',
    `Exec=${execArg(exec)} ${HIDDEN_FLAG}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/** Writes the entry when on, removes it when off: what the setting does. */
function setAutostart({ on, file, exec, fs = nodeFs }) {
  if (!on) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, desktopEntry(exec));
}

/** At every start: points an existing entry's Exec line at exec, so a moved AppImage keeps starting. Everything else
 *  stays, so the desktop's own autostart switch (Hidden=true, X-GNOME-Autostart-enabled=false, or a removed file) wins. */
function refreshAutostart({ file, exec, fs = nodeFs }) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  const next = text.replace(/^Exec=.*$/m, `Exec=${execArg(exec)} ${HIDDEN_FLAG}`);
  if (next !== text) fs.writeFileSync(file, next);
}

module.exports = { HIDDEN_FLAG, autostartFile, desktopEntry, execArg, refreshAutostart, setAutostart };
