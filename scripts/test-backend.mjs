import { spawn } from 'node:child_process'
import path from 'node:path'
import { mongoUri, root, startMongo } from './mongodb.mjs'

let mongo
let tests
function stop() { tests?.kill('SIGTERM'); mongo?.kill('SIGTERM') }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
try {
  mongo = await startMongo()
  tests = spawn('uv', ['--directory', 'backend', 'run', 'pytest', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env: { ...process.env, UV_CACHE_DIR: path.join(root, 'backend', '.cache', 'uv'), CARTOGRAPHER_TEST_MONGODB_URI: process.env.CARTOGRAPHER_TEST_MONGODB_URI || process.env.CARTOGRAPHER_MONGODB_URI || mongoUri } })
  process.exitCode = await new Promise((resolve, reject) => { tests.once('error', reject); tests.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))) })
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally { mongo?.kill('SIGTERM') }
