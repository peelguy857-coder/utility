// File Hash backend: streams files the user handed over through four hash functions at once.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { hashFile, describeError, ALGORITHMS } = require('./lib/hasher.cjs')
const { parseExpected, judge, sumsText } = require('./lib/expected.cjs')

const MAX_PARALLEL = 2 // more only makes the disk seek back and forth

/** id -> { job | null, cancelled } for everything queued or running */
const active = new Map()
/** id -> { path, name, size, digests } for finished files (needed to write the checksum file later) */
const finished = new Map()
const waiting = []
let running = 0
let disposed = false

function acquire() {
  if (running < MAX_PARALLEL) {
    running++
    return Promise.resolve()
  }
  return new Promise((resolve) => waiting.push(resolve))
}

function release() {
  const next = waiting.shift()
  if (next) next()
  else running--
}

const cleanId = (id) => {
  if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) throw new Error('Bad job id')
  return id
}

module.exports = {
  async dispose() {
    disposed = true
    for (const entry of active.values()) {
      entry.cancelled = true
      if (entry.job) entry.job.cancel()
    }
    // wait until every read stream has really let go of its file
    await Promise.allSettled([...active.values()].map((e) => e.job && e.job.promise))
  },

  handlers: {
    /**
     * Hash one file. Resolves with the digests, or with `{ cancelled: true }`.
     * Progress arrives as 'progress' events: { id, done, total } about ten times a second.
     */
    async hash({ id: rawId, path: filePath } = {}, ctx) {
      const id = cleanId(rawId)
      if (disposed) throw new Error('The app is closing')
      if (typeof filePath !== 'string' || !filePath) throw new Error('No file given')
      if (!ctx.isAllowed(filePath)) throw new Error('That file was not shared with the app. Drop it on the window or use Browse.')
      if (active.has(id)) throw new Error('This file is already being hashed')

      const entry = { job: null, cancelled: false }
      active.set(id, entry)
      await acquire()
      try {
        if (entry.cancelled) return { id, cancelled: true }
        ctx.emit('progress', { id, done: 0, total: 0, started: true })
        entry.job = hashFile(filePath, { onProgress: (p) => ctx.emit('progress', { id, done: p.done, total: p.total }) })
        const result = await entry.job.promise
        const record = { path: filePath, name: path.basename(filePath), size: result.size, digests: result.digests }
        finished.set(id, record)
        return { id, ...record, ms: result.ms }
      } catch (err) {
        if (err && err.code === 'CANCELLED') return { id, cancelled: true }
        throw new Error(describeError(err))
      } finally {
        active.delete(id)
        release()
      }
    },

    async cancel({ id } = {}) {
      const entry = active.get(cleanId(id))
      if (!entry) return { cancelled: false }
      entry.cancelled = true
      if (entry.job) entry.job.cancel()
      return { cancelled: true }
    },

    /** The UI removed a card: stop it if it still runs and drop its result. */
    async forget({ id } = {}) {
      const key = cleanId(id)
      const entry = active.get(key)
      if (entry) {
        entry.cancelled = true
        if (entry.job) entry.job.cancel()
      }
      finished.delete(key)
      return { ok: true }
    },

    /** What is in the pasted text, and does it match any of the finished files? */
    async compare({ text, ids } = {}) {
      const parsed = parseExpected(typeof text === 'string' ? text.slice(0, 200000) : '')
      if (!parsed.ok) return { parsed, verdict: null }
      const files = (Array.isArray(ids) ? ids : []).map((id) => ({ id, rec: finished.get(id) })).filter((f) => f.rec).map((f) => ({ id: f.id, name: f.rec.name, digests: f.rec.digests }))
      return { parsed, verdict: judge(parsed.candidates, files) }
    },

    /** "<hex>  <name>" lines for the given finished files, as the *sum tools print them. */
    async sums({ ids, algo, upper } = {}) {
      if (!ALGORITHMS.includes(algo)) throw new Error('Unknown algorithm')
      const entries = (Array.isArray(ids) ? ids : []).map((id) => finished.get(id)).filter(Boolean)
      return { text: sumsText(entries, algo, !!upper), count: entries.filter((e) => e.digests[algo]).length }
    },

    /**
     * Write "<file>.<algo>" next to a hashed file. The target is derived here from a path the user
     * already shared, never taken from the UI. An existing file is only replaced with `overwrite`.
     */
    async saveSidecar({ id, algo, upper, overwrite } = {}) {
      if (!ALGORITHMS.includes(algo)) throw new Error('Unknown algorithm')
      const rec = finished.get(cleanId(id))
      if (!rec) throw new Error('Hash the file first')
      if (!rec.digests[algo]) throw new Error('That checksum is not available for this file')
      const target = `${rec.path}.${algo}`
      try {
        await fs.promises.writeFile(target, sumsText([rec], algo, !!upper), { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' })
      } catch (err) {
        if (err.code === 'EEXIST') return { exists: true, path: target }
        if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') throw new Error(`Windows does not allow writing to ${path.dirname(target)}. Use "Copy" and save the text elsewhere.`)
        throw new Error(describeError(err))
      }
      return { exists: false, path: target }
    },
  },
}
