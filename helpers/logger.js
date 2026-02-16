const fs = require('fs')
const path = require('path')

// ── Config ──────────────────────────────────────────────
const LOG_DIR = path.join(__dirname, '..', 'logs')
const MAX_FILE_SIZE_MB = 10
const MAX_FILES = 48 // keep ~2 days of hourly files

// ── State: per-pair dedup ───────────────────────────────
const lastLogged = {} // key: pair → { spread, direction, ts }
const DEDUP_SPREAD_DELTA = 0.03
const DEDUP_COOLDOWN_MS = 10_000

// ── Observability counters ──────────────────────────────
const stats = {
  startedAt: Date.now(),
  swapsDetected: 0,
  spreadsAboveThreshold: 0,
  insaneSpreadsSkipped: 0,
  opportunitiesLogged: 0,
  opportunitiesSuppressed: 0,
  errors: 0,
  lastReportAt: Date.now()
}

// ── Ensure log dir exists ───────────────────────────────
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
}

// ── Hourly file rotation ────────────────────────────────
function getLogFilePath() {
  const now = new Date()
  const stamp = now.toISOString().slice(0, 13).replace(/[:-]/g, '') // 20260211T14
  return path.join(LOG_DIR, `paper_trades_${stamp}.jsonl`)
}

function pruneOldFiles() {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('paper_trades_') && f.endsWith('.jsonl'))
      .sort()

    while (files.length > MAX_FILES) {
      const oldest = files.shift()
      fs.unlinkSync(path.join(LOG_DIR, oldest))
    }
  } catch (_) { /* non-critical */ }
}

// ── Shared spread resolver ──────────────────────────────
function resolveSpread(data) {
  return parseFloat(data.spread || data.netProfit || data.price || 0)
}

// ── Dedup check ─────────────────────────────────────────
function shouldLog(data) {
  const key = data.pair || 'unknown'
  const prev = lastLogged[key]
  const now = Date.now()

  if (!prev) return true
  if (prev.direction !== data.buyDex) return true
  if (now - prev.ts < DEDUP_COOLDOWN_MS) return false

  const spreadNow = resolveSpread(data)
  if (Math.abs(spreadNow - prev.spread) < DEDUP_SPREAD_DELTA) return false

  return true
}

function updateLastLogged(data) {
  const key = data.pair || 'unknown'
  lastLogged[key] = {
    spread: resolveSpread(data),
    direction: data.buyDex || null,
    ts: Date.now()
  }
}

// ── Public API ──────────────────────────────────────────

/**
 * Log a paper-trade opportunity.
 * Deduplicates, rotates hourly, prunes old files.
 * @returns {boolean} true if logged, false if suppressed.
 */
function logOpportunity(data) {
  if (!shouldLog(data)) {
    stats.opportunitiesSuppressed++
    return false
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    ...data
  }

  const filePath = getLogFilePath()

  try {
    // Size guard
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath)
      if (stat.size > MAX_FILE_SIZE_MB * 1024 * 1024) return false
    }

    // Async write — don't block the event loop
    fs.appendFile(filePath, JSON.stringify(logEntry) + '\n', (err) => {
      if (err) {
        stats.errors++
        console.error('⚠️ Logger write error:', err.message)
      }
    })

    updateLastLogged(data)
    stats.opportunitiesLogged++

    if (Math.random() < 0.01) pruneOldFiles()

    return true
  } catch (err) {
    stats.errors++
    console.error('⚠️ Logger error:', err.message)
    return false
  }
}

/** Increment a named stat counter. */
function recordStat(key) {
  if (key in stats) stats[key]++
}

/** Print activity summary since last report. */
function printStats() {
  const uptimeMin = ((Date.now() - stats.startedAt) / 60_000).toFixed(1)
  const sinceLast = ((Date.now() - stats.lastReportAt) / 60_000).toFixed(1)

  console.log(`\n📊 ── Stats (uptime ${uptimeMin}m, window ${sinceLast}m) ──`)
  console.log(`  Swaps detected:        ${stats.swapsDetected}`)
  console.log(`  Spreads > threshold:   ${stats.spreadsAboveThreshold}`)
  console.log(`  Insane spreads skipped: ${stats.insaneSpreadsSkipped}`)
  console.log(`  Opportunities logged:  ${stats.opportunitiesLogged}`)
  console.log(`  Opportunities deduped: ${stats.opportunitiesSuppressed}`)
  console.log(`  Errors:                ${stats.errors}`)
  console.log(`──────────────────────────────────────────\n`)

  stats.lastReportAt = Date.now()
}

/** Get raw stats object. */
function getStats() {
  return { ...stats }
}

module.exports = {
  logOpportunity,
  recordStat,
  printStats,
  getStats
}
