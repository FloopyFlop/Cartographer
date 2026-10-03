import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

export const root = fileURLToPath(new URL('../', import.meta.url))
// Only database settings enter the launcher environment; API keys stay in Flask.
try {
  const settings = parseEnv((await readFile(path.join(root, 'backend', '.env'), 'utf8')).split('\n').filter(line => /^\s*CARTOGRAPHER_(?:MONGODB_URI|MONGODB_DATABASE|MONGOD_PATH)\s*=/.test(line)).join('\n'))
  for (const [key, value] of Object.entries(settings)) if (process.env[key] === undefined) process.env[key] = value
} catch (error) { if (error.code !== 'ENOENT') throw error }
export const mongoPort = 27018
export const mongoUri = `mongodb://127.0.0.1:${mongoPort}`
const version = '8.0.32'
const runtime = path.join(root, '.cache', 'mongodb', version)
const archives = {
  'darwin-arm64': ['https://fastdl.mongodb.org/osx/mongodb-macos-arm64-8.0.32.tgz', 'f81cb258434d548dca7244d599c82eb339043d8dedd0b1b807870c9d263117f2'],
  'darwin-x64': ['https://fastdl.mongodb.org/osx/mongodb-macos-x86_64-8.0.32.tgz', '4073d96f1a83ecae289997cb1f9ace5258a740fdb9b8b06ee00098ec342d1bce'],
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, UV_CACHE_DIR: path.join(root, 'backend', '.cache', 'uv') } })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)))
  })
}

export async function mongoBinary() {
  if (process.env.CARTOGRAPHER_MONGOD_PATH) return path.resolve(process.env.CARTOGRAPHER_MONGOD_PATH)
  const binary = path.join(runtime, 'bin', 'mongod')
  try { await access(binary); return binary } catch { /* First start installs locally. */ }
  const archive = archives[`${process.platform}-${process.arch}`]
  if (!archive) throw new Error('For this platform set CARTOGRAPHER_MONGOD_PATH to a local MongoDB Community mongod binary. Automatic portable download supports Apple silicon and Intel macOS.')
  await mkdir(runtime, { recursive: true })
  const temporary = path.join(runtime, 'download.tgz.partial')
  console.log(`Downloading portable MongoDB Community ${version} into Arjun…`)
  try {
    const response = await fetch(archive[0], { signal: AbortSignal.timeout(180_000) })
    if (!response.ok || !response.body) throw new Error('MongoDB download failed')
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary))
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(temporary)) hash.update(chunk)
    if (hash.digest('hex') !== archive[1]) throw new Error('MongoDB download checksum did not match the official release')
    const tarball = path.join(runtime, 'download.tgz')
    await rename(temporary, tarball)
    await run('tar', ['-xzf', tarball, '--strip-components=1', '-C', runtime])
    await rm(tarball)
    await access(binary)
    return binary
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

export function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = value => { socket.destroy(); resolve(value) }
    socket.setTimeout(400)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

export async function startMongo() {
  if (process.env.CARTOGRAPHER_MONGODB_URI && process.env.CARTOGRAPHER_MONGODB_URI !== mongoUri) {
    console.log('Using the configured MongoDB instance.')
    return null
  }
  if (await portOpen(mongoPort)) {
    // Prove this is MongoDB before the backend trusts the service at this port.
    await run('uv', ['--directory', 'backend', 'run', 'python', '-c', 'from pymongo import MongoClient; MongoClient("mongodb://127.0.0.1:27018", serverSelectionTimeoutMS=3000).admin.command("ping")'])
    console.log(`Using local MongoDB on ${mongoPort}.`)
    return null
  }
  const binary = await mongoBinary()
  const data = path.join(root, 'backend', '.cache', 'mongodb', 'data')
  const log = path.join(root, 'backend', '.cache', 'mongodb', 'mongod.log')
  await mkdir(data, { recursive: true })
  const child = spawn(binary, ['--dbpath', data, '--bind_ip', '127.0.0.1', '--port', String(mongoPort), '--logpath', log, '--logappend', '--wiredTigerCacheSizeGB', '0.25'], { cwd: root, stdio: 'inherit' })
  let startupError
  child.once('error', error => { startupError = error })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startupError || child.exitCode !== null) throw startupError || new Error(`MongoDB could not start; see ${log}`)
    if (await portOpen(mongoPort)) { console.log(`Portable MongoDB ready on ${mongoPort}.`); return child }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  child.kill('SIGTERM')
  throw new Error(`MongoDB startup timed out; see ${log}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--install')) await mongoBinary()
  else {
    const child = await startMongo()
    if (child) {
      process.on('SIGINT', () => child.kill('SIGTERM'))
      process.on('SIGTERM', () => child.kill('SIGTERM'))
      child.on('exit', code => { process.exitCode = code || 0 })
    }
  }
}
