import { spawnSync } from 'node:child_process'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const build = path.join(root, 'build')
const output = path.join(build, 'cartographer')
const archive = path.join(build, 'cartographer-release.tar.gz')
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`)
}

run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'])
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
// An explicit allowlist keeps keys, MongoDB files and caches out of releases.
const files = ['dist', 'src', 'public', 'package.json', 'package-lock.json', 'index.html',
  'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'postcss.config.js', 'tailwind.config.js', 'components.json', 'scripts',
  'Dockerfile', 'docker-compose.yaml', 'docker-compose.local.yaml', '.dockerignore', '.env.example', 'README.md',
  'docs', 'backend/cartographer', 'backend/tests', 'backend/pyproject.toml', 'backend/uv.lock', 'backend/README.md', 'backend/.env.example']
for (const relative of files) {
  const source = path.join(root, relative)
  await mkdir(path.dirname(path.join(output, relative)), { recursive: true })
  await cp(source, path.join(output, relative), { recursive: true, filter: candidate => !candidate.split(path.sep).includes('__pycache__') && !candidate.endsWith('.pyc') })
}
await writeFile(path.join(output, 'RELEASE.txt'), 'Cartographer deployment bundle\n\nSee docs/deployment.md for Coolify and Docker Compose setup.\nThe compiled client is in dist/. Backend source and its locked uv dependencies are in backend/.\nNo API keys, database files, dependencies, or image caches are included.\nProvide credentials at runtime through .env or Coolify environment variables.\n')
run('tar', ['-czf', archive, '-C', build, 'cartographer'])
console.log(`\nDeployment folder: ${output}\nDeployment archive: ${archive}`)
