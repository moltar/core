import {join, relative as pathRelative, sep} from 'node:path'
import * as TSNode from 'ts-node'

import {memoizedWarn} from '../errors'
import {Plugin, TSConfig} from '../interfaces'
import {settings} from '../settings'
import {existsSync, readTSConfig} from '../util/fs'
import {isProd} from '../util/util'
import Cache from './cache'
import {Debug} from './util'
// eslint-disable-next-line new-cap
const debug = Debug('ts-node')

export const TS_CONFIGS: Record<string, TSConfig> = {}
const REGISTERED = new Set<string>()

function isErrno(error: any): error is NodeJS.ErrnoException {
  return 'code' in error && error.code === 'ENOENT'
}

async function loadTSConfig(root: string): Promise<TSConfig | undefined> {
  try {
    if (TS_CONFIGS[root]) return TS_CONFIGS[root]

    TS_CONFIGS[root] = await readTSConfig(join(root, 'tsconfig.json'))

    return TS_CONFIGS[root]
  } catch (error) {
    if (isErrno(error)) return

    debug(`Could not parse tsconfig.json. Skipping ts-node registration for ${root}.`)
    memoizedWarn(`Could not parse tsconfig.json for ${root}. Falling back to compiled source.`)
  }
}

async function registerTSNode(root: string): Promise<TSConfig | undefined> {
  const tsconfig = await loadTSConfig(root)
  if (!tsconfig) return
  if (REGISTERED.has(root)) return tsconfig

  debug('registering ts-node at', root)
  const tsNodePath = require.resolve('ts-node', {paths: [root, __dirname]})
  debug('ts-node path:', tsNodePath)
  let tsNode: typeof TSNode

  try {
    tsNode = require(tsNodePath)
  } catch {
    debug(`Could not find ts-node at ${tsNodePath}. Skipping ts-node registration for ${root}.`)
    memoizedWarn(
      `Could not find ts-node at ${tsNodePath}. Please ensure that ts-node is a devDependency. Falling back to compiled source.`,
    )
    return
  }

  const typeRoots = [join(root, 'node_modules', '@types')]

  const rootDirs: string[] = []

  if (tsconfig.compilerOptions.rootDirs) {
    for (const r of tsconfig.compilerOptions.rootDirs) {
      rootDirs.push(join(root, r))
    }
  } else if (tsconfig.compilerOptions.rootDir) {
    rootDirs.push(join(root, tsconfig.compilerOptions.rootDir))
  } else if (tsconfig.compilerOptions.baseUrl) {
    rootDirs.push(join(root, tsconfig.compilerOptions.baseUrl))
  } else {
    rootDirs.push(join(root, 'src'))
  }

  // Because we need to provide a modified `rootDirs` to ts-node, we need to
  // remove `baseUrl` and `rootDir` from `compilerOptions` so that they
  // don't conflict.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {baseUrl, rootDir, ...rest} = tsconfig.compilerOptions
  const conf: TSNode.RegisterOptions = {
    compilerOptions: {
      ...rest,
      rootDirs,
      typeRoots,
    },
    ...tsconfig['ts-node'],
    cwd: root,
    esm: tsconfig['ts-node']?.esm ?? true,
    experimentalSpecifierResolution: tsconfig['ts-node']?.experimentalSpecifierResolution ?? 'explicit',
    scope: true,
    scopeDir: root,
    skipProject: true,
    transpileOnly: true,
  }

  tsNode.register(conf)
  REGISTERED.add(root)
  debug('tsconfig: %O', tsconfig)
  debug('ts-node options: %O', conf)

  return tsconfig
}

/**
 * Skip ts-node registration for ESM plugins in production.
 * The node ecosystem is not mature enough to support auto-transpiling ESM modules at this time.
 * See the following:
 * - https://github.com/TypeStrong/ts-node/issues/1791#issuecomment-1149754228
 * - https://github.com/nodejs/node/issues/49432
 * - https://github.com/nodejs/node/pull/49407
 * - https://github.com/nodejs/node/issues/34049
 *
 * We still register ts-node for ESM plugins when NODE_ENV is "test" or "development" and root plugin is also ESM
 * since that allows plugins to be auto-transpiled when developing locally using `bin/dev.js`.
 */
function cannotTranspileEsm(
  rootPlugin: Plugin | undefined,
  plugin: Plugin | undefined,
  isProduction: boolean,
): boolean {
  return (isProduction || rootPlugin?.moduleType === 'commonjs') && plugin?.moduleType === 'module'
}

/**
 * If the dev script is run with ts-node for an ESM plugin, skip ts-node registration
 * and fall back on compiled source since ts-node executable cannot transpile ESM in Node 20+
 *
 * See the following:
 * https://nodejs.org/en/blog/announcements/v20-release-announce#custom-esm-loader-hooks-nearing-stable
 * https://github.com/oclif/core/issues/817
 * https://github.com/TypeStrong/ts-node/issues/1997
 */
function cannotUseTsNode(root: string, plugin: Plugin | undefined, isProduction: boolean): boolean {
  if (plugin?.moduleType !== 'module' || isProduction) return false

  const nodeMajor = Number.parseInt(process.version.replace('v', '').split('.')[0], 10)
  const tsNodeExecIsUsed = process.execArgv[0] === '--require' && process.execArgv[1].split(sep).includes(`ts-node`)
  return tsNodeExecIsUsed && nodeMajor >= 20
}

/**
 * Determine the path to the source file from the compiled ./lib files
 */
async function determinePath(root: string, orig: string): Promise<string> {
  const tsconfig = await registerTSNode(root)
  if (!tsconfig) return orig

  debug(`determining path for ${orig}`)
  const {baseUrl, outDir, rootDir, rootDirs} = tsconfig.compilerOptions
  const rootDirPath = rootDir ?? (rootDirs ?? [])[0] ?? baseUrl
  if (!rootDirPath) {
    debug(`no rootDir, rootDirs, or baseUrl specified in tsconfig.json. Returning default path ${orig}`)
    return orig
  }

  if (!outDir) {
    debug(`no outDir specified in tsconfig.json. Returning default path ${orig}`)
    return orig
  }

  // rewrite path from ./lib/foo to ./src/foo
  const lib = join(root, outDir) // ./lib
  const src = join(root, rootDirPath) // ./src
  const relative = pathRelative(lib, orig) // ./commands
  // For hooks, it might point to a js file, not a module. Something like "./hooks/myhook.js" which doesn't need the js.
  const out = join(src, relative).replace(/\.js$/, '') // ./src/commands
  // this can be a directory of commands or point to a hook file
  // if it's a directory, we check if the path exists. If so, return the path to the directory.
  // For hooks, it might point to a module, not a file. Something like "./hooks/myhook"
  // That file doesn't exist, and the real file is "./hooks/myhook.ts"
  // In that case we attempt to resolve to the filename. If it fails it will revert back to the lib path

  debug(`lib dir: ${lib}`)
  debug(`src dir: ${src}`)
  debug(`src commands dir: ${out}`)
  if (existsSync(out) || existsSync(out + '.ts')) {
    debug(`Found source file for ${orig} at ${out}`)
    return out
  }

  debug(`No source file found. Returning default path ${orig}`)
  if (!isProd()) memoizedWarn(`Could not find source for ${orig} based on tsconfig. Defaulting to compiled source.`)

  return orig
}

/**
 * Convert a path from the compiled ./lib files to the ./src typescript source
 * this is for developing typescript plugins/CLIs
 * if there is a tsconfig and the original sources exist, it attempts to require ts-node
 */
export async function tsPath(root: string, orig: string, plugin: Plugin): Promise<string>
export async function tsPath(root: string, orig: string | undefined, plugin?: Plugin): Promise<string | undefined>
export async function tsPath(root: string, orig: string | undefined, plugin?: Plugin): Promise<string | undefined> {
  const rootPlugin = plugin?.options.isRoot ? plugin : Cache.getInstance().get('rootPlugin')

  if (!orig) return orig
  orig = orig.startsWith(root) ? orig : join(root, orig)

  // NOTE: The order of these checks matter!

  if (settings.tsnodeEnabled === false) {
    debug(`Skipping ts-node registration for ${root} because tsNodeEnabled is explicitly set to false`)
    return orig
  }

  const isProduction = isProd()

  if (cannotTranspileEsm(rootPlugin, plugin, isProduction)) {
    debug(
      `Skipping ts-node registration for ${root} because it's an ESM module (NODE_ENV: ${process.env.NODE_ENV}, root plugin module type: ${rootPlugin?.moduleType})`,
    )
    if (plugin?.type === 'link')
      memoizedWarn(
        `${plugin?.name} is a linked ESM module and cannot be auto-transpiled. Existing compiled source will be used instead.`,
      )
    return orig
  }

  // Do not skip ts-node registration if the plugin is linked
  if (settings.tsnodeEnabled === undefined && isProduction && plugin?.type !== 'link') {
    debug(`Skipping ts-node registration for ${root} because NODE_ENV is NOT "test" or "development"`)
    return orig
  }

  if (cannotUseTsNode(root, plugin, isProduction)) {
    debug(`Skipping ts-node registration for ${root} because ts-node is run in node version ${process.version}"`)
    memoizedWarn(
      `ts-node executable cannot transpile ESM in Node 20. Existing compiled source will be used instead. See https://github.com/oclif/core/issues/817.`,
    )
    return orig
  }

  try {
    return await determinePath(root, orig)
  } catch (error: any) {
    debug(error)
    return orig
  }
}
