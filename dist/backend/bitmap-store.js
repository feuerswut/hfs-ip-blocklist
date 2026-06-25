'use strict'
// Loads the roaring bitmap (or fallback sorted-range binary) into RAM once and
// serves O(1) IPv4 lookups. IPv6 uses a tiny sorted-BigInt array + binary search.
const fs = require('fs').promises
const fsSync = require('fs')
const path = require('path')
const { loadRoaring } = require('./roaring-loader')
const utils = require('./utils')

class BitmapStore {
    constructor(storageDir, debug) {
        this.storageDir = storageDir
        this.debug = debug || (() => {})
        this.bitmap = null          // RoaringBitmap32 (IPv4, O(1))
        this.ipv4Ranges = null      // sorted ranges array (fallback, O(log n))
        this.ipv6Ranges = null      // sorted BigInt range array
        this.requestTimeoutMs = 30
        this.ready = false
    }

    async load() {
        try {
            const metaPath = path.join(this.storageDir, 'meta.json')
            if (!fsSync.existsSync(metaPath)) return false

            const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
            this.requestTimeoutMs = meta.requestTimeoutMs || 30

            if (meta.format === 'roaring') {
                const ok = await this._loadRoaring()
                if (!ok) {
                    // Roaring binary missing or ABI mismatch — try ranges fallback
                    this.debug('Falling back to sorted-ranges lookup')
                    if (!await this._loadRanges()) return false
                }
            } else {
                if (!await this._loadRanges()) return false
            }

            await this._loadIPv6()
            this.ready = true
            return true

        } catch (err) {
            this.debug(`BitmapStore load error: ${err.message}`)
            return false
        }
    }

    async _loadRoaring() {
        const roarPath = path.join(this.storageDir, 'ipv4.roar')
        if (!fsSync.existsSync(roarPath)) return false
        const RoaringBitmap32 = loadRoaring()
        if (!RoaringBitmap32) return false
        try {
            const buf = await fs.readFile(roarPath)
            this.bitmap = RoaringBitmap32.deserialize(buf, false)
            this.debug(`IPv4 bitmap loaded (${(buf.length / 1024 / 1024).toFixed(1)} MB in RAM)`)
            return true
        } catch (err) {
            this.debug(`Roaring deserialize failed: ${err.message}`)
            return false
        }
    }

    async _loadRanges() {
        const rangesPath = path.join(this.storageDir, 'ipv4-ranges.bin')
        if (!fsSync.existsSync(rangesPath)) return false
        const buf = await fs.readFile(rangesPath)
        const count = buf.length / 8
        this.ipv4Ranges = new Array(count)
        for (let i = 0; i < count; i++) {
            this.ipv4Ranges[i] = {
                start: buf.readUInt32BE(i * 8),
                end: buf.readUInt32BE(i * 8 + 4)
            }
        }
        this.debug(`IPv4 ranges loaded (${count} merged ranges, binary-search fallback)`)
        return true
    }

    async _loadIPv6() {
        const p = path.join(this.storageDir, 'ipv6.bin')
        if (!fsSync.existsSync(p)) return
        const buf = await fs.readFile(p)
        const count = buf.length / 32
        this.ipv6Ranges = new Array(count)
        for (let i = 0; i < count; i++) {
            this.ipv6Ranges[i] = {
                start: readBigInt128(buf, i * 32),
                end: readBigInt128(buf, i * 32 + 16)
            }
        }
        this.debug(`IPv6 ranges loaded: ${count}`)
    }

    // ── Public API ────────────────────────────────────────────────────────────

    checkIP(ip) {
        if (!this.ready) return { blocked: false }
        try {
            if (ip.includes(':')) return this._checkIPv6(ip)
            return this._checkIPv4(ip)
        } catch (err) {
            return { blocked: false, error: err.message }
        }
    }

    _checkIPv4(ip) {
        const ipLong = utils.ip2long(ip)
        if (ipLong === null) return { blocked: false, error: 'Invalid IP' }
        if (utils.isLocalIP(ipLong)) return { blocked: false, local: true }

        if (this.bitmap) return { blocked: this.bitmap.has(ipLong) }
        if (this.ipv4Ranges) return { blocked: binarySearchRanges(this.ipv4Ranges, ipLong) }
        return { blocked: false }
    }

    _checkIPv6(ip) {
        // Handle IPv4-mapped ::ffff:x.x.x.x → treat as IPv4
        const v4m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
        if (v4m) return this._checkIPv4(v4m[1])

        if (!this.ipv6Ranges || this.ipv6Ranges.length === 0) return { blocked: false }
        const addr = utils.ipv6ToBigInt(ip)
        if (addr === null) return { blocked: false, error: 'Invalid IPv6' }
        if (utils.isLocalIPv6(addr)) return { blocked: false, local: true }
        return { blocked: binarySearchBigInt(this.ipv6Ranges, addr) }
    }

    cleanup() {
        this.bitmap = null
        this.ipv4Ranges = null
        this.ipv6Ranges = null
        this.ready = false
    }

    getMemoryUsageMB() {
        let bytes = 0
        if (this.ipv4Ranges) bytes += this.ipv4Ranges.length * 16
        if (this.ipv6Ranges) bytes += this.ipv6Ranges.length * 32
        // roaring bitmap memory is in C++ heap; not counted here
        return bytes / 1024 / 1024
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function binarySearchRanges(ranges, ipLong) {
    let lo = 0, hi = ranges.length - 1
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1
        const r = ranges[mid]
        if (ipLong >= r.start && ipLong <= r.end) return true
        if (ipLong < r.start) hi = mid - 1
        else lo = mid + 1
    }
    return false
}

function binarySearchBigInt(ranges, addr) {
    let lo = 0, hi = ranges.length - 1
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1
        const r = ranges[mid]
        if (addr >= r.start && addr <= r.end) return true
        if (addr < r.start) hi = mid - 1
        else lo = mid + 1
    }
    return false
}

function readBigInt128(buf, offset) {
    let v = 0n
    for (let i = 0; i < 16; i++) v = (v << 8n) | BigInt(buf[offset + i])
    return v
}

module.exports = BitmapStore
