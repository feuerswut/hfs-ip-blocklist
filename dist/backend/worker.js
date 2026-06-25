'use strict'
// Background thread: downloads/locates blocklist → builds roaring bitmap or
// sorted-range binary → writes to disk → signals main thread via 'ready'.
const { parentPort, workerData } = require('worker_threads')
const fs = require('fs').promises
const fsSync = require('fs')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const https = require('https')
const http = require('http')
const utils = require('./utils')
const { loadRoaring } = require('./roaring-loader')

const { storageDir, config } = workerData

function debug(msg) { parentPort.postMessage({ type: 'debug', msg }) }
function log(msg) { parentPort.postMessage({ type: 'log', msg }) }
function progress(phase, percent) { parentPort.postMessage({ type: 'progress', phase, percent }) }

// ─── Download ────────────────────────────────────────────────────────────────

function downloadToFile(url, destPath, timeoutMs) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http
        const req = client.get(url, { timeout: timeoutMs }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return downloadToFile(res.headers.location, destPath, timeoutMs)
                    .then(resolve).catch(reject)
            }
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))

            let downloaded = 0
            const total = parseInt(res.headers['content-length']) || 0
            let lastPercent = 0
            const out = fsSync.createWriteStream(destPath)

            res.on('data', chunk => {
                downloaded += chunk.length
                if (total > 0) {
                    const pct = Math.floor(downloaded / total * 100)
                    if (pct > lastPercent && pct % 10 === 0) {
                        progress('download', pct)
                        lastPercent = pct
                    }
                }
            })
            res.pipe(out)
            out.on('finish', () => { progress('download', 100); resolve() })
            out.on('error', reject)
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')) })
    })
}

function hashFileStream(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256')
        const s = fsSync.createReadStream(filePath)
        s.on('data', chunk => hash.update(chunk))
        s.on('end', () => resolve(hash.digest('hex')))
        s.on('error', reject)
    })
}

// ─── Advanced config (storage/config.json) ───────────────────────────────────

const ADVANCED_DEFAULTS = {
    minRangeSize: 1,
    ignoreSingleIPs: false,
    downloadTimeoutMs: 300000,
    retryAttempts: 3,
    retryDelayMs: 5000,
    sslVerify: true,
    requestTimeoutMs: 30,
    fallbackToBinarySearch: false
}

async function loadAdvancedConfig() {
    const configPath = path.join(storageDir, 'config.json')
    let user = {}

    try {
        if (fsSync.existsSync(configPath)) {
            const raw = JSON.parse(await fs.readFile(configPath, 'utf8'))
            // Strip comment key
            const { _comment, ...rest } = raw
            user = rest
        }
    } catch (_) {}

    const merged = { ...ADVANCED_DEFAULTS, ...user }

    // Write (or refresh) the file so the user always has a template
    try {
        await fs.writeFile(configPath, JSON.stringify({
            _comment: 'Advanced settings — regenerated with defaults if deleted. Changes trigger a full rebuild.',
            ...merged
        }, null, 2))
    } catch (_) {}

    return merged
}

function stableHash(obj) {
    const keys = Object.keys(obj).sort()
    const ordered = {}
    for (const k of keys) ordered[k] = obj[k]
    return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

// ─── IPv4 bitmap / ranges helpers ────────────────────────────────────────────

function addIPv4Range(bitmap, start, end) {
    // addRange(begin, end) is exclusive-end in roaring
    if (end === 0xFFFFFFFF) {
        if (start < 0xFFFFFFFF) bitmap.addRange(start, 0xFFFFFFFF)
        bitmap.add(0xFFFFFFFF)
    } else {
        bitmap.addRange(start, end + 1)
    }
}

function writeBigInt128(buf, offset, value) {
    for (let i = 15; i >= 0; i--) {
        buf[offset + i] = Number(value & 0xFFn)
        value >>= 8n
    }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function processBlocklist() {
    const tempFile = path.join(storageDir, 'download.tmp')

    try {
        debug('Worker started')
        const t0 = Date.now()

        const adv = await loadAdvancedConfig()

        const roaring = loadRoaring()
        const useRoaring = roaring.cls !== null && !adv.fallbackToBinarySearch
        if (useRoaring) {
            log(`Roaring bitmap active [${roaring.source}] — O(1) IPv4 lookup`)
            debug(`Binary: ${roaring.detail}`)
        } else if (adv.fallbackToBinarySearch) {
            log('Roaring disabled by config (fallbackToBinarySearch=true) — using sorted-ranges binary search')
        } else {
            log(`WARNING: Roaring bitmap unavailable — falling back to sorted-ranges binary search (slower). ${roaring.detail}`)
        }
        const RoaringBitmap32 = roaring.cls

        // ── Source ──
        progress('download', 0)
        let sourceFile

        if (config.source === 'url') {
            if (!config.url) throw new Error('No URL configured')
            debug(`Downloading: ${config.url}`)
            await downloadToFile(config.url, tempFile, adv.downloadTimeoutMs)
            sourceFile = tempFile
        } else {
            if (!config.filePath) throw new Error('No file path configured')
            if (!fsSync.existsSync(config.filePath)) throw new Error(`File not found: ${config.filePath}`)
            sourceFile = config.filePath
            progress('download', 100)
        }

        // ── Change detection ──
        const sourceHash = await hashFileStream(sourceFile)
        const configHash = stableHash({ ...adv, enableIPv6: !!config.enableIPv6 })
        const metaFile = path.join(storageDir, 'meta.json')

        if (!config.forceReprocess && fsSync.existsSync(metaFile)) {
            try {
                const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'))
                if (meta.sourceHash === sourceHash && meta.configHash === configHash) {
                    debug('Unchanged — skipping rebuild')
                    if (config.source === 'url') await fs.unlink(tempFile).catch(() => {})
                    parentPort.postMessage({ type: 'ready', ...meta })
                    return
                }
            } catch (_) {}
        }

        // ── Parse ──
        progress('parsing', 0)
        debug('Parsing...')

        let bitmap = useRoaring ? new RoaringBitmap32() : null
        const ipv4RangesFallback = useRoaring ? null : []
        const ipv6Ranges = []
        let totalIPv4 = 0, totalIPv6 = 0, skipped = 0, singleIgnored = 0

        await new Promise((resolve, reject) => {
            const rl = readline.createInterface({
                input: fsSync.createReadStream(sourceFile, { encoding: 'utf8' }),
                crlfDelay: Infinity
            })

            rl.on('line', (line) => {
                const range = utils.parseIPRange(line)
                if (!range) { skipped++; return }

                if (range.isIPv6) {
                    if (!config.enableIPv6) { skipped++; return }
                    if (utils.isLocalIPv6(range.start) || utils.isLocalIPv6(range.end)) { skipped++; return }
                    ipv6Ranges.push(range)
                    totalIPv6++
                    return
                }

                // IPv4
                if (utils.isLocalIP(range.start) || utils.isLocalIP(range.end)) { skipped++; return }
                const size = range.end - range.start + 1
                if (adv.ignoreSingleIPs && size === 1) { singleIgnored++; return }
                if (size < adv.minRangeSize) { skipped++; return }

                if (useRoaring) {
                    addIPv4Range(bitmap, range.start, range.end)
                } else {
                    ipv4RangesFallback.push(range)
                }
                totalIPv4++
            })

            rl.on('close', resolve)
            rl.on('error', reject)
        })

        if (config.source === 'url') await fs.unlink(tempFile).catch(() => {})
        progress('parsing', 100)
        debug(`Parsed ${totalIPv4} IPv4, ${totalIPv6} IPv6 (skipped ${skipped}, ignored ${singleIgnored} singles)`)

        if (totalIPv4 === 0 && totalIPv6 === 0) throw new Error('No valid ranges found in blocklist')

        // ── Save IPv4 ──
        progress('saving', 0)
        let ipv4Bytes = 0
        let format = 'roaring'

        if (useRoaring) {
            bitmap.runOptimize()
            bitmap.shrinkToFit()
            const serialized = bitmap.serialize(false)
            bitmap = null

            const tmp = path.join(storageDir, 'ipv4.roar.tmp')
            await fs.writeFile(tmp, serialized)
            await fs.rename(tmp, path.join(storageDir, 'ipv4.roar'))
            ipv4Bytes = serialized.length
            format = 'roaring'
        } else {
            // Sort + merge then write as flat 8-byte records
            ipv4RangesFallback.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0)
            const merged = [ipv4RangesFallback[0]]
            for (let i = 1; i < ipv4RangesFallback.length; i++) {
                const cur = ipv4RangesFallback[i], last = merged[merged.length - 1]
                if (cur.start <= last.end + 1) { if (cur.end > last.end) last.end = cur.end }
                else merged.push(cur)
            }
            ipv4RangesFallback.length = 0

            const buf = Buffer.allocUnsafe(merged.length * 8)
            for (let i = 0; i < merged.length; i++) {
                buf.writeUInt32BE(merged[i].start >>> 0, i * 8)
                buf.writeUInt32BE(merged[i].end >>> 0, i * 8 + 4)
            }
            const tmp = path.join(storageDir, 'ipv4-ranges.bin.tmp')
            await fs.writeFile(tmp, buf)
            await fs.rename(tmp, path.join(storageDir, 'ipv4-ranges.bin'))
            ipv4Bytes = buf.length
            format = 'ranges'
        }

        // ── Save IPv6 ──
        let ipv6Bytes = 0
        if (config.enableIPv6 && ipv6Ranges.length > 0) {
            ipv6Ranges.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0)
            const merged6 = [ipv6Ranges[0]]
            for (let i = 1; i < ipv6Ranges.length; i++) {
                const cur = ipv6Ranges[i], last = merged6[merged6.length - 1]
                if (cur.start <= last.end + 1n) { if (cur.end > last.end) last.end = cur.end }
                else merged6.push(cur)
            }
            ipv6Ranges.length = 0

            const buf6 = Buffer.allocUnsafe(merged6.length * 32)
            for (let i = 0; i < merged6.length; i++) {
                writeBigInt128(buf6, i * 32, merged6[i].start)
                writeBigInt128(buf6, i * 32 + 16, merged6[i].end)
            }
            const tmp6 = path.join(storageDir, 'ipv6.bin.tmp')
            await fs.writeFile(tmp6, buf6)
            await fs.rename(tmp6, path.join(storageDir, 'ipv6.bin'))
            ipv6Bytes = buf6.length
        }

        progress('saving', 100)

        const meta = {
            format,
            sourceHash,
            configHash,
            totalRanges: totalIPv4,
            totalIPv6Ranges: totalIPv6,
            diskUsageMB: ((ipv4Bytes + ipv6Bytes) / 1024 / 1024).toFixed(2),
            processTime: ((Date.now() - t0) / 1000).toFixed(1)
        }

        await fs.writeFile(metaFile, JSON.stringify(meta, null, 2))
        debug(`Done in ${meta.processTime}s — ${meta.diskUsageMB} MB on disk`)
        parentPort.postMessage({ type: 'ready', ...meta })

    } catch (error) {
        if (config.source === 'url') {
            try { fsSync.unlinkSync(tempFile) } catch (_) {}
        }
        parentPort.postMessage({ type: 'error', error: error.message, stack: error.stack })
    }
}

processBlocklist()
