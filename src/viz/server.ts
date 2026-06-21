// src/viz/server.ts
// D3.js force graph visualization server on localhost:7331

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import type { GraphDB } from '../graph/kuzu.js';
import { NODE_TYPE_COLORS } from '../graph/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIZ_PORT = 7331;

export class VizServer {
  private db: GraphDB;
  private app: express.Application;
  private server: http.Server | null = null;
  private sseClients: express.Response[] = [];

  constructor(db: GraphDB) {
    this.db = db;
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // API: graph data
    this.app.get('/api/graph', (_req, res) => {
      const nodes = this.db.getAllNodes().map((n) => ({
        id: n.id,
        label: n.label,
        type: n.type,
        color: NODE_TYPE_COLORS[n.type] ?? '#888',
        accessCount: n.accessCount ?? 0,
        filePath: n.filePath,
        content: n.content?.slice(0, 300),
      }));

      const edges = this.db.getAllEdges().map((e) => ({
        source: e.sourceId,
        target: e.targetId,
        type: e.type,
        weight: e.weight ?? 0,
      }));

      const stats = this.db.getStats();
      res.json({ nodes, edges, stats });
    });

    // SSE: live updates
    this.app.get('/api/events', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      this.sseClients.push(res);

      req.on('close', () => {
        this.sseClients = this.sseClients.filter((c) => c !== res);
      });
    });

    // HTML: D3 visualization
    this.app.get('/', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.send(this.generateHTML());
    });
  }

  notifyUpdate(): void {
    for (const client of this.sseClients) {
      client.write('data: update\n\n');
    }
  }

  start(): Promise<string> {
    return new Promise((resolve) => {
      this.server = this.app.listen(VIZ_PORT, () => {
        const url = `http://localhost:${VIZ_PORT}`;
        console.error(`[VizServer] Running at ${url}`);
        resolve(url);
      });
    });
  }

  stop(): void {
    this.server?.close();
  }

  private generateHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ContextGraph — Neural Knowledge Graph</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0a0b0e;
    --surface: #12141a;
    --surface2: #1a1d26;
    --border: #2a2d3a;
    --text: #e2e8f0;
    --text-dim: #64748b;
    --accent: #6366f1;
    --accent2: #8b5cf6;
  }

  body {
    font-family: 'Inter', sans-serif;
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* ── Header ── */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    z-index: 10;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 700;
    font-size: 16px;
    background: linear-gradient(135deg, #6366f1, #a78bfa);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .logo-icon {
    width: 28px; height: 28px;
    background: linear-gradient(135deg, #6366f1, #a78bfa);
    border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px;
    -webkit-text-fill-color: white;
  }

  .stats-bar {
    display: flex; gap: 20px;
    font-size: 12px; color: var(--text-dim);
  }

  .stat { display: flex; align-items: center; gap: 6px; }
  .stat-val { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }

  .controls {
    display: flex; gap: 8px; align-items: center;
  }

  input#search {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 12px;
    color: var(--text);
    font-size: 13px;
    width: 200px;
    outline: none;
    transition: border-color 0.2s;
  }
  input#search:focus { border-color: var(--accent); }

  button.btn {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 12px;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s;
  }
  button.btn:hover { border-color: var(--accent); color: var(--accent); }

  /* ── Layout ── */
  .main {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  /* ── Graph canvas ── */
  #graph { flex: 1; }

  svg { width: 100%; height: 100%; }

  .link {
    stroke-opacity: 0.4;
    transition: stroke-opacity 0.2s;
  }
  .link:hover, .link.highlighted { stroke-opacity: 0.9; }

  .node circle {
    stroke: rgba(255,255,255,0.15);
    stroke-width: 1.5;
    transition: all 0.2s;
    cursor: pointer;
  }
  .node circle:hover, .node.highlighted circle {
    stroke: rgba(255,255,255,0.7);
    stroke-width: 2.5;
    filter: brightness(1.3);
  }

  .node text {
    font-size: 10px;
    fill: #cbd5e1;
    pointer-events: none;
    font-family: 'Inter', sans-serif;
    text-shadow: 0 1px 3px #0a0b0e;
  }

  /* ── Legend ── */
  .legend {
    position: absolute;
    bottom: 20px;
    left: 20px;
    background: rgba(18,20,26,0.95);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
    font-size: 11px;
    backdrop-filter: blur(8px);
  }
  .legend-title { font-weight: 600; margin-bottom: 8px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.08em; }
  .legend-item { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }

  /* ── Info panel ── */
  #panel {
    width: 300px;
    background: var(--surface);
    border-left: 1px solid var(--border);
    padding: 20px;
    overflow-y: auto;
    flex-shrink: 0;
    display: none;
  }
  #panel.open { display: block; }

  .panel-type {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }

  .panel-label { font-size: 18px; font-weight: 600; margin-bottom: 12px; line-height: 1.3; }

  .panel-section { margin-top: 16px; }
  .panel-section-title { font-size: 11px; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }

  .edge-item {
    padding: 6px 10px;
    border-radius: 8px;
    background: var(--surface2);
    border: 1px solid var(--border);
    margin-bottom: 6px;
    font-size: 12px;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .edge-item:hover { border-color: var(--accent); }
  .edge-item .edge-label { font-weight: 500; }
  .edge-item .edge-meta { color: var(--text-dim); margin-top: 2px; font-size: 11px; }

  .weight-bar {
    height: 4px;
    border-radius: 2px;
    background: var(--surface2);
    margin-top: 4px;
    overflow: hidden;
  }
  .weight-fill {
    height: 100%;
    border-radius: 2px;
    background: linear-gradient(90deg, #6366f1, #a78bfa);
  }

  .close-btn {
    float: right;
    cursor: pointer;
    color: var(--text-dim);
    font-size: 18px;
    line-height: 1;
    transition: color 0.15s;
  }
  .close-btn:hover { color: var(--text); }

  /* ── Loading ── */
  #loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    flex-direction: column;
    gap: 16px;
  }
  .spinner {
    width: 40px; height: 40px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .live-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #34d399;
    animation: pulse 2s infinite;
  }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.5;transform:scale(0.8)} }
</style>
</head>
<body>

<header>
  <div class="logo">
    <div class="logo-icon">⬡</div>
    ContextGraph
  </div>
  <div class="stats-bar">
    <div class="stat"><span>Nodes</span><span class="stat-val" id="stat-nodes">—</span></div>
    <div class="stat"><span>Edges</span><span class="stat-val" id="stat-edges">—</span></div>
    <div class="stat"><span>Archived</span><span class="stat-val" id="stat-archived">—</span></div>
    <div class="stat"><div class="live-dot"></div><span>Live</span></div>
  </div>
  <div class="controls">
    <input type="text" id="search" placeholder="Search nodes…">
    <button class="btn" id="btn-reset">Reset zoom</button>
    <button class="btn" id="btn-refresh">Refresh</button>
  </div>
</header>

<div class="main">
  <div id="graph" style="position:relative;">
    <div id="loading">
      <div class="spinner"></div>
      <div style="color:var(--text-dim);font-size:14px;">Loading graph…</div>
    </div>
    <svg id="svg"></svg>
    <div class="legend" id="legend"></div>
  </div>
  <div id="panel">
    <span class="close-btn" id="panel-close">×</span>
    <div id="panel-content"></div>
  </div>
</div>

<script type="module">
// Import D3 from CDN
const D3_URL = 'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js';

// Load D3
async function loadD3() {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = D3_URL;
    s.onload = resolve;
    document.head.appendChild(s);
  });
}

const NODE_COLORS = ${JSON.stringify(NODE_TYPE_COLORS)};

let simulation, svgEl, linkG, nodeG, zoomBehavior;
let graphData = { nodes: [], edges: [] };
let selectedNode = null;

async function init() {
  await loadD3();
  const d3 = window.d3;
  await loadGraph();
  buildLegend();
  setupEventSource();

  document.getElementById('btn-refresh').addEventListener('click', () => loadGraph());
  document.getElementById('btn-reset').addEventListener('click', () => {
    svgEl.transition().duration(500).call(zoomBehavior.transform, d3.zoomIdentity);
  });

  const searchEl = document.getElementById('search');
  searchEl.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    d3.selectAll('.node').classed('highlighted', (d) => q && (d.label.toLowerCase().includes(q) || d.id.toLowerCase().includes(q)));
  });

  document.getElementById('panel-close').addEventListener('click', () => {
    document.getElementById('panel').classList.remove('open');
  });
}

async function loadGraph() {
  const res = await fetch('/api/graph');
  const data = await res.json();
  graphData = data;

  document.getElementById('stat-nodes').textContent = data.stats.nodes;
  document.getElementById('stat-edges').textContent = data.stats.edges;
  document.getElementById('stat-archived').textContent = data.stats.archived;

  renderGraph(data);
  document.getElementById('loading').style.display = 'none';
}

function renderGraph(data) {
  const d3 = window.d3;
  const container = document.getElementById('graph');
  const W = container.clientWidth, H = container.clientHeight;

  const svg = d3.select('#svg');
  svg.selectAll('*').remove();

  // Zoom
  zoomBehavior = d3.zoom().scaleExtent([0.05, 8]).on('zoom', (e) => g.attr('transform', e.transform));
  svg.call(zoomBehavior);

  const g = svg.append('g');
  svgEl = svg;

  // Arrow markers
  const defs = svg.append('defs');
  const edgeTypes = [...new Set(data.edges.map(e => e.type))];
  edgeTypes.forEach(type => {
    defs.append('marker')
      .attr('id', 'arrow-' + type)
      .attr('viewBox', '0 -5 10 10').attr('refX', 18).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', 'rgba(255,255,255,0.25)');
  });

  // Nodes by id map
  const nodeMap = new Map(data.nodes.map(n => [n.id, n]));

  // Build links with node references
  const links = data.edges
    .filter(e => nodeMap.has(e.source) && nodeMap.has(e.target))
    .map(e => ({ ...e, source: e.source, target: e.target }));

  // Force simulation
  simulation = d3.forceSimulation(data.nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(d => 80 + (1 - d.weight) * 100))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collision', d3.forceCollide().radius(d => nodeRadius(d) + 4));

  // Links
  linkG = g.append('g').attr('class', 'links');
  const link = linkG.selectAll('.link')
    .data(links).join('line')
    .attr('class', 'link')
    .attr('stroke', '#3a4060')
    .attr('stroke-width', d => Math.max(0.5, d.weight * 3))
    .attr('marker-end', d => 'url(#arrow-' + d.type + ')');

  // Nodes
  nodeG = g.append('g').attr('class', 'nodes');
  const node = nodeG.selectAll('.node')
    .data(data.nodes).join('g')
    .attr('class', 'node')
    .call(d3.drag()
      .on('start', dragStart)
      .on('drag', dragged)
      .on('end', dragEnd))
    .on('click', (e, d) => showPanel(d, data));

  node.append('circle')
    .attr('r', d => nodeRadius(d))
    .attr('fill', d => NODE_COLORS[d.type] || '#888')
    .attr('fill-opacity', 0.85);

  // Pulse ring on high-access nodes
  node.filter(d => d.accessCount > 5).append('circle')
    .attr('r', d => nodeRadius(d) + 4)
    .attr('fill', 'none')
    .attr('stroke', d => NODE_COLORS[d.type] || '#888')
    .attr('stroke-width', 1)
    .attr('stroke-opacity', 0.4)
    .attr('stroke-dasharray', '3 3');

  node.append('text')
    .attr('dy', d => nodeRadius(d) + 12)
    .attr('text-anchor', 'middle')
    .text(d => d.label.length > 24 ? d.label.slice(0, 22) + '…' : d.label);

  simulation.on('tick', () => {
    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
  });

  function dragStart(e, d) {
    if (!e.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x; d.fy = d.y;
  }
  function dragged(e, d) { d.fx = e.x; d.fy = e.y; }
  function dragEnd(e, d) {
    if (!e.active) simulation.alphaTarget(0);
    d.fx = null; d.fy = null;
  }
}

function nodeRadius(d) {
  const base = { file: 7, symbol: 5, decision: 8, bug: 6, concept: 6, session: 9, pattern: 7, tool: 6 };
  const r = base[d.type] ?? 5;
  return r + Math.min(d.accessCount ?? 0, 10) * 0.4;
}

function showPanel(node, data) {
  const panel = document.getElementById('panel');
  const content = document.getElementById('panel-content');
  panel.classList.add('open');

  const outEdges = data.edges.filter(e => e.source === node.id || (e.source && e.source.id === node.id));
  const inEdges  = data.edges.filter(e => e.target === node.id || (e.target && e.target.id === node.id));

  const nodeMap = new Map(data.nodes.map(n => [n.id, n]));

  content.innerHTML = \`
    <div class="panel-type" style="background:\${NODE_COLORS[node.type]}22;color:\${NODE_COLORS[node.type]}">\${node.type}</div>
    <div class="panel-label">\${node.label}</div>
    \${node.filePath ? \`<div style="font-size:11px;color:var(--text-dim);font-family:'JetBrains Mono',monospace;margin-bottom:12px;">\${node.filePath}</div>\` : ''}

    \${node.content ? \`
    <div class="panel-section">
      <div class="panel-section-title">Content</div>
      <div style="font-size:12px;color:var(--text-dim);background:var(--surface2);padding:10px;border-radius:8px;font-family:'JetBrains Mono',monospace;max-height:120px;overflow:auto;">\${node.content}</div>
    </div>\` : ''}

    <div class="panel-section">
      <div class="panel-section-title">Access Count</div>
      <div style="font-size:24px;font-weight:700;">\${node.accessCount ?? 0}×</div>
    </div>

    \${outEdges.length > 0 ? \`
    <div class="panel-section">
      <div class="panel-section-title">References → (\${outEdges.length})</div>
      \${outEdges.slice(0, 8).map(e => {
        const tid = e.target?.id ?? e.target;
        const tn = nodeMap.get(tid);
        return \`<div class="edge-item">
          <div class="edge-label">\${tn?.label ?? tid}</div>
          <div class="edge-meta">\${e.type} · w=\${(e.weight||0).toFixed(2)}</div>
          <div class="weight-bar"><div class="weight-fill" style="width:\${(e.weight||0)*100}%"></div></div>
        </div>\`;
      }).join('')}
    </div>\` : ''}

    \${inEdges.length > 0 ? \`
    <div class="panel-section">
      <div class="panel-section-title">Referenced by ← (\${inEdges.length})</div>
      \${inEdges.slice(0, 8).map(e => {
        const sid = e.source?.id ?? e.source;
        const sn = nodeMap.get(sid);
        return \`<div class="edge-item">
          <div class="edge-label">\${sn?.label ?? sid}</div>
          <div class="edge-meta">\${e.type} · w=\${(e.weight||0).toFixed(2)}</div>
          <div class="weight-bar"><div class="weight-fill" style="width:\${(e.weight||0)*100}%"></div></div>
        </div>\`;
      }).join('')}
    </div>\` : ''}
  \`;
}

function buildLegend() {
  const legend = document.getElementById('legend');
  const items = Object.entries(NODE_COLORS).map(([type, color]) =>
    \`<div class="legend-item"><div class="legend-dot" style="background:\${color}"></div>\${type}</div>\`
  ).join('');
  legend.innerHTML = \`<div class="legend-title">Node Types</div>\${items}\`;
}

function setupEventSource() {
  const es = new EventSource('/api/events');
  es.onmessage = () => loadGraph();
  es.onerror = () => setTimeout(() => setupEventSource(), 5000);
}

init().catch(console.error);
</script>
</body>
</html>`;
  }
}
