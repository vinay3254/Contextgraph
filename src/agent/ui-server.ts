// src/agent/ui-server.ts
// Shisya Web UI — pixel-art terminal interface served at localhost:7332
// Provides a Copilot-style chat UI connected to the ContextGraph agent

import express from 'express';
import http from 'http';
import type { GraphDB } from '../graph/kuzu.js';
import { ContextGraphAgent } from './agent.js';
import type { BackendType } from './backends/index.js';
import path from 'path';

const UI_PORT = 7332;

// Pixel-art mascot encoded as inline SVG (data URI safe)
const MASCOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" shape-rendering="crispEdges">
  <!-- Body -->
  <rect x="16" y="20" width="32" height="28" fill="#1a1a2e"/>
  <rect x="14" y="22" width="36" height="24" fill="#16213e"/>
  <!-- Head/helmet -->
  <rect x="18" y="8" width="28" height="20" fill="#0f3460"/>
  <rect x="16" y="10" width="32" height="18" fill="#533483"/>
  <!-- Visor -->
  <rect x="20" y="14" width="24" height="10" fill="#00d4ff" opacity="0.2"/>
  <rect x="20" y="14" width="24" height="10" fill="none" stroke="#00d4ff" stroke-width="1"/>
  <!-- Eyes -->
  <rect x="22" y="16" width="8" height="6" fill="#00d4ff"/>
  <rect x="34" y="16" width="8" height="6" fill="#00d4ff"/>
  <!-- Eye glow -->
  <rect x="24" y="18" width="4" height="2" fill="#ffffff" opacity="0.8"/>
  <rect x="36" y="18" width="4" height="2" fill="#ffffff" opacity="0.8"/>
  <!-- Chest panel -->
  <rect x="22" y="30" width="20" height="12" fill="#0f3460"/>
  <rect x="24" y="32" width="4" height="4" fill="#00d4ff" opacity="0.7"/>
  <rect x="30" y="32" width="4" height="4" fill="#533483" opacity="0.7"/>
  <rect x="36" y="32" width="4" height="4" fill="#00d4ff" opacity="0.7"/>
  <!-- Legs -->
  <rect x="20" y="48" width="10" height="8" fill="#533483"/>
  <rect x="34" y="48" width="10" height="8" fill="#533483"/>
  <!-- Feet -->
  <rect x="18" y="54" width="14" height="4" fill="#0f3460"/>
  <rect x="32" y="54" width="14" height="4" fill="#0f3460"/>
  <!-- Arms -->
  <rect x="6" y="24" width="10" height="18" fill="#533483"/>
  <rect x="48" y="24" width="10" height="18" fill="#533483"/>
  <!-- Antenna -->
  <rect x="30" y="4" width="4" height="6" fill="#00d4ff"/>
  <rect x="28" y="2" width="8" height="4" fill="#00d4ff"/>
  <rect x="30" y="0" width="4" height="4" fill="#ffffff" opacity="0.9"/>
</svg>`;

function buildHTML(
  projectRoot: string,
  nodeCount: number,
  edgeCount: number,
  backendType: string,
  model: string
): string {
  const shortRoot = projectRoot.split(/[/\\]/).slice(-2).join('/');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Shisya — Neural Codebase Agent</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:        #0d0d14;
    --bg2:       #111120;
    --bg3:       #16162a;
    --border:    #1e1e3a;
    --cyan:      #00d4ff;
    --purple:    #a855f7;
    --green:     #00ff88;
    --dim:       #4a4a6a;
    --text:      #c8c8e8;
    --text-dim:  #6060a0;
    --red:       #ff4444;
    --yellow:    #ffd700;
    --font-mono: 'Share Tech Mono', monospace;
    --font-pixel:'Press Start 2P', monospace;
  }

  html, body {
    height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 14px;
    overflow: hidden;
  }

  /* ─── Layout ─── */
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    max-width: 900px;
    margin: 0 auto;
    border-left: 1px solid var(--border);
    border-right: 1px solid var(--border);
  }

  /* ─── Header ─── */
  .header {
    background: var(--bg2);
    border-bottom: 2px solid var(--border);
    padding: 20px 24px 16px;
    position: relative;
    flex-shrink: 0;
  }

  .header-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .header-left {
    flex: 1;
  }

  .welcome-text {
    font-family: var(--font-pixel);
    font-size: 8px;
    color: var(--text-dim);
    letter-spacing: 2px;
    margin-bottom: 12px;
    text-transform: uppercase;
  }

  .logo {
    font-family: var(--font-pixel);
    font-size: clamp(20px, 4vw, 32px);
    color: var(--cyan);
    letter-spacing: 4px;
    text-shadow:
      0 0 10px var(--cyan),
      0 0 30px rgba(0,212,255,0.3),
      3px 3px 0 #004455,
      6px 6px 0 #002233;
    line-height: 1.2;
    margin-bottom: 4px;
  }

  .logo-sub {
    font-family: var(--font-pixel);
    font-size: 7px;
    color: var(--text-dim);
    letter-spacing: 3px;
    margin-bottom: 16px;
  }

  .tagline {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-dim);
    line-height: 1.7;
    max-width: 560px;
  }

  .mascot {
    flex-shrink: 0;
    width: 90px;
    height: 90px;
    image-rendering: pixelated;
    filter: drop-shadow(0 0 12px rgba(0, 212, 255, 0.4));
    animation: float 3s ease-in-out infinite;
  }

  @keyframes float {
    0%, 100% { transform: translateY(0px); }
    50%       { transform: translateY(-6px); }
  }

  /* ─── Status bar ─── */
  .status-bar {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }

  .status-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-dim);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .dot-green  { background: var(--green);  box-shadow: 0 0 6px var(--green); }
  .dot-cyan   { background: var(--cyan);   box-shadow: 0 0 6px var(--cyan); }
  .dot-purple { background: var(--purple); box-shadow: 0 0 6px var(--purple); }

  /* ─── Context line ─── */
  .context-line {
    background: var(--bg2);
    border-bottom: 1px solid var(--border);
    padding: 8px 24px;
    font-size: 12px;
    color: var(--text-dim);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .context-path {
    color: var(--cyan);
    font-weight: bold;
  }

  .context-branch {
    color: var(--purple);
  }

  /* ─── Chat area ─── */
  .chat-area {
    flex: 1;
    overflow-y: auto;
    padding: 16px 24px;
    display: flex;
    flex-direction: column;
    gap: 0;
    scroll-behavior: smooth;
  }

  .chat-area::-webkit-scrollbar { width: 4px; }
  .chat-area::-webkit-scrollbar-track { background: var(--bg); }
  .chat-area::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  /* ─── Messages ─── */
  .msg {
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
    line-height: 1.7;
    animation: fadeIn 0.15s ease-out;
  }

  .msg:last-child { border-bottom: none; }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .msg-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 11px;
  }

  .msg-role-user    { color: var(--yellow); font-weight: bold; }
  .msg-role-shisya  { color: var(--cyan);   font-weight: bold; }
  .msg-role-system  { color: var(--dim); }
  .msg-time         { color: var(--dim); }

  .msg-body {
    color: var(--text);
    font-size: 13px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .msg-body.user-body {
    color: var(--text-dim);
  }

  .msg-body code {
    background: var(--bg3);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 4px;
    font-family: var(--font-mono);
    color: var(--cyan);
    font-size: 12px;
  }

  /* Tool usage indicator */
  .tool-call {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--bg3);
    border: 1px solid var(--border);
    border-left: 3px solid var(--purple);
    border-radius: 4px;
    padding: 4px 10px;
    margin: 4px 0;
    font-size: 11px;
    color: var(--purple);
  }

  /* Thinking animation */
  .thinking {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 0;
    color: var(--cyan);
    font-size: 12px;
    animation: fadeIn 0.2s ease-out;
  }

  .thinking-dots span {
    display: inline-block;
    width: 5px;
    height: 5px;
    background: var(--cyan);
    border-radius: 50%;
    margin: 0 2px;
    animation: blink 1.2s ease-in-out infinite;
  }

  .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
  .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes blink {
    0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
    40%           { opacity: 1;   transform: scale(1.2); }
  }

  /* ─── Input area ─── */
  .input-area {
    background: var(--bg2);
    border-top: 2px solid var(--border);
    padding: 12px 24px 16px;
    flex-shrink: 0;
  }

  .input-wrapper {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--bg3);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 14px;
    transition: border-color 0.2s;
  }

  .input-wrapper:focus-within {
    border-color: var(--cyan);
    box-shadow: 0 0 0 2px rgba(0, 212, 255, 0.1);
  }

  .input-prompt {
    color: var(--cyan);
    font-size: 14px;
    font-weight: bold;
    flex-shrink: 0;
    user-select: none;
  }

  #user-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    resize: none;
    min-height: 22px;
    max-height: 120px;
    overflow-y: auto;
    caret-color: var(--cyan);
  }

  #user-input::placeholder { color: var(--dim); }

  .send-btn {
    background: var(--cyan);
    border: none;
    border-radius: 4px;
    color: var(--bg);
    font-family: var(--font-pixel);
    font-size: 7px;
    padding: 7px 12px;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s, transform 0.1s;
    letter-spacing: 1px;
  }

  .send-btn:hover   { background: #00eeff; }
  .send-btn:active  { transform: scale(0.95); }
  .send-btn:disabled {
    background: var(--dim);
    cursor: not-allowed;
    transform: none;
  }

  .input-hint {
    margin-top: 8px;
    font-size: 10px;
    color: var(--dim);
    display: flex;
    gap: 16px;
  }

  .hint-key {
    background: var(--bg3);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 5px;
    font-size: 9px;
    color: var(--text-dim);
    font-family: var(--font-mono);
  }

  /* ─── Slash commands ─── */
  .slash-cmd {
    color: var(--purple);
    font-weight: bold;
  }

  /* ─── Welcome message ─── */
  .welcome-msg .msg-body {
    color: var(--text-dim);
  }

  /* Scanline overlay */
  body::after {
    content: '';
    position: fixed;
    inset: 0;
    background: repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      rgba(0,0,0,0.03) 2px,
      rgba(0,0,0,0.03) 4px
    );
    pointer-events: none;
    z-index: 9999;
  }
</style>
</head>
<body>
<div class="shell">

  <!-- ─── Header ─── -->
  <header class="header">
    <div class="header-top">
      <div class="header-left">
        <div class="welcome-text">Welcome to</div>
        <div class="logo">SHISYA</div>
        <div class="logo-sub">Neural Codebase Agent</div>
        <div class="tagline">
          Shisya can search, analyze, and explain your codebase using a<br>
          living knowledge graph. Type a question or <span class="slash-cmd">/help</span> for commands.
        </div>
      </div>
      <svg class="mascot" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
        <rect x="16" y="20" width="32" height="28" fill="#1a1a2e"/>
        <rect x="14" y="22" width="36" height="24" fill="#16213e"/>
        <rect x="18" y="8" width="28" height="20" fill="#0f3460"/>
        <rect x="16" y="10" width="32" height="18" fill="#533483"/>
        <rect x="20" y="14" width="24" height="10" fill="#00d4ff" opacity="0.15"/>
        <rect x="20" y="14" width="24" height="10" fill="none" stroke="#00d4ff" stroke-width="1"/>
        <rect x="22" y="16" width="8" height="6" fill="#00d4ff"/>
        <rect x="34" y="16" width="8" height="6" fill="#00d4ff"/>
        <rect x="24" y="18" width="4" height="2" fill="#ffffff" opacity="0.9"/>
        <rect x="36" y="18" width="4" height="2" fill="#ffffff" opacity="0.9"/>
        <rect x="22" y="30" width="20" height="12" fill="#0f3460"/>
        <rect x="24" y="32" width="4" height="4" fill="#00d4ff" opacity="0.8"/>
        <rect x="30" y="32" width="4" height="4" fill="#533483" opacity="0.8"/>
        <rect x="36" y="32" width="4" height="4" fill="#00d4ff" opacity="0.8"/>
        <rect x="20" y="48" width="10" height="8" fill="#533483"/>
        <rect x="34" y="48" width="10" height="8" fill="#533483"/>
        <rect x="18" y="54" width="14" height="4" fill="#0f3460"/>
        <rect x="32" y="54" width="14" height="4" fill="#0f3460"/>
        <rect x="6" y="24" width="10" height="18" fill="#533483"/>
        <rect x="48" y="24" width="10" height="18" fill="#533483"/>
        <rect x="30" y="4" width="4" height="6" fill="#00d4ff"/>
        <rect x="28" y="2" width="8" height="4" fill="#00d4ff"/>
        <rect x="30" y="0" width="4" height="4" fill="#ffffff" opacity="0.95"/>
      </svg>
    </div>

    <div class="status-bar">
      <div class="status-item">
        <span class="dot dot-green"></span>
        Connected to ContextGraph — <strong id="stat-nodes">${nodeCount}</strong> nodes &amp; <strong id="stat-edges">${edgeCount}</strong> edges loaded
      </div>
      <div class="status-item">
        <span class="dot dot-cyan"></span>
        Backend: <strong>${backendType === 'claude' ? '☁ Claude' : '🦙 Ollama'}</strong> &nbsp;·&nbsp; Model: <code style="color:var(--cyan);background:none">${model}</code>
      </div>
    </div>
  </header>

  <!-- ─── Context line ─── -->
  <div class="context-line">
    <span style="color:var(--dim)">~/</span><span class="context-path">${shortRoot}</span>
    <span class="context-branch">[✦ graph]</span>
  </div>

  <!-- ─── Chat area ─── -->
  <div class="chat-area" id="chat"></div>

  <!-- ─── Input ─── -->
  <div class="input-area">
    <div class="input-wrapper">
      <span class="input-prompt">&gt;</span>
      <textarea
        id="user-input"
        placeholder="Ask Shisya anything about your codebase…"
        rows="1"
        autocomplete="off"
        spellcheck="false"
      ></textarea>
      <button class="send-btn" id="send-btn">SEND</button>
    </div>
    <div class="input-hint">
      <span><span class="hint-key">Enter</span> send &nbsp; <span class="hint-key">Shift+Enter</span> newline</span>
      <span><span class="slash-cmd">/help</span> &nbsp; <span class="slash-cmd">/clear</span> &nbsp; <span class="slash-cmd">/stats</span></span>
    </div>
  </div>

</div>

<script>
const chat    = document.getElementById('chat');
const input   = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
let busy = false;

// ─── Auto-resize textarea ─────────────────────────────────────────────
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
});

// ─── Keyboard handler ─────────────────────────────────────────────────
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!busy) send();
  }
});

sendBtn.addEventListener('click', () => { if (!busy) send(); });

// ─── Time helper ─────────────────────────────────────────────────────
function now() {
  return new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ─── Append message ───────────────────────────────────────────────────
function appendMsg(role, text, cls = '') {
  const div = document.createElement('div');
  div.className = 'msg ' + (cls || '');

  const header = document.createElement('div');
  header.className = 'msg-header';

  const roleSpan = document.createElement('span');
  roleSpan.className = role === 'user' ? 'msg-role-user' : role === 'system' ? 'msg-role-system' : 'msg-role-shisya';
  roleSpan.textContent = role === 'user' ? '▸ you' : role === 'system' ? '· system' : '⬡ shisya';

  const timeSpan = document.createElement('span');
  timeSpan.className = 'msg-time';
  timeSpan.textContent = now();

  header.appendChild(roleSpan);
  header.appendChild(timeSpan);

  const body = document.createElement('div');
  body.className = 'msg-body' + (role === 'user' ? ' user-body' : '');
  body.innerHTML = formatText(text);

  div.appendChild(header);
  div.appendChild(body);
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

// ─── Simple markdown-ish formatter ───────────────────────────────────
function formatText(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre style="background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:10px 14px;margin:8px 0;overflow-x:auto;font-size:12px;color:var(--cyan)">$1</pre>')
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:var(--text)">$1</strong>')
    .replace(/^(#{1,3})\s+(.+)$/gm, (_, h, t) => \`<div style="color:var(--cyan);font-weight:bold;margin:8px 0 4px;font-size:\${14 - h.length}px">\${t}</div>\`)
    .replace(/^[-•▸]\s+(.+)$/gm, '<div style="padding-left:16px;margin:2px 0">▸ $1</div>')
    .replace(/\\n/g, '<br>');
}

// ─── Thinking indicator ───────────────────────────────────────────────
function showThinking() {
  const div = document.createElement('div');
  div.className = 'thinking';
  div.id = 'thinking';
  div.innerHTML = \`
    <span style="color:var(--cyan)">⬡ shisya</span>
    <div class="thinking-dots">
      <span></span><span></span><span></span>
    </div>
    <span style="color:var(--dim);font-size:11px">thinking…</span>
  \`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function hideThinking() {
  const t = document.getElementById('thinking');
  if (t) t.remove();
}

// ─── Slash commands ───────────────────────────────────────────────────
function handleSlash(cmd) {
  const parts = cmd.trim().toLowerCase().split(/\\s+/);
  switch (parts[0]) {
    case '/help':
      appendMsg('system', [
        'Available commands:',
        '  /help    — show this help',
        '  /clear   — clear conversation',
        '  /stats   — show graph statistics',
        '  /exit    — close Shisya UI'
      ].join('\\n'), 'welcome-msg');
      return true;
    case '/clear':
      chat.innerHTML = '';
      fetch('/api/clear', { method: 'POST' });
      appendMsg('system', 'Conversation cleared.', 'welcome-msg');
      return true;
    case '/stats':
      fetch('/api/stats')
        .then(r => r.json())
        .then(s => {
          appendMsg('system',
            \`Graph: \${s.nodes} nodes · \${s.edges} active edges · \${s.archived} archived\\nLast decay: \${s.lastDecay}\`,
            'welcome-msg'
          );
        });
      return true;
    case '/exit':
      window.close();
      return true;
  }
  return false;
}

// ─── Send message ─────────────────────────────────────────────────────
async function send() {
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';

  if (text.startsWith('/')) {
    if (handleSlash(text)) return;
  }

  appendMsg('user', text);
  busy = true;
  sendBtn.disabled = true;
  sendBtn.textContent = '…';

  showThinking();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });
    const data = await res.json();
    hideThinking();

    if (data.error) {
      appendMsg('system', '✗ Error: ' + data.error);
    } else {
      appendMsg('shisya', data.response);
      // Update stats
      if (data.stats) {
        document.getElementById('stat-nodes').textContent = data.stats.nodes;
        document.getElementById('stat-edges').textContent = data.stats.edges;
      }
    }
  } catch (err) {
    hideThinking();
    appendMsg('system', '✗ Network error: ' + err.message);
  }

  busy = false;
  sendBtn.disabled = false;
  sendBtn.textContent = 'SEND';
  input.focus();
}

// ─── Welcome message ──────────────────────────────────────────────────
appendMsg('shisya',
  'Hi! I\\'m Shisya, your neural codebase agent.\\n\\n' +
  'I have your project knowledge graph loaded with ${nodeCount} nodes.\\n' +
  'Ask me anything about your codebase, or try:\\n\\n' +
  '  • "what are the most important files?"\\n' +
  '  • "how does the decay system work?"\\n' +
  '  • "find the path between schema.ts and server.ts"\\n\\n' +
  'Type /help for all commands.',
  'welcome-msg'
);

input.focus();
</script>
</body>
</html>`;
}

// ─── UI Server class ───────────────────────────────────────────────────────────

export class ShisyaUIServer {
  private db: GraphDB;
  private app: express.Application;
  private server: http.Server | null = null;
  private agent: ContextGraphAgent | null = null;
  private projectRoot: string;
  private backendType: string;
  private model: string;

  constructor(
    db: GraphDB,
    projectRoot: string,
    agentOptions: { backend?: BackendType; model?: string; noMemory?: boolean }
  ) {
    this.db = db;
    this.projectRoot = projectRoot;
    this.backendType = agentOptions.backend ?? 'auto';
    this.model = agentOptions.model ?? 'auto';
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
  }

  private async ensureAgent(): Promise<ContextGraphAgent> {
    if (this.agent) return this.agent;
    const a = new ContextGraphAgent({
      db: this.db,
      projectRoot: this.projectRoot,
    });
    const info = await a.init();
    this.backendType = info.backendType;
    this.model = info.model;
    this.agent = a;
    return a;
  }

  private setupRoutes(): void {
    // ── Serve main UI ──────────────────────────────────────────────────
    this.app.get('/', async (_req, res) => {
      const stats = this.db.getStats();
      // Ensure agent is init'd so we have real backend info
      try { await this.ensureAgent(); } catch { /* will show error in chat */ }
      const html = buildHTML(
        this.projectRoot,
        stats.nodes,
        stats.edges,
        this.backendType,
        this.model
      );
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    });

    // ── Chat API ───────────────────────────────────────────────────────
    this.app.post('/api/chat', async (req, res) => {
      const { message } = req.body as { message?: string };
      if (!message) {
        res.json({ error: 'No message provided' });
        return;
      }
      try {
        const agent = await this.ensureAgent();
        const response = await agent.turn(message);
        const stats = this.db.getStats();
        res.json({ response, stats });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.json({ error: msg });
      }
    });

    // ── Stats API ──────────────────────────────────────────────────────
    this.app.get('/api/stats', (_req, res) => {
      res.json(this.db.getStats());
    });

    // ── Clear conversation ─────────────────────────────────────────────
    this.app.post('/api/clear', (_req, res) => {
      this.agent?.clearHistory();
      res.json({ ok: true });
    });
  }

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(UI_PORT, () => {
        const url = `http://localhost:${UI_PORT}`;
        resolve(url);
      });
      this.server.on('error', reject);
    });
  }

  stop(): void {
    this.server?.close();
  }
}
