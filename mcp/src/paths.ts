// Filamental MCP Server — paths.ts
// Shared filesystem locations. Both the entry point and the tool implementations
// need these, so they live here rather than being duplicated in each.

import { homedir } from 'os'
import { join } from 'path'

/** Mirrors Tauri's app_config_dir for "com.filamental.app". */
export function appConfigDir(): string {
  if (process.platform === 'win32') {
    return join(process.env['APPDATA'] ?? homedir(), 'com.filamental.app')
  } else if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'com.filamental.app')
  } else {
    return join(
      process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'),
      'com.filamental.app',
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
