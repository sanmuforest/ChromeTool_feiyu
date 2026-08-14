// 版本递增脚本：v0.1.NNN → v0.1.(NNN+1)，同步 manifest.json 与 package.json
// 用法：node scripts/bump-version.mjs（或 npm run bump）
// 版本规则：v0.1.001 起步，每轮功能更新后执行一次，末位 +1（001 → 002 → 003 ...）
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(p) {
  return JSON.parse(readFileSync(join(root, p), 'utf8'))
}
function writeJson(p, obj) {
  writeFileSync(join(root, p), JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

const manifest = readJson('manifest.json')
const pkg = readJson('package.json')

const parts = String(manifest.version).split('.')
const lastPart = parts[parts.length - 1]
const last = parseInt(lastPart, 10)
if (Number.isNaN(last)) {
  console.error(`[bump] 无法解析版本末位: ${manifest.version}`)
  process.exit(1)
}

const oldVersion = manifest.version
parts[parts.length - 1] = String(last + 1).padStart(lastPart.length, '0')
const nextVersion = parts.join('.')

manifest.version = nextVersion
pkg.version = nextVersion
writeJson('manifest.json', manifest)
writeJson('package.json', pkg)
console.log(`[bump] ${oldVersion} -> ${nextVersion}`)
