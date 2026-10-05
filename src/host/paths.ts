/**
 * This plugin's own data layout, rooted under the harness home.
 *
 * Downloaded packs live here rather than inside the profile: the profile's
 * `node_modules` entry is a copy that a reinstall or upgrade replaces, and a
 * user's sound packs must survive that untouched.
 * @module dsh-openpeon/host/paths
 */

import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** Directory name of the default harness home under the OS home. */
const DSH_HOME_DIR = '.dsh'

/** Directory name of this plugin's data under the harness home. */
const PLUGIN_DATA_DIR = 'dsh-openpeon'

/**
 * Resolve the harness home the way the rest of DSH does.
 * @param env - environment to read `DSH_HOME` from; empty means unset.
 * @returns the configured home, or `<os home>/.dsh`.
 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  return configured === undefined || configured === '' ? join(homedir(), DSH_HOME_DIR) : resolve(configured)
}

/**
 * @param env - environment to read `DSH_HOME` from.
 * @returns this plugin's data root.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), PLUGIN_DATA_DIR)
}

/**
 * @param env - environment to read `DSH_HOME` from.
 * @returns the directory holding one subdirectory per installed pack.
 */
export function packsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'packs')
}

/**
 * @param env - environment to read `DSH_HOME` from.
 * @returns the file recording the selected pack.
 */
export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'state.json')
}

/**
 * @param env - environment to read `DSH_HOME` from.
 * @returns the cached registry index file.
 */
export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'registry.json')
}

/**
 * Resolve one child of a root, refusing anything that escapes it.
 * Every path segment reaching the filesystem has already passed a registry-name
 * or manifest-path check; this is the second, structural line of defence.
 * @param root - absolute directory that must contain the result.
 * @param segments - relative path segments to join.
 * @returns the absolute child path.
 * @throws when the joined path is not strictly inside `root`.
 */
export function safeJoin(root: string, ...segments: readonly string[]): string {
  const target = resolve(root, ...segments)
  if (!target.startsWith(`${root}${sep}`)) throw new Error(`path escapes ${root}: ${segments.join('/')}`)
  return target
}
