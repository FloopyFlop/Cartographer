import { spawn } from 'node:child_process'
import path from 'node:path'
import { root, startMongo } from './mongodb.mjs'

let mongo
let backup
function stop() { backup?.kill('SIGTERM'); mongo?.kill('SIGTERM') }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
try {
  mongo = await startMongo()
  backup = spawn('uv', ['--directory', 'backend', 'run', 'python', '-m', 'cartographer.backup', ...process.argv.slice(2)], {
    cwd: root, stdio: 'inherit', env: { ...process.env, UV_CACHE_DIR: path.join(root, 'backend', '.cache', 'uv') },
  })
  process.exitCode = await new Promise((resolve, reject) => {
    backup.once('error', reject)
    backup.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })
} catch {
  console.error('The private database backup could not finish. Check local MongoDB and uv availability.')
  process.exitCode = 1
} finally { mongo?.kill('SIGTERM') }
