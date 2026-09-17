// Streams a file once through MD5, SHA-1, SHA-256 and SHA-512. Works for any size: memory use is one chunk.
'use strict'
const fs = require('node:fs')
const crypto = require('node:crypto')

const ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha512']

class CancelledError extends Error {
  constructor() {
    super('Hashing was cancelled')
    this.name = 'CancelledError'
    this.code = 'CANCELLED'
  }
}

/**
 * @param {string} filePath
 * @param {{ onProgress?: (p: { done: number, total: number }) => void, progressIntervalMs?: number, chunkSize?: number }} [opts]
 * @returns {{ promise: Promise<{ size: number, digests: Record<string, string | null>, ms: number }>, cancel: () => void, readonly stream: fs.ReadStream | null }}
 *   `promise` settles only after the file handle is closed again, also on cancel and on errors.
 */
function hashFile(filePath, opts = {}) {
  const { onProgress, progressIntervalMs = 100, chunkSize = 1024 * 1024 } = opts
  const started = Date.now()
  let cancelled = false
  let stream = null

  const promise = (async () => {
    const st = await fs.promises.stat(filePath)
    if (st.isDirectory()) throw Object.assign(new Error('That is a folder. Add the files inside it instead.'), { code: 'EISDIR' })
    if (!st.isFile()) throw Object.assign(new Error('That is not a regular file.'), { code: 'ENOTFILE' })
    if (cancelled) throw new CancelledError()

    // An algorithm the crypto build refuses (MD5 under FIPS, say) is reported as null instead of failing the rest.
    const hashes = ALGORITHMS.map((name) => {
      try {
        return { name, hash: crypto.createHash(name) }
      } catch {
        return { name, hash: null }
      }
    })

    return new Promise((resolve, reject) => {
      const total = st.size
      let done = 0
      let lastEmit = 0
      let failure = null
      stream = fs.createReadStream(filePath, { highWaterMark: chunkSize })
      stream.on('data', (chunk) => {
        for (const h of hashes) if (h.hash) h.hash.update(chunk)
        done += chunk.length
        const now = Date.now()
        if (onProgress && now - lastEmit >= progressIntervalMs) {
          lastEmit = now
          onProgress({ done, total: Math.max(total, done) })
        }
      })
      stream.on('error', (err) => {
        failure = err
      })
      // 'close' comes last in every case (end, error, destroy): by then the handle is released.
      stream.on('close', () => {
        if (cancelled) return reject(new CancelledError())
        if (failure) return reject(failure)
        const digests = {}
        for (const h of hashes) digests[h.name] = h.hash ? h.hash.digest('hex') : null
        if (onProgress) onProgress({ done, total: done })
        resolve({ size: done, digests, ms: Date.now() - started })
      })
    })
  })()

  return {
    promise,
    cancel() {
      cancelled = true
      if (stream) stream.destroy()
    },
    get stream() {
      return stream
    },
  }
}

/** Turn a filesystem error into a sentence a person can act on. */
function describeError(err) {
  const code = err && err.code
  if (code === 'ENOENT') return 'The file is gone: it was moved, renamed or deleted.'
  if (code === 'EACCES' || code === 'EPERM') return 'Windows denied access to this file.'
  if (code === 'EBUSY') return 'Another program has locked this file. Close it there and try again.'
  if (code === 'EISDIR' || code === 'ENOTFILE') return err.message
  return (err && err.message) || String(err)
}

module.exports = { ALGORITHMS, CancelledError, hashFile, describeError }
