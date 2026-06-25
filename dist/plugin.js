// plugin.js
exports.version = 0.7
exports.description = "Ultra lightweight request blocker based on an IP blocklist."
exports.apiRequired = 4
exports.repo = "feuerswut/hfs-ip-blocklist"
exports.author = "feuerswut"

const path = require('path')
const { Worker } = require('worker_threads')
const BitmapStore = require('./backend/bitmap-store')

// Simple user-facing config. Advanced tuning lives in storageDir/config.json
// (auto-generated on first run, editable, changes trigger a full rebuild).
exports.config = {
    source: {
        type: 'select',
        defaultValue: 'url',
        options: { 'URL': 'url', 'File': 'file' },
        label: 'Blocklist Source',
        $width: 4
    },
    url: {
        type: 'string',
        defaultValue: '',
        label: 'Blocklist URL'
    },
    filePath: {
        type: 'string',
        defaultValue: '',
        label: 'Blocklist File Path'
    },
    refreshInterval: {
        type: 'number',
        defaultValue: 86400,
        min: 3600,
        label: 'Refresh Interval (seconds)'
    },
    enableIPv6: {
        type: 'boolean',
        defaultValue: false,
        label: 'Enable IPv6 Blocking'
    },
    logBlocked: {
        type: 'boolean',
        defaultValue: false,
        label: 'Log Blocked IPs'
    },
    debugLog: {
        type: 'boolean',
        defaultValue: false,
        label: 'Debug Logging'
    }
}

// Only these fields affect how the blocklist is built — changes force a rebuild.
// refreshInterval, logBlocked, debugLog take effect immediately.
const PROCESSING_KEYS = ['source', 'url', 'filePath', 'enableIPv6']

function processingSignature(config) {
    return PROCESSING_KEYS.map(k => `${k}=${JSON.stringify(config[k])}`).join('|')
}

exports.init = api => {
    let isReady = false
    let store = null
    let worker = null
    let refreshTimer = null
    let lastSig = null
    let stats = { checks: 0, hits: 0, allowed: 0, timeouts: 0, errors: 0 }

    const { disconnect } = api.require('./connections')
    const storageDir = api.storageDir

    const debug = (...args) => {
        if (api.getConfig('debugLog')) api.log('[DEBUG]', ...args)
    }

    async function checkIPWithTimeout(ip, timeoutMs) {
        // store.checkIP is synchronous (bitmap.has / binary search); the Promise.race
        // is only here as a safety net against unexpected hangs in the binary loader.
        return Promise.race([
            Promise.resolve(store.checkIP(ip)),
            new Promise(resolve => setTimeout(() => resolve({ blocked: false, timeout: true }), timeoutMs))
        ])
    }

    function startWorker(forceReprocess = false) {
        const config = api.getConfig()
        if (worker) { worker.terminate(); worker = null }

        debug(`Starting worker${forceReprocess ? ' (force reprocess)' : ''}...`)

        worker = new Worker(path.join(__dirname, 'backend/worker.js'), {
            workerData: {
                storageDir,
                config: {
                    source: config.source,
                    url: config.url,
                    filePath: config.filePath,
                    enableIPv6: config.enableIPv6,
                    forceReprocess
                }
            }
        })

        worker.on('message', async (msg) => {
            switch (msg.type) {
                case 'debug': debug(msg.msg); break
                case 'log': api.log(msg.msg); break
                case 'progress': debug(`[${msg.phase}] ${msg.percent}%`); break

                case 'ready': {
                    isReady = false
                    const newStore = new BitmapStore(storageDir, debug)
                    const ok = await newStore.load()
                    if (ok) {
                        if (store) store.cleanup()
                        store = newStore
                        isReady = true
                        const v6info = msg.totalIPv6Ranges > 0 ? `, ${msg.totalIPv6Ranges} IPv6` : ''
                        api.log(`IP Blocklist READY — ${msg.totalRanges} IPv4 ranges${v6info}, ${msg.diskUsageMB} MB, ${msg.processTime}s build`)
                    } else {
                        api.log('IP Blocklist: failed to load bitmap store after rebuild')
                    }
                    break
                }

                case 'error':
                    api.log(`IP Blocklist worker error: ${msg.error}`)
                    stats.errors++
                    break
            }
        })

        worker.on('error', (err) => {
            api.log(`IP Blocklist worker error: ${err.message}`)
            stats.errors++
        })

        worker.on('exit', (code) => {
            if (code !== 0) debug(`Worker exited with code ${code}`)
        })
    }

    async function tryLoadExisting() {
        const s = new BitmapStore(storageDir, debug)
        const ok = await s.load()
        if (ok) { store = s; isReady = true; debug('Loaded existing bitmap data') }
        return ok
    }

    ;(async () => {
        debug('Plugin initializing...')
        await tryLoadExisting()

        api.subscribeConfig('*', async () => {
            const config = api.getConfig()
            const newSig = processingSignature(config)
            const sigChanged = newSig !== lastSig
            const firstRun = lastSig === null

            if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }

            if (sigChanged) {
                lastSig = newSig
                // Force reprocess when the processing config changes mid-run so the
                // new settings are not ignored by the hash-based skip check.
                startWorker(!firstRun)
            } else if (!isReady) {
                startWorker(false)
            } else {
                debug('Config change applied (no rebuild needed)')
            }

            if (config.refreshInterval > 0) {
                refreshTimer = setInterval(() => {
                    debug('Auto-refresh triggered')
                    startWorker(false)
                }, config.refreshInterval * 1000)
            }
        })
    })()

    return {
        middleware: async (ctx) => {
            stats.checks++
            if (!isReady || !store) { stats.allowed++; return }

            const ip = ctx.ip
            const timeoutMs = (store && store.requestTimeoutMs) || 30

            try {
                const result = await checkIPWithTimeout(ip, timeoutMs)

                if (result.timeout) { stats.timeouts++; debug(`Timeout checking ${ip}`); return }
                if (result.error) { stats.errors++; return }

                if (result.blocked) {
                    stats.hits++
                    if (api.getConfig('logBlocked')) api.log(`BLOCKED: ${ip}`)
                    disconnect(ctx, 'IP blocklist')
                    ctx.status = 403
                    ctx.body = 'Forbidden'
                    return ctx.stop()
                }

                stats.allowed++

            } catch (err) {
                debug(`Middleware error: ${err.message}`)
                stats.errors++
            }
        },

        unload() {
            debug('Unloading plugin...')
            if (refreshTimer) clearInterval(refreshTimer)
            if (worker) worker.terminate()
            if (store) store.cleanup()

            if (api.getConfig('debugLog')) {
                const hitRate = stats.checks > 0
                    ? (stats.hits / stats.checks * 100).toFixed(2) : '0.00'
                api.log('=== IP BLOCKLIST STATS ===')
                api.log(`Checks:   ${stats.checks.toLocaleString()}`)
                api.log(`Blocked:  ${stats.hits.toLocaleString()} (${hitRate}%)`)
                api.log(`Allowed:  ${stats.allowed.toLocaleString()}`)
                api.log(`Timeouts: ${stats.timeouts.toLocaleString()}`)
                api.log(`Errors:   ${stats.errors}`)
                api.log('==========================')
            }
        }
    }
}
