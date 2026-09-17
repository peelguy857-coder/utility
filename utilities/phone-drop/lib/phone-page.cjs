// The page the phone sees. One self-contained HTML document: no external requests, works on iOS Safari
// over plain http (so no navigator.clipboard, no service worker — only what an insecure origin allows).

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function phonePage({ pcName }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d0e12">
<title>Phone Drop</title>
<style>
  :root { color-scheme: dark; --bg:#0d0e12; --card:#15171e; --elev:#1d2029; --line:#272b37; --text:#eceef4; --dim:#a3a9b8; --faint:#6b7283; --accent:#b9f24a; --ink:#11140a; --ok:#4ade80; --warn:#fbbf24; --err:#fb7185; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         padding: calc(env(safe-area-inset-top) + 18px) calc(env(safe-area-inset-right) + 16px) calc(env(safe-area-inset-bottom) + 28px) calc(env(safe-area-inset-left) + 16px); }
  main { max-width: 560px; margin: 0 auto; display:flex; flex-direction:column; gap:16px; }
  header { display:flex; align-items:center; gap:12px; padding: 4px 2px 6px; }
  .logo { width:34px; height:34px; flex:none; }
  h1 { margin:0; font-size:20px; font-weight:650; letter-spacing:-0.01em; }
  .status { display:flex; align-items:center; gap:7px; color:var(--dim); font-size:13.5px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--warn); }
  .dot.on { background:var(--ok); box-shadow:0 0 0 4px rgb(74 222 128 / .15); }
  section { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:16px; }
  h2 { margin:0 0 12px; font-size:12px; font-weight:650; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); }
  .pick { display:flex; flex-direction:column; align-items:center; gap:6px; padding:26px 16px; border:1.5px dashed #3a4052; border-radius:14px; text-align:center; cursor:pointer;
          background: radial-gradient(90% 120% at 50% 0%, rgb(185 242 74 / .07), transparent 70%); }
  .pick:active { background: rgb(185 242 74 / .1); border-color: var(--accent); }
  .pick strong { font-size:17px; }
  .pick span { color:var(--dim); font-size:14px; }
  .pick svg { color:var(--accent); margin-bottom:4px; }
  input[type=file] { position:absolute; width:1px; height:1px; opacity:0; }
  ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
  ul:not(:empty) { margin-top:12px; }
  section > ul:first-of-type:not(:empty) { margin-top:0; }
  li { display:flex; align-items:center; gap:12px; padding:11px 12px; background:var(--elev); border-radius:12px; min-width:0; }
  .grow { flex:1; min-width:0; }
  .name { font-weight:550; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .meta { color:var(--faint); font-size:13px; }
  .bar { height:4px; margin-top:7px; border-radius:4px; background:#2c3140; overflow:hidden; }
  .bar i { display:block; height:100%; width:0; background:var(--accent); transition: width .15s linear; }
  .done .bar i { background:var(--ok); } .failed .bar i { background:var(--err); }
  .msg { white-space:pre-wrap; word-break:break-word; font-size:15px; -webkit-user-select:text; user-select:text; }
  .from { font-size:11.5px; font-weight:650; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); margin-bottom:3px; }
  button, .btn { appearance:none; border:0; border-radius:11px; height:40px; padding:0 15px; font:600 15px inherit; font-family:inherit; color:var(--text); background:#2a2f3d; text-decoration:none;
                 display:inline-flex; align-items:center; justify-content:center; gap:7px; flex:none; cursor:pointer; }
  button:active, .btn:active { transform:scale(.97); }
  .primary { background:var(--accent); color:var(--ink); }
  .small { height:34px; padding:0 12px; font-size:14px; border-radius:9px; }
  textarea { width:100%; min-height:84px; padding:12px; border-radius:12px; border:1px solid var(--line); background:#0a0b0e; color:var(--text); font:inherit; resize:vertical; outline:0; }
  textarea:focus { border-color:var(--accent); }
  .row { display:flex; justify-content:flex-end; gap:8px; margin-top:10px; }
  .empty { color:var(--faint); font-size:14.5px; padding:4px 2px; }
  .toast { position:fixed; left:50%; bottom:calc(env(safe-area-inset-bottom) + 22px); transform:translate(-50%, 20px); opacity:0; transition:all .2s; pointer-events:none;
           background:#2a2f3d; color:var(--text); padding:10px 16px; border-radius:20px; font-size:14.5px; font-weight:550; box-shadow:0 10px 30px rgb(0 0 0 / .5); }
  .toast.show { transform:translate(-50%, 0); opacity:1; }
</style>
</head>
<body>
<main>
  <header>
    <svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="9" height="9" rx="2.6" fill="#333949"/><rect x="13" y="2" width="9" height="9" rx="2.6" fill="#333949"/><rect x="2" y="13" width="9" height="9" rx="2.6" fill="#333949"/><rect x="13" y="13" width="9" height="9" rx="2.6" fill="#b9f24a" transform="rotate(12 17.5 17.5)"/></svg>
    <div>
      <h1>Phone Drop</h1>
      <div class="status"><span class="dot" id="dot"></span><span id="status">Connecting to ${escapeHtml(pcName)}…</span></div>
    </div>
  </header>

  <section>
    <h2>Send to the PC</h2>
    <label class="pick">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>
      <strong>Choose photos or files</strong>
      <span>They land in the Phone Drop folder on the PC</span>
      <input id="file" type="file" multiple>
    </label>
    <ul id="uploads"></ul>
  </section>

  <section>
    <h2>Send text or a link</h2>
    <textarea id="text" placeholder="Type or paste here…"></textarea>
    <div class="row"><button class="primary" id="send">Send to PC</button></div>
  </section>

  <section>
    <h2>From the PC</h2>
    <ul id="files"></ul>
    <ul id="texts"></ul>
    <div class="empty" id="empty">Nothing shared yet. Drop files into Phone Drop on the PC and they show up here.</div>
  </section>
</main>
<div class="toast" id="toast"></div>

<script>
(function () {
  var base = location.pathname.replace(/\\/?$/, '/')
  var $ = function (id) { return document.getElementById(id) }
  var pcName = ${JSON.stringify(String(pcName)).replace(/</g, '\\u003c')}

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
  function size(n) { if (n < 1024) return n + ' B'; var u = ['KB','MB','GB','TB'], i = -1; do { n /= 1024; i++ } while (n >= 1024 && i < 3); return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i] }
  var toastTimer
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show') }, 1800) }

  // navigator.clipboard needs https; this old trick works on http and on iOS.
  function copy(text) {
    var ta = el('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length)
    var ok = false; try { ok = document.execCommand('copy') } catch (e) {}
    document.body.removeChild(ta); toast(ok ? 'Copied' : 'Press and hold the text to copy')
  }

  function render(state) {
    var files = $('files'), texts = $('texts')
    files.textContent = ''; texts.textContent = ''
    state.files.forEach(function (f) {
      var li = el('li'), g = el('div', 'grow')
      g.appendChild(el('div', 'name', f.name)); g.appendChild(el('div', 'meta', size(f.size)))
      var a = el('a', 'btn small primary', 'Download'); a.href = base + 'file/' + f.id; a.setAttribute('download', f.name)
      li.appendChild(g); li.appendChild(a); files.appendChild(li)
    })
    state.texts.slice().reverse().forEach(function (t) {
      var li = el('li'), g = el('div', 'grow')
      g.appendChild(el('div', 'from', t.from === 'pc' ? 'From the PC' : 'You sent')); g.appendChild(el('div', 'msg', t.text))
      li.appendChild(g)
      var trimmed = t.text.trim()
      if (/^https?:\\/\\/\\S+$/i.test(trimmed)) { var open = el('a', 'btn small', 'Open'); open.href = trimmed; open.target = '_blank'; open.rel = 'noopener noreferrer'; li.appendChild(open) }
      var c = el('button', 'small', 'Copy'); c.onclick = function () { copy(t.text) }; li.appendChild(c)
      texts.appendChild(li)
    })
    $('empty').style.display = state.files.length || state.texts.length ? 'none' : ''
  }

  function connect() {
    var es = new EventSource(base + 'api/events')
    es.onopen = function () { $('dot').classList.add('on'); $('status').textContent = 'Connected to ' + pcName }
    es.onmessage = function (e) { try { render(JSON.parse(e.data)) } catch (err) {} }
    es.onerror = function () { $('dot').classList.remove('on'); $('status').textContent = 'Lost the PC — is Phone Drop still running?' }
  }

  // ---- uploads: two at a time, each with its own progress row
  var queue = [], active = 0
  function pump() {
    while (active < 2 && queue.length) start(queue.shift())
  }
  function start(job) {
    active++
    var xhr = new XMLHttpRequest()
    xhr.open('POST', base + 'upload?name=' + encodeURIComponent(job.file.name))
    xhr.upload.onprogress = function (e) { if (e.lengthComputable) { job.bar.style.width = (e.loaded / e.total * 100) + '%'; job.meta.textContent = size(e.loaded) + ' of ' + size(e.total) } }
    function finish(ok) {
      active--
      job.li.className = ok ? 'done' : 'failed'
      job.bar.style.width = '100%'
      job.meta.textContent = ok ? 'Sent · ' + size(job.file.size) : 'Failed — tap to retry'
      if (!ok) job.li.onclick = function () { job.li.onclick = null; job.li.className = ''; job.bar.style.width = '0'; job.meta.textContent = 'Waiting…'; queue.push(job); pump() }
      pump()
    }
    xhr.onload = function () { finish(xhr.status === 200) }
    xhr.onerror = xhr.onabort = function () { finish(false) }
    xhr.send(job.file)
  }
  $('file').onchange = function (e) {
    Array.prototype.forEach.call(e.target.files, function (file) {
      var li = el('li'), g = el('div', 'grow'), meta = el('div', 'meta', 'Waiting…'), barWrap = el('div', 'bar'), bar = el('i')
      barWrap.appendChild(bar); g.appendChild(el('div', 'name', file.name)); g.appendChild(meta); g.appendChild(barWrap); li.appendChild(g)
      $('uploads').insertBefore(li, $('uploads').firstChild)
      queue.push({ file: file, li: li, bar: bar, meta: meta })
    })
    e.target.value = ''
    pump()
  }

  $('send').onclick = function () {
    var text = $('text').value
    if (!text.trim()) return
    fetch(base + 'text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text }) })
      .then(function (r) { if (!r.ok) throw 0; $('text').value = ''; toast('Sent to the PC') })
      .catch(function () { toast('Could not reach the PC') })
  }

  connect()
})()
</script>
</body>
</html>`
}

module.exports = { phonePage }
