#!/usr/bin/env node
'use strict'
/**
 * supervise.js — start ComfyUI on demand, stop it after an idle period.
 *
 * Spawned detached by dsh-comfyui-supervisor. Kept dependency-free on purpose (Node 20+).
 *
 * Usage:
 *   node supervise.js [--root D:\ComfyUI] [--port 8188] [--idle-min 30] [--start-timeout 300]
 *
 * State files (both removed on exit):
 *   <root>/.supervisor.lock   single-instance lock   { pid, startedAt }
 *   <root>/.supervisor.state  managed processes      { supervisorPid, comfyPid, port, startedAt, idleMin }
 */
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}

const ROOT = path.resolve(arg('--root', 'D:\\ComfyUI'))
const PORT = Number(arg('--port', '8188')) || 8188
const IDLE_MIN = Math.max(1, Number(arg('--idle-min', '30')) || 30)
const START_TIMEOUT_MS = Math.max(30, Number(arg('--start-timeout', '300'))) * 1000
const BASE = 'http://127.0.0.1:' + PORT

const PORTABLE = path.join(ROOT, 'ComfyUI_windows_portable')
const PYTHON = path.join(PORTABLE, 'python_embeded', 'python.exe')
const MAIN = path.join(PORTABLE, 'ComfyUI', 'main.py')
const LOGS = path.join(ROOT, 'logs')
const LOCK = path.join(ROOT, '.supervisor.lock')
const STATE = path.join(ROOT, '.supervisor.state')
fs.mkdirSync(LOGS, { recursive: true })

const stamp = new Date().toISOString().slice(0, 10)
const logFile = path.join(LOGS, 'supervisor-' + stamp + '.log')
const log = (...parts) => {
  const line = '[' + new Date().toISOString() + '] ' + parts.join(' ')
  try { fs.appendFileSync(logFile, line + '\n') } catch (_) {}
}

async function probe(timeout = 2500) {
  try {
    const r = await fetch(BASE + '/system_stats', { signal: AbortSignal.timeout(timeout) })
    return r.ok
  } catch (_) {
    return false
  }
}

let child = null
let stopping = false

function cleanupFiles() {
  for (const file of [LOCK, STATE]) {
    try { fs.unlinkSync(file) } catch (_) {}
  }
}

function stopComfy(reason) {
  if (stopping) return
  stopping = true
  log('stopping ComfyUI: ' + reason)
  if (child && child.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 })
    } catch (_) {}
  }
  cleanupFiles()
  process.exit(0)
}

function acquireLock() {
  try {
    if (fs.existsSync(LOCK)) {
      const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
      if (cur && cur.pid) {
        let alive = false
        try { process.kill(cur.pid, 0); alive = true } catch (_) {}
        if (alive) {
          log('another supervisor is alive (pid ' + cur.pid + '), exit')
          process.exit(0)
        }
      }
    }
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
  } catch (e) {
    log('lock error: ' + e.message)
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  if (await probe()) {
    log('ComfyUI already running on ' + BASE + ', nothing to do')
    process.exit(0)
  }
  acquireLock()

  if (!fs.existsSync(PYTHON) || !fs.existsSync(MAIN)) {
    log('FATAL: python or main.py not found under ' + PORTABLE)
    cleanupFiles()
    process.exit(1)
  }

  const out = fs.openSync(path.join(LOGS, 'comfyui-' + stamp + '.log'), 'a')
  child = spawn(PYTHON, ['-s', MAIN, '--listen', '127.0.0.1', '--port', String(PORT), '--disable-auto-launch'], {
    cwd: PORTABLE,
    windowsHide: true,
    stdio: ['ignore', out, out]
  })
  try {
    fs.writeFileSync(STATE, JSON.stringify({
      supervisorPid: process.pid,
      comfyPid: child.pid,
      port: PORT,
      root: ROOT,
      startedAt: Date.now(),
      idleMin: IDLE_MIN
    }))
  } catch (_) {}
  log('spawned ComfyUI pid ' + child.pid)

  child.on('exit', (code, signal) => {
    log('ComfyUI exited (code=' + code + ', signal=' + signal + ')')
    cleanupFiles()
    process.exit(0)
  })

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await probe()) break
    await wait(2000)
  }
  if (!(await probe())) {
    log('ComfyUI did not become ready within ' + Math.round(START_TIMEOUT_MS / 1000) + 's')
    stopComfy('start timeout')
  }
  log('ComfyUI ready; idle timeout ' + IDLE_MIN + ' min')

  let lastActivity = Date.now()
  let lastHistoryKey = null

  setInterval(async () => {
    let active = false
    try {
      const q = await (await fetch(BASE + '/queue', { signal: AbortSignal.timeout(3000) })).json()
      active = (q.queue_running || []).length > 0 || (q.queue_pending || []).length > 0
      const h = await (await fetch(BASE + '/history?max_items=1', { signal: AbortSignal.timeout(3000) })).json()
      const key = Object.keys(h || {})[0] || null
      if (key !== lastHistoryKey) {
        lastHistoryKey = key
        active = true
      }
    } catch (_) {
      return
    }
    if (active) {
      lastActivity = Date.now()
      return
    }
    const idleMs = Date.now() - lastActivity
    if (idleMs > IDLE_MIN * 60 * 1000) stopComfy('idle for ' + Math.round(idleMs / 60000) + ' min')
  }, 15000)
}

process.on('SIGINT', () => stopComfy('SIGINT'))
process.on('SIGTERM', () => stopComfy('SIGTERM'))

main().catch((e) => {
  log('FATAL ' + (e && e.message))
  stopComfy('fatal error')
})
