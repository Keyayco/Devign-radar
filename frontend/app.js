'use strict';

/**
 * app.js — Reddit Lead Intel Dashboard
 * ──────────────────────────────────────
 * Pure vanilla JS. No frameworks. No build step.
 *
 * window.API_BASE is injected by server.js before this script loads.
 * Falls back to '/api' for local dev without the proxy.
 */

const API = window.API_BASE || '/api';

// ── State ────────────────────────────────────────────────────────────────────
let leads      = [];   // all loaded leads
let filter     = 'all';
let sortKey    = 'created_at';
let isRunning  = false;
let firstLog   = true;

// ── Utility helpers ──────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ── SSE connection ───────────────────────────────────────────────────────────
let es = null;

function connectSSE() {
  if (es) es.close();
  es = new EventSource(API + '/stream');

  es.onopen = () => {
    $('sse-dot').classList.add('live');
    $('sse-lbl').textContent = 'Live';
  };
  es.onerror = () => {
    $('sse-dot').classList.remove('live');
    $('sse-lbl').textContent = 'SSE';
    // EventSource auto-reconnects — no manual retry needed
  };

  es.addEventListener('log',    e => appendLog(JSON.parse(e.data).line));
  es.addEventListener('lead',   e => onNewLead(JSON.parse(e.data)));
  es.addEventListener('stats',  e => onStats(JSON.parse(e.data)));
  es.addEventListener('status', e => onStatus(JSON.parse(e.data).running));
}

// ── Status / UI ──────────────────────────────────────────────────────────────
function onStatus(running) {
  if (running === isRunning) return;
  isRunning = running;
  const badge = $('status-badge');
  if (running) {
    badge.className = 'status-badge running';
    $('status-text').textContent = 'Running';
    $('btn-start').disabled = true;
    $('btn-stop').disabled  = false;
  } else {
    badge.className = 'status-badge';
    $('status-text').textContent = 'Stopped';
    $('btn-start').disabled = false;
    $('btn-stop').disabled  = true;
  }
}

// ── Stats from SSE ───────────────────────────────────────────────────────────
function onStats(s) {
  if (s.cycles      != null) set('s-cycles', s.cycles);
  if (s.matches     != null) set('s-leads',  s.matches);
  if (s.alerts_sent != null) set('s-alerts', s.alerts_sent);
  if (s.dupes_skipped != null) set('s-dupes', s.dupes_skipped);
  if (s.last_scan_ms  != null && s.last_scan_ms > 0)
    set('s-scan', (s.last_scan_ms / 1000).toFixed(1) + 's');
}

// Load DB aggregate stats (avg score etc.) — called on page load and after new lead
async function loadDbStats() {
  try {
    const r = await fetch(API + '/status');
    const d = await r.json();
    if (d.db) {
      if (d.db.avg_score != null) set('s-avg', d.db.avg_score || '—');
      if (d.db.total_dupes != null) set('s-dupes', d.db.total_dupes);
    }
    if (d.stats) onStats(d.stats);
    if (d.running != null) onStatus(d.running);
  } catch {}
}

// ── Live log ─────────────────────────────────────────────────────────────────
const LOG_LEVELS = ['FEED','MATCH','TELEGRAM','ERROR','WARN','SYSTEM','DB','DEDUP','SCORE','STDERR'];

function logClass(line) {
  for (const lvl of LOG_LEVELS) {
    if (line.includes(`[${lvl}]`)) return `ll-${lvl}`;
  }
  return '';
}

function appendLog(line) {
  const box = $('log-box');
  if (firstLog) { box.innerHTML = ''; firstLog = false; }

  const div = document.createElement('div');
  div.className = 'log-line ' + logClass(line);
  div.textContent = line;
  box.appendChild(div);

  // Cap DOM at 800 lines for performance
  while (box.children.length > 800) box.removeChild(box.firstChild);

  if ($('auto-scroll').checked) box.scrollTop = box.scrollHeight;
}

// ── Controls ─────────────────────────────────────────────────────────────────
async function startMonitor() {
  $('btn-start').disabled = true;
  // Clear log for new session
  $('log-box').innerHTML = '';
  firstLog = true;
  try {
    const r = await fetch(API + '/start', { method: 'POST' });
    const d = await r.json();
    if (!d.ok) {
      showToast(d.msg || 'Start failed');
      $('btn-start').disabled = false;
    }
  } catch (e) {
    showToast('Network error');
    $('btn-start').disabled = false;
  }
}

async function stopMonitor() {
  $('btn-stop').disabled = true;
  try {
    await fetch(API + '/stop', { method: 'POST' });
  } catch {
    $('btn-stop').disabled = false;
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
}
document.querySelectorAll('.tab').forEach(b =>
  b.addEventListener('click', () => switchTab(b.dataset.tab))
);

// ── Leads ─────────────────────────────────────────────────────────────────────
function setFilter(f) {
  filter = f;
  document.querySelectorAll('.pill').forEach(p =>
    p.classList.toggle('active', p.dataset.filter === f)
  );
  renderLeads();
}

function setSort(s) {
  sortKey = s;
  renderLeads();
}

function onNewLead(lead) {
  // Avoid duplicates if page was loaded after SSE connected
  if (leads.find(l => l.id === lead.id)) return;
  leads.unshift(lead);
  renderLeads();
  updateLeadCount();
  loadDbStats();

  // Flash the Leads tab
  const tab = document.querySelector('[data-tab="leads"]');
  tab.style.color = 'var(--green)';
  setTimeout(() => { tab.style.color = ''; }, 1500);
}

function sortedLeads(arr) {
  switch (sortKey) {
    case 'score': return [...arr].sort((a,b) => b.score - a.score);
    case 'value': return [...arr].sort((a,b) => (b.lead_value||50) - (a.lead_value||50));
    default:      return [...arr].sort((a,b) => (b.created_utc||0) - (a.created_utc||0));
  }
}

function renderLeads() {
  const filtered = filter === 'all' ? leads : leads.filter(l => l.intent === filter);
  const sorted   = sortedLeads(filtered);
  const tbody    = $('leads-tbody');
  const meta     = $('leads-meta');
  if (meta) meta.textContent = `${leads.length} total · ${filtered.length} shown`;

  if (sorted.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-cell">No ${filter === 'all' ? '' : filter + ' intent '}leads yet</td></tr>`;
    return;
  }

  tbody.innerHTML = sorted.map(renderRow).join('');
}

function renderRow(l) {
  const v = l.lead_value != null ? l.lead_value : 50;
  const valCls = v >= 70 ? 'val-high' : v >= 50 ? 'val-med' : v >= 30 ? 'val-low' : 'val-dim';

  return `<tr>
    <td>
      <div class="score-wrap">
        <div class="score-bar"><div class="score-fill ${l.intent}" style="width:${l.score}%"></div></div>
        <span class="score-num">${l.score}</span>
      </div>
    </td>
    <td><span class="intent intent-${l.intent}">${l.intent}</span></td>
    <td><span class="val-num ${valCls}">${v}</span></td>
    <td style="color:var(--muted);font-size:.75rem;white-space:nowrap">${esc(l.subreddit)}</td>
    <td class="title-cell">
      <a href="${esc(l.url)}" target="_blank" rel="noopener">
        <span class="title-text">${esc(l.title)}</span>
      </a>
    </td>
    <td><span class="kw">${esc(l.matched_keyword)}</span></td>
    <td>${ageLabel(l)}</td>
    <td>
      <select class="status-sel s-${l.status}"
              onchange="handleStatusChange(${l.id}, this.value, this)">
        <option value="new"       ${l.status==='new'?'selected':''}>🔵 New</option>
        <option value="contacted" ${l.status==='contacted'?'selected':''}>📧 Contacted</option>
        <option value="ignored"   ${l.status==='ignored'?'selected':''}>🚫 Ignored</option>
        <option value="won"       ${l.status==='won'?'selected':''}>✅ Won</option>
      </select>
    </td>
    <td>
      <div class="action-group">
        <a href="${esc(l.url)}" target="_blank" rel="noopener" class="act-btn" title="Open on Reddit">↗</a>
        <button class="act-btn" onclick="copyLink('${esc(l.url)}')" title="Copy link">📋</button>
        <button class="act-btn ${l.status==='contacted'?'act-on':''}"
                onclick="quickStatus(${l.id},'contacted')" title="Mark Contacted">📧</button>
        <button class="act-btn ${l.status==='won'?'act-on':''}"
                onclick="quickStatus(${l.id},'won')" title="Mark Won">✅</button>
      </div>
    </td>
  </tr>`;
}

function updateLeadCount() {
  set('lead-count', leads.length);
}

// ── Lead actions ──────────────────────────────────────────────────────────────
function handleStatusChange(id, status, sel) {
  sel.className = 'status-sel s-' + status;
  const lead = leads.find(l => l.id === id);
  if (lead) lead.status = status;
  updateLeadStatus(id, status);
}

async function updateLeadStatus(id, status) {
  try {
    await fetch(`${API}/leads/${id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status }),
    });
  } catch {}
}

async function quickStatus(id, status) {
  const lead = leads.find(l => l.id === id);
  if (!lead) return;
  // Toggle off if already that status
  const newStatus = lead.status === status ? 'new' : status;
  lead.status = newStatus;
  renderLeads();
  await updateLeadStatus(id, newStatus);
  showToast(newStatus === 'new' ? 'Reset to New' : `Marked ${newStatus}`);
}

function copyLink(url) {
  navigator.clipboard.writeText(url)
    .then(() => showToast('Link copied!'))
    .catch(() => {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Link copied!');
    });
}

// ── Age badges ────────────────────────────────────────────────────────────────
function ageLabel(lead) {
  let mins;
  if (lead.created_utc) {
    mins = Math.floor((Date.now() / 1000 - lead.created_utc) / 60);
  } else if (lead.created_at) {
    mins = Math.floor((Date.now() - new Date(lead.created_at + 'Z').getTime()) / 60000);
  } else {
    return '';
  }

  if (mins < 0)   mins = 0;
  if (mins < 2)   return '<span class="age-badge age-now">Just now</span>';
  if (mins < 60)  return `<span class="age-badge age-recent">${mins}m ago</span>`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `<span class="age-badge age-today">${hrs}h ago</span>`;
  const days = Math.floor(hrs / 24);
  return `<span class="age-badge">${days}d ago</span>`;
}

// ── Config form ───────────────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const r = await fetch(API + '/config');
    const d = await r.json();

    const tokenEl = $('token-status');
    if (d.token_configured) {
      tokenEl.textContent = '● Configured'; tokenEl.className = 'cfg-status cfg-yes';
    } else {
      tokenEl.textContent = '○ Not configured'; tokenEl.className = 'cfg-status cfg-no';
    }

    const chatEl = $('chatid-status');
    if (d.chat_id_configured) {
      chatEl.textContent = '● Configured'; chatEl.className = 'cfg-status cfg-yes';
      $('cfg-chatid').placeholder = d.chat_id_display || 'configured';
    } else {
      chatEl.textContent = '○ Not configured'; chatEl.className = 'cfg-status cfg-no';
    }

    $('cfg-interval').value  = d.interval  || 120;
    $('cfg-feeds').value     = (d.feeds    || []).join('\n');
    $('cfg-keywords').value  = (d.keywords || []).join('\n');
  } catch {}
}

async function saveConfig() {
  const tokenVal = $('cfg-token').value.trim();
  const chatVal  = $('cfg-chatid').value.trim();
  const payload  = {
    interval: parseInt($('cfg-interval').value, 10) || 120,
    feeds:    $('cfg-feeds').value.split('\n').map(s => s.trim()).filter(Boolean),
    keywords: $('cfg-keywords').value.split('\n').map(s => s.trim()).filter(Boolean),
  };
  if (tokenVal) payload.bot_token = tokenVal;
  if (chatVal)  payload.chat_id   = chatVal;

  try {
    const r = await fetch(API + '/config', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const d = await r.json();
    if (d.ok) {
      $('cfg-token').value = '';
      const msg = $('save-msg');
      msg.classList.add('show');
      setTimeout(() => msg.classList.remove('show'), 2500);
      await loadConfig();
    }
  } catch { showToast('Save failed — check network'); }
}

// ── Page bootstrap ────────────────────────────────────────────────────────────
async function init() {
  connectSSE();

  // Load logs and leads in parallel
  const [logsRes, leadsRes] = await Promise.all([
    fetch(API + '/logs').catch(() => null),
    fetch(API + '/leads').catch(() => null),
  ]);

  if (logsRes && logsRes.ok) {
    const d = await logsRes.json();
    (d.lines || []).forEach(appendLog);
  }

  if (leadsRes && leadsRes.ok) {
    const d = await leadsRes.json();
    leads = d.leads || [];
    renderLeads();
    updateLeadCount();
  }

  await Promise.all([loadConfig(), loadDbStats()]);
}

init();

