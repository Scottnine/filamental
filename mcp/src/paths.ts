// Filamental MCP Server — paths.ts
// Shared filesystem locations. Both the entry point and the tool implementations
// need these, so they live here rather than being duplicated in each.

import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** The desktop app's bundle identifier, which is also its data-directory name. */
const APP_ID = 'com.filamental.app'

/**
 * The macOS build distributed by Setapp carries a different bundle identifier
 * (Setapp mandates the `-setapp` suffix), so Tauri gives it a different
 * app-support directory. Both installs put their vault registry in their own
 * one, and this server has to read whichever is actually present.
 */
const SETAPP_APP_ID = 'com.filamental.app-setapp'

/**
 * Mirrors Tauri's app_config_dir for the installed desktop app.
 *
 * Every caller here reads — the active-vault pointer, a vault's database,
 * the help content — so probing for the directory is safe. On macOS a direct
 * install and a Setapp install can both exist; the direct one wins, since the
 * Setapp variant only reaches people who have no other copy.
 */
export function appConfigDir(): string {
  if (process.platform === 'win32') {
    return join(process.env['APPDATA'] ?? homedir(), APP_ID)
  } else if (process.platform === 'darwin') {
    const support = join(homedir(), 'Library', 'Application Support')
    const direct = join(support, APP_ID)
    if (existsSync(direct)) return direct
    const setapp = join(support, SETAPP_APP_ID)
    if (existsSync(setapp)) return setapp
    return direct
  } else {
    return join(
      process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'),
      APP_ID,
    )
  }
}

/**
 * Where the Filamental app installs its help content, including the two
 * reference documents this server serves on demand.
 *
 * This is installed by the desktop app, not by the npm package, so it may be
 * absent when the server runs standalone. Callers must degrade rather than fail.
 */
export function helpWorldDir(): string {
  return join(appConfigDir(), 'help-world')
}
