import * as execa from 'execa'
import * as glob from '@now/build-utils/fs/glob.js'
import * as FileBlob from '@now/build-utils/file-blob'
import * as download from '@now/build-utils/fs/download.js'
import * as FileFsRef from '@now/build-utils/file-fs-ref.js'
import { dirname, join } from 'path'
import { readFile, remove } from 'fs-extra'
import { createLambda } from '@now/build-utils/lambda.js'
import { runNpmInstall, runPackageJsonScript } from '@now/build-utils/fs/run-user-scripts.js'

async function downloadInstallAndBundle(
  { files, entrypoint, workPath },
  { npmArguments = [] } = {},
) {
  const userPath = join(workPath, 'user')
  const nccPath = join(workPath, 'ncc')
  const coffeePath = join(workPath, 'coffee')
  
  console.log('downloading user files...')
  const downloadedFiles = await download(files, userPath)
  
  console.log('installing dependencies for user\'s code...')
  const entrypointFsDirname = join(userPath, dirname(entrypoint))
  await runNpmInstall(entrypointFsDirname, npmArguments)
  
  console.log('writing ncc package.json...')
  const downloadDependencies = [
    { name: { '@zeit/ncc': '0.16.0' }, path: nccPath },
    { name: { 'coffeescript': '2.3.2' }, path: coffeePath },
  ]
  for (const dep of downloadDependencies) {
    await download({
      'package.json': new FileBlob({
        data: JSON.stringify({
          license: 'UNLICENSED',
          dependencies: dep.name,
        }),
      }),
    }, dep.path)
  }
  
  console.log('installing dependencies for ncc...')
  await runNpmInstall(nccPath, npmArguments)
  
  console.log('installing dependencies for coffee...')
  await runNpmInstall(coffeePath, npmArguments)
  return [downloadedFiles, nccPath, coffeePath, entrypointFsDirname]
}

async function compile(workNccPath: string, downloadedFiles, entrypoint: string) {
  const input = downloadedFiles[entrypoint].fsPath
  const ncc = require(join(workNccPath, 'node_modules/@zeit/ncc'))
  const { code, assets } = await ncc(input)
  
  const preparedFiles = {}
  const blob = new FileBlob({ data: code })
  // move all user code to 'user' subdirectory
  preparedFiles[join('user', entrypoint)] = blob
  // eslint-disable-next-line no-restricted-syntax
  for (const assetName of Object.keys(assets)) {
    const { source: data, permissions: mode } = assets[assetName]
    const blob2 = new FileBlob({ data, mode })
    preparedFiles[join('user', dirname(entrypoint), assetName)] = blob2
  }
  
  return preparedFiles
}

export const build = async({ files, entrypoint, workPath }) => {
  const [
    downloadedFiles,
    workNccPath,
    workCoffeePath,
    entrypointFsDirname,
  ] = await downloadInstallAndBundle(
    { files, entrypoint, workPath },
    { npmArguments: ['--prefer-offline'] },
  )
  
  console.log('running user script...')
  await runPackageJsonScript(entrypointFsDirname, 'now-build')
  
  try {
    const coffee = join(workCoffeePath, 'node_modules/.bin/coffee')
    const userPath = join(workPath, 'user')
    await execa(coffee, ['--compile', '--output', userPath, userPath])
  } catch (e) {
    console.log(`failed to run "coffee --compile --output ./ ${entrypoint}"`)
    console.log(e)
  }
  
  const coffeeToJSEntrypoint = entrypoint.replace(/\.coffee$/, '.js')
  downloadedFiles[entrypoint] = new FileFsRef({ fsPath: join(workPath, 'user', coffeeToJSEntrypoint) })
  downloadedFiles[coffeeToJSEntrypoint] = downloadedFiles[entrypoint]
  
  console.log('compiling entrypoint with ncc...')
  const preparedFiles = await compile(workNccPath, downloadedFiles, coffeeToJSEntrypoint)
  const launcherPath = join(__dirname, 'launcher.js')
  const launcherDataAsTemplate = await readFile(launcherPath, 'utf8')
  const launcherData = launcherDataAsTemplate.replace(
    '// PLACEHOLDER',
    [
      'process.chdir("./user");',
      `listener = require("./${join('user', coffeeToJSEntrypoint)}");`,
      'if (listener.default) listener = listener.default;',
    ].join(' '),
  )
  
  const launcherFiles = {
    'launcher.js': new FileBlob({ data: launcherData }),
    'bridge.js': new FileFsRef({ fsPath: require('@now/node-bridge') }),
  }
  
  const lambda = await createLambda({
    files: { ...preparedFiles, ...launcherFiles },
    handler: 'launcher.launcher',
    runtime: 'nodejs8.10',
  })
  
  return { [entrypoint]: lambda }
}

export const config = {
  maxLambdaSize: '5mb',
}

export const prepareCache = async({ files, entrypoint, workPath, cachePath }) => {
  await remove(workPath)
  await downloadInstallAndBundle({ files, entrypoint, workPath: cachePath })
  
  return {
    ...(await glob('user/node_modules/**', cachePath)),
    ...(await glob('user/package-lock.json', cachePath)),
    ...(await glob('user/yarn.lock', cachePath)),
    ...(await glob('ncc/node_modules/**', cachePath)),
    ...(await glob('ncc/package-lock.json', cachePath)),
    ...(await glob('ncc/yarn.lock', cachePath)),
  }
}
