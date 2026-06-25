'use strict'
const path = require('path')
const fsSync = require('fs')

// Priority 1: prebuilt .node binaries shipped in roaring/ (placed by dist-PLATFORM-ARCH/).
// Priority 2: npm-compiled binary in build/node_modules/roaring (from running setup.sh).
// Priority 3: null → worker falls back to sorted-ranges + binary search.
const roaringBaseDir = path.join(__dirname, '..', 'roaring')
const roaringNpmDir = path.join(__dirname, '..', 'build', 'node_modules', 'roaring')

function detectLibc() {
    if (process.platform !== 'linux') return 'unknown'
    try {
        // musl libc shows up in /proc/self/maps as "musl"
        const maps = fsSync.readFileSync('/proc/self/maps', 'utf8')
        if (maps.includes('musl')) return 'musl'
    } catch (_) {}
    return 'glibc'
}

function extractClass(addon) {
    if (!addon) return null
    const cls = addon.RoaringBitmap32 || addon
    return typeof cls === 'function' ? cls : null
}

// Returns { cls: RoaringBitmap32|null, source: 'prebuilt'|'npm'|null, detail: string }
// Result is cached after the first call.
let cachedResult = undefined

function loadRoaring() {
    if (cachedResult !== undefined) return cachedResult

    // ── 1. Prebuilt binary ──────────────────────────────────────────────────
    const abi = process.versions.modules
    const platform = process.platform
    const arch = process.arch
    const libc = detectLibc()

    const binaryDir = `roaring-node-v${abi}-${platform}-${arch}-${libc}`
    const binaryPath = path.join(roaringBaseDir, binaryDir, 'roaring.node')

    try {
        if (fsSync.existsSync(binaryPath)) {
            const cls = extractClass(require(binaryPath))
            if (cls) {
                cachedResult = { cls, source: 'prebuilt', detail: binaryDir }
                return cachedResult
            }
        }
    } catch (err) {
        // prebuilt found but failed to load (ABI mismatch, corrupt file, etc.)
        cachedResult = {
            cls: null, source: null,
            detail: `Prebuilt found but failed to load (${binaryDir}): ${err.message}. Run setup.sh to compile from source.`
        }
        // don't return yet — fall through to try npm build
    }

    // ── 2. npm-compiled fallback (setup.sh) ─────────────────────────────────
    try {
        const npmEntry = path.join(roaringNpmDir, 'RoaringBitmap32.js')
        if (fsSync.existsSync(npmEntry)) {
            const cls = extractClass(require(npmEntry))
            if (cls) {
                cachedResult = { cls, source: 'npm', detail: roaringNpmDir }
                return cachedResult
            }
        }
    } catch (err) {
        cachedResult = {
            cls: null, source: null,
            detail: `npm build found but failed to load: ${err.message}`
        }
        return cachedResult
    }

    // ── 3. Nothing available ────────────────────────────────────────────────
    const prebuiltExists = fsSync.existsSync(binaryPath)
    cachedResult = {
        cls: null, source: null,
        detail: prebuiltExists
            ? `Prebuilt binary exists but could not be loaded (${binaryDir}). Run setup.sh to compile from source.`
            : `No prebuilt for ${binaryDir} and setup.sh has not been run. Using sorted-ranges fallback (binary search).`
    }
    return cachedResult
}

module.exports = { loadRoaring }
