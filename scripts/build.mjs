// 构建脚本：esbuild 多入口 IIFE 打包 + 静态资源复制到 dist/
// 用法：node scripts/build.mjs [--watch]
import { build } from 'esbuild'
import { cpSync, mkdirSync, readFileSync } from 'node:fs'

const WATCH = process.argv.includes('--watch')

const ENTRIES = {
  'js/background.js': 'src/background/background.ts',
  'js/grabber.js': 'src/grabber/grabber.ts',
  'js/content.js': 'src/content/image-scanner.ts',
}

const STATIC_FILES = [
  'manifest.json',
  'src/grabber/grabber.html',
  'src/grabber/grabber.css',
  'src/assets/icons',
]

function reportVersion() {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'))
  console.log(`[build] 当前版本: v${manifest.version}`)
}

function copyStatic() {
  mkdirSync('dist', { recursive: true })
  for (const file of STATIC_FILES) {
    const target = `dist/${file.split('/').pop()}`
    cpSync(file, target, { recursive: true })
    console.log(`[build] copied ${file} -> ${target}`)
  }
}

async function buildAll() {
  copyStatic()
  // 构建时间戳：注入 __BUILD_TIME__（格式 yyyymmddHHMMSS），grabber 右下角显示以确认版本
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const buildTime = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const options = {
    bundle: true,
    format: 'iife',
    target: 'chrome110',
    sourcemap: true,
    logLevel: 'info',
    define: { __BUILD_TIME__: JSON.stringify(buildTime) },
  }
  if (WATCH) {
    options.watch = {
      onRebuild: (err) => {
        if (err) console.error('[build] rebuild failed', err)
        else { console.log('[build] rebuilt'); copyStatic(); reportVersion() }
      },
    }
  }
  const tasks = Object.entries(ENTRIES).map(([outfile, entry]) =>
    build({ ...options, entryPoints: [entry], outfile: `dist/${outfile}` }),
  )
  await Promise.all(tasks)
  if (WATCH) {
    console.log('[build] watching...')
  } else {
    console.log('[build] done')
  }
  reportVersion()
}

buildAll().catch((err) => {
  console.error('[build] failed', err)
  process.exit(1)
})
