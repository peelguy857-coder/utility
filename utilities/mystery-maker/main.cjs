// Mystery Maker backend: puts a website hunt on the internet through Netlify's API, using the
// personal access token the user pasted into the app. Three calls: create a site (to learn its
// address before the clues are written), upload a zip of the pages as a deploy, delete the site.
// Nothing else leaves the machine; the token is only ever sent to api.netlify.com.
const { net } = require('electron')

const NETLIFY = 'https://api.netlify.com/api/v1'
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+$/ // tests point the calls at a mock server

function base(apiBase) {
  return typeof apiBase === 'string' && LOOPBACK.test(apiBase) ? apiBase + '/api/v1' : NETLIFY
}

function checkToken(token) {
  if (typeof token !== 'string' || !/^[\w.-]{20,200}$/.test(token.trim())) throw new Error('That does not look like a Netlify token')
  return token.trim()
}

async function call(apiBase, token, method, route, body, contentType) {
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'Utility Mystery Maker' }
  if (body !== undefined) headers['Content-Type'] = contentType || 'application/json'
  let res
  try {
    res = await net.fetch(base(apiBase) + route, { method, headers, body: body === undefined ? undefined : contentType ? body : JSON.stringify(body) })
  } catch (err) {
    throw new Error(`Could not reach Netlify: ${err.message}`)
  }
  const text = await res.text()
  if (res.status === 401) throw new Error('Netlify rejected the token. Make a new personal access token and paste it again.')
  if (!res.ok) throw new Error(`Netlify said ${res.status}: ${text.slice(0, 200)}`)
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = {
  handlers: {
    /** Makes an empty site so its address is known. -> { siteId, url, name, adminUrl } */
    async netlifyCreate({ token, apiBase } = {}) {
      const site = await call(apiBase, checkToken(token), 'POST', '/sites', {})
      if (!site.id) throw new Error('Netlify did not return a site')
      return { siteId: site.id, url: site.ssl_url || site.url, name: site.name, adminUrl: site.admin_url || '' }
    },

    /** Uploads the pages (a zip with index.html at its root) and waits until they are live. */
    async netlifyDeploy({ token, siteId, zip, apiBase } = {}) {
      if (typeof siteId !== 'string' || !/^[\w-]{6,80}$/.test(siteId)) throw new Error('No site to publish to')
      if (!(zip instanceof Uint8Array) || zip.length < 22) throw new Error('Nothing to upload')
      const t = checkToken(token)
      const deploy = await call(apiBase, t, 'POST', `/sites/${siteId}/deploys`, Buffer.from(zip), 'application/zip')
      if (!deploy.id) throw new Error('Netlify did not accept the upload')
      const started = Date.now()
      let state = deploy.state
      while (state !== 'ready' && Date.now() - started < 120000) {
        await sleep(state === 'uploading' || state === 'processing' || state === 'new' || state === 'pending_review' ? 1500 : 800)
        const d = await call(apiBase, t, 'GET', `/deploys/${deploy.id}`)
        state = d.state
        if (state === 'error') throw new Error(`Netlify could not build the site: ${d.error_message || 'unknown error'}`)
      }
      if (state !== 'ready') throw new Error('Netlify is still processing the upload; check the site in a minute')
      return { deployId: deploy.id, state, url: deploy.ssl_url || deploy.url || '' }
    },

    async netlifyDelete({ token, siteId, apiBase } = {}) {
      if (typeof siteId !== 'string' || !/^[\w-]{6,80}$/.test(siteId)) throw new Error('No site to delete')
      await call(apiBase, checkToken(token), 'DELETE', `/sites/${siteId}`)
      return { ok: true }
    },
  },
}
