'use strict'

// ─── IPv4 ───────────────────────────────────────────────────────────────────

function ip2long(ip) {
    const parts = ip.split('.')
    if (parts.length !== 4) return null
    const nums = parts.map(p => parseInt(p, 10))
    if (nums.some(n => isNaN(n) || n < 0 || n > 255)) return null
    return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0
}

function isLocalIP(ipLong) {
    return (
        ipLong === 0 ||                                          // 0.0.0.0
        (ipLong >= 0x0A000000 && ipLong <= 0x0AFFFFFF) ||       // 10.0.0.0/8
        (ipLong >= 0x7F000000 && ipLong <= 0x7FFFFFFF) ||       // 127.0.0.0/8
        (ipLong >= 0xA9FE0000 && ipLong <= 0xA9FEFFFF) ||       // 169.254.0.0/16
        (ipLong >= 0xAC100000 && ipLong <= 0xAC1FFFFF) ||       // 172.16.0.0/12
        (ipLong >= 0xC0A80000 && ipLong <= 0xC0A8FFFF) ||       // 192.168.0.0/16
        (ipLong >= 0xE0000000 && ipLong <= 0xEFFFFFFF) ||       // 224.0.0.0/4 multicast
        (ipLong >= 0xF0000000 && ipLong <= 0xFFFFFFFF)          // 240.0.0.0/4 reserved
    )
}

// ─── IPv6 ───────────────────────────────────────────────────────────────────

// Returns 128-bit BigInt or null on parse error.
function ipv6ToBigInt(ip) {
    try {
        ip = ip.trim()

        // IPv4-mapped: ::ffff:1.2.3.4
        const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
        if (v4mapped) {
            const v4 = ip2long(v4mapped[1])
            if (v4 === null) return null
            return (0xFFFFn << 32n) | BigInt(v4)
        }

        // Expand :: shorthand
        let expanded = ip
        if (ip.includes('::')) {
            const parts = ip.split('::')
            if (parts.length !== 2) return null
            const left = parts[0] ? parts[0].split(':') : []
            const right = parts[1] ? parts[1].split(':') : []
            const missing = 8 - left.length - right.length
            if (missing < 0) return null
            expanded = [...left, ...Array(missing).fill('0'), ...right].join(':')
        }

        const groups = expanded.split(':')
        if (groups.length !== 8) return null

        let result = 0n
        for (const g of groups) {
            const val = parseInt(g || '0', 16)
            if (isNaN(val) || val < 0 || val > 0xFFFF) return null
            result = (result << 16n) | BigInt(val)
        }
        return result
    } catch (_) {
        return null
    }
}

function isLocalIPv6(addr) {
    if (addr === 1n) return true                        // ::1 loopback
    if ((addr >> 118n) === 0x3FAn) return true          // fe80::/10 link-local  (top 10 bits = 1111111010)
    if ((addr >> 121n) === 0x7En) return true           // fc00::/7 unique local  (top 7 bits = 1111110)
    if ((addr >> 32n) === 0xFFFFn) {                    // ::ffff:0:0/96 IPv4-mapped
        return isLocalIP(Number(addr & 0xFFFFFFFFn))
    }
    return false
}

// ─── Range parsing ──────────────────────────────────────────────────────────

// Returns { start, end, isIPv6 } or null.
// IPv4: start/end are unsigned 32-bit numbers.
// IPv6: start/end are BigInts (128-bit).
function parseIPRange(line) {
    line = line.trim()
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) return null

    try {
        // CIDR notation
        if (line.includes('/')) {
            const slashIdx = line.lastIndexOf('/')
            const ipPart = line.slice(0, slashIdx).trim()
            const bits = parseInt(line.slice(slashIdx + 1), 10)

            if (ipPart.includes(':')) {
                return parseIPv6CIDR(ipPart, bits)
            }
            const ipLong = ip2long(ipPart)
            if (ipLong === null || isNaN(bits) || bits < 0 || bits > 32) return null
            const hostBits = 32 - bits
            const start = (ipLong >>> hostBits) << hostBits
            const end = (start + Math.pow(2, hostBits) - 1) >>> 0
            return { start, end, isIPv6: false }
        }

        // Range notation — find the dash that separates two IPs
        if (line.includes('-')) {
            const isIPv6Range = line.includes(':')
            let dashIdx
            if (isIPv6Range) {
                // e.g. 2001::1-2001::ff — last ':' is in the first address;
                // the separating dash is the one NOT preceded by a hex group boundary.
                // Safest: find '-' that is NOT surrounded by hex digits on both sides.
                // Since IPv6 groups are hex and dashes don't appear inside groups, the
                // range dash is the one that has a colon or digit to its left and a
                // colon or digit to its right (same as IPv4), but the key is that
                // after the dash we see another IPv6 address.
                // Simple heuristic: last occurrence of '-' not inside brackets.
                dashIdx = line.indexOf('-', line.lastIndexOf(':') + 1)
            } else {
                dashIdx = line.indexOf('-')
            }

            if (dashIdx === -1) return null
            const startStr = line.slice(0, dashIdx).trim()
            const endStr = line.slice(dashIdx + 1).trim()

            if (startStr.includes(':')) {
                const start = ipv6ToBigInt(startStr)
                const end = ipv6ToBigInt(endStr)
                if (start === null || end === null || start > end) return null
                return { start, end, isIPv6: true }
            }
            const start = ip2long(startStr)
            const end = ip2long(endStr)
            if (start === null || end === null || start > end) return null
            return { start, end, isIPv6: false }
        }

        // Single address
        if (line.includes(':')) {
            const addr = ipv6ToBigInt(line)
            if (addr === null) return null
            return { start: addr, end: addr, isIPv6: true }
        }
        const ipLong = ip2long(line)
        if (ipLong === null) return null
        return { start: ipLong, end: ipLong, isIPv6: false }

    } catch (_) {
        return null
    }
}

function parseIPv6CIDR(ip, bits) {
    if (isNaN(bits) || bits < 0 || bits > 128) return null
    const addr = ipv6ToBigInt(ip)
    if (addr === null) return null
    if (bits === 0) return { start: 0n, end: (1n << 128n) - 1n, isIPv6: true }
    const hostBits = BigInt(128 - bits)
    const mask = ((1n << BigInt(bits)) - 1n) << hostBits
    const start = addr & mask
    const end = start | ((1n << hostBits) - 1n)
    return { start, end, isIPv6: true }
}

module.exports = { ip2long, isLocalIP, isLocalIPv6, ipv6ToBigInt, parseIPRange }
