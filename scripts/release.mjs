import { spawnSync } from 'node:child_process'
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

const exists = async filename => {
  try { await access(filename); return true } catch { return false }
}

// Keep the original license texts beside compiled client assets. This uses only
// the locked, installed packages, so clean npm ci builds need no extra downloads.
async function copyNotices() {
  const destination = path.join(root, 'dist', 'licenses')
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  await cp(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(destination, 'THIRD_PARTY_NOTICES.md'))
  if (await exists(path.join(root, 'LICENSE'))) await cp(path.join(root, 'LICENSE'), path.join(destination, 'CARTOGRAPHER-LICENSE'))
  for (const filename of ['LICENSE', 'OpenFreeMap-Dark-LICENSE.md']) {
    await mkdir(path.join(destination, 'titanium'), { recursive: true })
    await cp(path.join(root, 'src', 'vendor', 'titanium', filename), path.join(destination, 'titanium', filename))
  }

  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
  const packages = []
  for (const [relative, locked] of Object.entries(lock.packages).sort(([left], [right]) => left.localeCompare(right))) {
    // Tailwind's generated CSS is included in the client although its npm
    // package is a build-time dependency.
    if (!relative || ((locked.dev || locked.devOptional) && relative !== 'node_modules/tailwindcss')) continue
    const directory = path.join(root, relative)
    if (!await exists(directory)) {
      if (locked.optional) continue // Platform-specific optional dependency.
      throw new Error(`Missing installed dependency ${relative}; run npm ci first.`)
    }
    const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
    const target = path.join(destination, 'npm', relative.replace(/^node_modules\//, ''))
    const entries = await readdir(directory)
    const files = entries.filter(name => /^(licen[cs]e|notice|copying|copyright)([._-]|$)/i.test(name))
    // Some npm tarballs publish their license only in README or source headers.
    if (!files.length) files.push(...entries.filter(name => /^readme([._-]|$)/i.test(name)))
    if (metadata.name === 'mersenne-twister') files.push('src/mersenne-twister.js')
    for (const filename of files.sort()) {
      await mkdir(path.dirname(path.join(target, filename)), { recursive: true })
      await cp(path.join(directory, filename), path.join(target, filename), { recursive: true })
    }
    packages.push({ name: metadata.name, version: metadata.version, license: metadata.license ?? locked.license ?? 'See upstream notices', files: files.map(filename => path.relative(destination, path.join(target, filename)).split(path.sep).join('/')) })
  }
  await writeFile(path.join(destination, 'npm-packages.json'), `${JSON.stringify(packages, null, 2)}\n`)
  await writeFile(path.join(destination, 'README.txt'), 'Third-party license archive\n\nOriginal npm package license and notice files are copied without modification.\nThe exact locked production dependency inventory is in npm-packages.json.\nCesium LICENSE.md also includes its bundled third-party and asset notices.\nSome packages publish license notices in README or source headers; those files are included.\nAdditional copied-source notices and remote map/service terms are in THIRD_PARTY_NOTICES.md.\nThis archive does not relicense dependencies, fonts, map data, or remote imagery.\n')
  console.log(`Copied third-party notices for ${packages.length} installed client dependencies to dist/licenses/.`)
}

if (process.argv.includes('--notices-only')) {
  await copyNotices()
  process.exit(0)
}

run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'])
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
// An explicit allowlist keeps keys, MongoDB files and caches out of releases.
const files = ['dist', 'src', 'public', 'package.json', 'package-lock.json', 'index.html',
  'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'postcss.config.js', 'tailwind.config.js', 'components.json', 'scripts',
  'Dockerfile', 'docker-compose.yaml', 'docker-compose.local.yaml', '.dockerignore', '.gitignore', '.env.example', 'README.md', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'CONTRIBUTING.md',
  'docs', 'backend/cartographer', 'backend/tests', 'backend/pyproject.toml', 'backend/uv.lock', 'backend/README.md', 'backend/.env.example']
for (const relative of files) {
  const source = path.join(root, relative)
  await mkdir(path.dirname(path.join(output, relative)), { recursive: true })
  await cp(source, path.join(output, relative), { recursive: true, filter: candidate => !candidate.split(path.sep).includes('__pycache__') && !candidate.endsWith('.pyc') })
}
if (await exists(path.join(root, 'LICENSE'))) await cp(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'))
await writeFile(path.join(output, 'RELEASE.txt'), 'Cartographer deployment bundle\n\nSee docs/deployment.md for Coolify and Docker Compose setup.\nThe compiled client is in dist/. Backend source and its locked uv dependencies are in backend/.\nNo API keys, database files, dependencies, or image caches are included.\nProvide credentials at runtime through .env or Coolify environment variables.\n')
run('tar', ['-czf', archive, '-C', build, 'cartographer'])
console.log(`\nDeployment folder: ${output}\nDeployment archive: ${archive}`)
