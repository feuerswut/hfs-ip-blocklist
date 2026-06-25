'use strict'
const path = require('path')
const fsSync = require('fs')

// Roaring binaries live next to plugin.js in a 'roaring/' folder,
// placed there by the platform-specific dist-PLATFORM-ARCH/ at install time.
const roaringBaseDir = path.join(__dirname, '..', 'roaring')

let cached = undefined  // null = tried and failed, class = success

function detectLibc() {
    if (process.platform !== 'linux') return 'unknown'
    try {
        // musl libc shows up in /proc/self/maps as "musl"
        const maps = fsSync.readFileSync('/proc/self/maps', 'utf8')
        if (maps.includes('musl')) return 'musl'
    } catch (_) {}
    return 'glibc'
}

function loadRoaring() {
    if (cached !== undefined) return cached

    const abi = process.versions.modules
    const platform = process.platform
    const arch = process.arch
    const libc = detectLibc()

    const binaryDir = `roaring-node-v${abi}-${platform}-${arch}-${libc}`
    const binaryPath = path.join(roaringBaseDir, binaryDir, 'roaring.node')

    try {
        if (!fsSync.existsSync(binaryPath)) {
            cached = null
            return null
        }
        const addon = require(binaryPath)
        // The .node addon may export { RoaringBitmap32 } or the class directly
        const RoaringBitmap32 = (addon && addon.RoaringBitmap32) ? addon.RoaringBitmap32 : addon
        if (typeof RoaringBitmap32 !== 'function') {
            cached = null
            return null
        }
        cached = RoaringBitmap32
        return cached
    } catch (_) {
        cached = null
        return null
    }
}

module.exports = { loadRoaring }
