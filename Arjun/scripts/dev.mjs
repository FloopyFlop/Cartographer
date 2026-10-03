import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mongoUri, portOpen, root, startMongo } from './mongodb.mjs'

const children = []
let stopping = false
const backendOnly = process.argv.includes('--backend-only')
const env = { ...process.env, CARTOGRAPHER_PORT: process.env.CARTOGRAPHER_PORT || '5050', CARTOGRAPHER_MONGODB_URI: process.env.CARTOGRAPHER_MONGODB_URI || mongoUri, UV_CACHE_DIR: path.join(root, 'backend', '.cache', 'uv') }

function stop(code = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const { child, group } of children) {
    if (child.exitCode !== null || !child.pid) continue
    try { group ? process.kill(-child.pid, 'SIGTERM') : child.kill('SIGTERM') } catch { /* Already exited. */ }
  }
  setTimeout(() => {
    for (const { child, group } of children) {
      if (child.exitCode !== null || !child.pid) continue
      try { group ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL') } catch { /* Already exited. */ }
    }
  }, 5000).unref()
}

function launch(command, args) {
  if (stopping) throw new Error('Startup interrupted')
  const group = process.platform !== 'win32'
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', env, detached: group })
  children.push({ child, group })
  child.on('error', error => { console.error(error.message); stop(1) })
  return child
}

function completed(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Startup command exited with ${code}`)))
  })
}

process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())

try {
  if (await portOpen(Number(env.CARTOGRAPHER_PORT)) || (!backendOnly && await portOpen(5173))) throw new Error('Cartographer is already running, or its development port is occupied. Stop that process before starting another instance.')
  const mongo = await startMongo()
  if (mongo) {
    children.push({ child: mongo, group: false })
    mongo.on('exit', code => { if (!stopping) { console.error('Portable MongoDB stopped.'); stop(code || 1) } })
  }
  await completed(launch('uv', ['--directory', 'backend', 'run', 'python', '-m', 'cartographer.migrate']))
  const backend = launch('uv', ['--directory', 'backend', 'run', 'python', '-m', 'cartographer'])
  backend.on('exit', code => { if (!stopping) stop(code || 0) })
  if (!backendOnly) {
    const frontend = launch(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), '--host', '127.0.0.1'])
    frontend.on('exit', code => { if (!stopping) stop(code || 0) })
  }
} catch (error) {
  if (!stopping) console.error(error.message)
  stop(1)
}
