import { GATEWAY_PROTOCOL_VERSION } from '/src/gateway/paths.ts'

/**
 * Render the minimal in-browser chat client HTML. Serves the same
 * event stream the TUI consumes — proves the WS protocol is UI-
 * pluggable and gives the user a zero-install fallback if their
 * terminal is unfriendly (iOS Safari, ChromeOS, shared VNC).
 *
 * Security model: loopback-only (gateway binds 127.0.0.1). The token
 * is inlined into the HTML as a data-attribute, so only a request
 * from the same machine can see it. Tokens are hex-only, no HTML
 * escaping needed.
 *
 * UI scope (Phase 3A): single chat, no history, one connection. The
 * point is to prove the architecture works through a browser; rich
 * UI polish is later.
 */
export const renderChatHtml = (token: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>SLV Chat</title>
<style>
  :root {
    --bg: #0b0f14;
    --panel: #12181f;
    --border: #1f2933;
    --text: #e6edf3;
    --muted: #8b949e;
    --accent: #14f195;
    --user: #58a6ff;
    --tool: #d29922;
    --error: #f85149;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  body { display: flex; flex-direction: column; }
  header {
    flex: 0 0 auto;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  header .title { font-weight: 600; }
  header .status {
    margin-left: auto;
    font: 12px var(--mono);
    color: var(--muted);
  }
  header .status.connected { color: var(--accent); }
  header .status.error     { color: var(--error); }
  main {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 12px 14px;
  }
  footer {
    flex: 0 0 auto;
    border-top: 1px solid var(--border);
    background: var(--panel);
    padding: 10px 14px;
    display: flex;
    gap: 8px;
  }
  #input {
    flex: 1 1 auto;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    font: 14px var(--mono);
    resize: none;
    min-height: 36px;
    max-height: 180px;
  }
  #input:focus { outline: 2px solid var(--accent); }
  button {
    background: var(--accent);
    color: #001b10;
    border: 0;
    border-radius: 6px;
    padding: 0 14px;
    font-weight: 600;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  button.abort { background: var(--error); color: white; }
  .msg { margin: 0 0 12px 0; }
  .msg .who {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 3px;
  }
  .msg.user .who      { color: var(--user); }
  .msg.assistant .who { color: var(--accent); }
  .msg.tool .who      { color: var(--tool); }
  .msg.system .who    { color: var(--muted); }
  .msg.error .who     { color: var(--error); }
  .msg pre {
    margin: 0;
    padding: 6px 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    font: 13px var(--mono);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .msg.assistant pre { background: transparent; border: 0; padding: 4px 0; }
</style>
</head>
<body data-slv-token="${token}" data-slv-protocol="${GATEWAY_PROTOCOL_VERSION}">
<header>
  <span class="title">🌐 SLV Chat</span>
  <span id="status" class="status">connecting…</span>
</header>
<main id="log"></main>
<footer>
  <textarea id="input" rows="1" placeholder="Type a message and press Enter"></textarea>
  <button id="send">Send</button>
  <button id="abort" class="abort" style="display:none">Stop</button>
</footer>
<script>
(function () {
  const token = document.body.dataset.slvToken
  const log = document.getElementById('log')
  const input = document.getElementById('input')
  const sendBtn = document.getElementById('send')
  const abortBtn = document.getElementById('abort')
  const statusEl = document.getElementById('status')

  let ws = null
  let nextId = 0
  const pending = new Map()
  let currentAssistantEl = null

  const setStatus = (text, cls) => {
    statusEl.textContent = text
    statusEl.className = 'status ' + (cls || '')
  }

  const addMsg = (who, whoLabel, text) => {
    const div = document.createElement('div')
    div.className = 'msg ' + who
    const label = document.createElement('div')
    label.className = 'who'
    label.textContent = whoLabel
    const pre = document.createElement('pre')
    pre.textContent = text
    div.appendChild(label)
    div.appendChild(pre)
    log.appendChild(div)
    log.scrollTop = log.scrollHeight
    return pre
  }

  const call = (method, params) => new Promise((resolve) => {
    const id = 'w' + (++nextId)
    pending.set(id, resolve)
    ws.send(JSON.stringify({ kind: 'req', id, method, params }))
  })

  const connect = () => {
    const url = 'ws://' + location.host + '/v1/session/ws'
    ws = new WebSocket(url)
    ws.onopen = async () => {
      const hello = await call('gateway.hello')
      if (!hello.ok) {
        setStatus('handshake failed', 'error')
        return
      }
      const auth = await call('gateway.auth', { token })
      if (!auth.ok) {
        setStatus('auth failed', 'error')
        return
      }
      setStatus('connected', 'connected')
      input.focus()
    }
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data)
      if (f.kind === 'res') {
        const r = pending.get(f.id)
        if (r) { pending.delete(f.id); r(f) }
        return
      }
      if (f.kind !== 'event') return
      const p = f.payload || {}
      switch (p.type) {
        case 'text_delta':
          if (!currentAssistantEl) {
            currentAssistantEl = addMsg('assistant', 'Assistant', '')
          }
          currentAssistantEl.textContent += p.text
          log.scrollTop = log.scrollHeight
          break
        case 'tool_use_start':
          addMsg('tool', '⚡ ' + (p.name || 'tool'), typeof p.args === 'string' ? p.args : JSON.stringify(p.args || {}, null, 2))
          break
        case 'tool_stdout':
          addMsg('tool', '   stdout', p.text || '')
          break
        case 'tool_progress':
          addMsg('tool', '   ' + (p.label || 'progress'), '')
          break
        case 'complete':
        case 'aborted':
          currentAssistantEl = null
          sendBtn.disabled = false
          abortBtn.style.display = 'none'
          if (p.type === 'aborted') {
            addMsg('system', '⏸ aborted', p.reason || '')
          }
          break
        case 'error':
          addMsg('error', '❌ error', p.message || '')
          currentAssistantEl = null
          sendBtn.disabled = false
          abortBtn.style.display = 'none'
          break
      }
    }
    ws.onclose = () => setStatus('disconnected', 'error')
    ws.onerror = () => setStatus('connection error', 'error')
  }

  const sendMessage = async () => {
    const text = input.value.trim()
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return
    addMsg('user', 'You', text)
    input.value = ''
    input.style.height = 'auto'
    sendBtn.disabled = true
    abortBtn.style.display = 'inline-block'
    currentAssistantEl = null
    const res = await call('session.send', { text })
    if (!res.ok) {
      addMsg('error', '❌ error', res.error || 'session.send rejected')
      sendBtn.disabled = false
      abortBtn.style.display = 'none'
    }
  }

  sendBtn.addEventListener('click', sendMessage)
  abortBtn.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ kind: 'req', id: 'a' + (++nextId), method: 'session.abort' }))
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  })
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 180) + 'px'
  })

  connect()
})()
</script>
</body>
</html>
`
