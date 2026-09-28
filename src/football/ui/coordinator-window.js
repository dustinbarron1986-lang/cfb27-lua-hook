const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function browserCandidates() {
  if (process.platform !== 'win32') return [];
  const roots = [
    process.env['PROGRAMFILES(X86)'],
    process.env.PROGRAMFILES,
    process.env.LOCALAPPDATA
  ].filter(Boolean);
  const rels = [
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['Google', 'Chrome', 'Application', 'chrome.exe']
  ];
  const found = [];
  for (const root of roots) {
    for (const rel of rels) {
      const candidate = path.join(root, ...rel);
      if (fs.existsSync(candidate) && !found.includes(candidate)) found.push(candidate);
    }
  }
  return found;
}

function openAppWindow(url, { width = 760, height = 700 } = {}) {
  if (process.env.CFB27_NO_BROWSER === '1') return { opened: false, mode: 'disabled' };

  try {
    if (process.platform === 'win32') {
      const browser = browserCandidates()[0];
      if (browser) {
        const child = spawn(browser, [
          `--app=${url}`,
          '--new-window',
          `--window-size=${width},${height}`
        ], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });
        child.on('error', () => {});
        child.unref();
        return { opened: true, mode: 'app', browser };
      }

      const child = spawn('cmd.exe', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.on('error', () => {});
      child.unref();
      return { opened: true, mode: 'browser' };
    }

    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return { opened: true, mode: 'browser' };
  } catch {
    return { opened: false, mode: 'failed' };
  }
}

function renderPage(title = 'CFB 27 Offensive Coordinator') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    color-scheme: dark;
    font-family: "Segoe UI", Arial, sans-serif;
    --bg: #0b0f14;
    --panel: #121923;
    --panel2: #17212d;
    --line: #263444;
    --text: #f4f7fb;
    --muted: #9ba9b9;
    --accent: #79e29d;
    --warn: #ffd27a;
    --danger: #ff9292;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: radial-gradient(circle at top, #14202d 0, var(--bg) 48%);
    color: var(--text);
    overflow: hidden;
  }
  main {
    min-height: 100vh;
    padding: 18px 20px 20px;
    display: grid;
    grid-template-rows: auto auto auto 1fr auto;
    gap: 13px;
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .title {
    font-size: 14px;
    font-weight: 800;
    letter-spacing: .12em;
    color: #dfe8f2;
  }
  .live {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    font-weight: 750;
    color: var(--muted);
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #526273;
    box-shadow: 0 0 0 3px rgba(82,98,115,.15);
  }
  .dot.on { background: var(--accent); box-shadow: 0 0 0 3px rgba(121,226,157,.13), 0 0 12px rgba(121,226,157,.35); }
  .situation {
    min-height: 29px;
    display: flex;
    align-items: center;
    gap: 8px;
    color: #cad4df;
    font-size: 17px;
    font-weight: 700;
    white-space: nowrap;
  }
  .pill {
    border: 1px solid var(--line);
    background: rgba(18,25,35,.72);
    border-radius: 999px;
    padding: 5px 10px;
  }
  .stage {
    min-height: 0;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: linear-gradient(180deg, rgba(23,33,45,.95), rgba(14,20,28,.96));
    padding: 20px 22px;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .eyebrow {
    color: var(--accent);
    font-size: 13px;
    font-weight: 850;
    letter-spacing: .13em;
    margin-bottom: 8px;
  }
  .play {
    font-size: clamp(32px, 7vw, 50px);
    line-height: 1.02;
    font-weight: 900;
    letter-spacing: -.025em;
    text-wrap: balance;
  }
  .formation {
    margin-top: 11px;
    font-size: clamp(21px, 4.2vw, 30px);
    line-height: 1.08;
    font-weight: 750;
    color: #d6e0eb;
  }
  .why, .read {
    margin-top: 18px;
    padding-top: 15px;
    border-top: 1px solid var(--line);
    color: #d4dde7;
    font-size: clamp(16px, 2.8vw, 20px);
    line-height: 1.35;
  }
  .smallLabel {
    display: block;
    margin-bottom: 5px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 850;
    letter-spacing: .12em;
  }
  .defense {
    margin-top: 15px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: rgba(8,12,17,.45);
    padding: 11px 13px;
    font-size: 16px;
    color: #e1e7ee;
  }

  .coachGrid {
    display: grid;
    grid-template-columns: minmax(260px, 1.05fr) minmax(260px, .95fr);
    gap: 14px;
    align-items: stretch;
  }
  .diagramCard, .guideCard {
    border: 1px solid var(--line);
    border-radius: 12px;
    background: rgba(8,12,17,.42);
    padding: 12px;
    min-height: 220px;
  }
  .diagramTitle, .guideTitle {
    color: var(--muted);
    font-size: 11px;
    font-weight: 850;
    letter-spacing: .12em;
    margin-bottom: 8px;
  }
  .diagramWrap {
    width: 100%;
    min-height: 188px;
    display: grid;
    place-items: center;
  }
  .diagramWrap svg { width: 100%; height: 190px; overflow: visible; }
  .fieldLine { stroke: #263444; stroke-width: 1; opacity: .9; }
  .oline { fill: #dfe8f2; }
  .skill { fill: #86a8c9; }
  .qb { fill: #ffd27a; }
  .route { fill: none; stroke: #79e29d; stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; }
  .route.secondary { stroke: #9cc8ff; stroke-width: 4; }
  .route.tertiary { stroke: #c7b6ff; stroke-width: 3.5; }
  .runLane { fill: rgba(121,226,157,.18); stroke: #79e29d; stroke-width: 2; stroke-dasharray: 7 5; }
  .routeNum { fill: #0b0f14; stroke: #f4f7fb; stroke-width: 1.5; }
  .routeNumText { fill: #f4f7fb; font-size: 13px; font-weight: 900; text-anchor: middle; dominant-baseline: central; }
  .guideRow { display: grid; grid-template-columns: 30px 1fr; gap: 8px; margin: 0 0 10px; }
  .guideNum { min-width: 30px; height: 28px; padding: 0 6px; border-radius: 8px; display: grid; place-items: center; background: var(--accent); color: #07110b; font-weight: 900; box-sizing: border-box; }
  .route.estimated { stroke-dasharray: 7 6; opacity: .58; }
  .targetButton { fill: #0f141a; stroke: var(--accent); stroke-width: 2; }
  .targetButtonText { fill: #f4f7fb; font-size: 11px; font-weight: 900; text-anchor: middle; dominant-baseline: central; }
  .knowledgeWarn { margin-top: 9px; padding: 9px 10px; border-radius: 9px; background: rgba(255,210,122,.07); border: 1px solid rgba(255,210,122,.22); color: #ffe4ad; font-size: 13px; line-height: 1.3; }
  .guideLabel { font-weight: 850; color: #f4f7fb; font-size: 16px; line-height: 1.15; }
  .guideText { color: #bfcbd8; font-size: 13px; line-height: 1.3; margin-top: 2px; }
  .plainCallout { margin-top: 9px; padding: 9px 10px; border-radius: 9px; background: rgba(121,226,157,.08); border: 1px solid rgba(121,226,157,.23); color: #dff7e7; font-size: 14px; line-height: 1.3; }
  .runHeadline { font-size: 19px; line-height: 1.25; font-weight: 850; color: #f4f7fb; margin-bottom: 10px; }
  .watchBox { padding: 9px 10px; border-radius: 9px; background: rgba(255,210,122,.08); border: 1px solid rgba(255,210,122,.2); color: #ffe4ad; font-size: 14px; line-height: 1.3; margin-bottom: 10px; }
  .runStep { position: relative; padding-left: 18px; margin: 8px 0; color: #cbd6e2; font-size: 14px; line-height: 1.3; }
  .runStep::before { content: '›'; position: absolute; left: 2px; color: var(--accent); font-weight: 900; }

  .footer {
    min-height: 17px;
    display: flex;
    justify-content: space-between;
    gap: 10px;
    color: #728196;
    font-size: 11px;
  }
  .warn { color: var(--warn); }
  .danger { color: var(--danger); }

  .settingsPanel {
    border: 1px solid var(--line);
    border-radius: 10px;
    background: rgba(18,25,35,.55);
    font-size: 13px;
  }
  .settingsPanel summary {
    cursor: pointer;
    padding: 7px 11px;
    color: var(--muted);
    font-weight: 800;
    letter-spacing: .08em;
    list-style: none;
  }
  .settingsPanel summary::-webkit-details-marker { display: none; }
  .settingsBody {
    padding: 4px 12px 11px;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 7px 10px;
    align-items: center;
  }
  .settingsBody label { color: var(--muted); font-size: 12px; font-weight: 700; }
  .settingsBody select {
    background: #0f141a; color: var(--text); border: 1px solid var(--line);
    border-radius: 7px; padding: 6px 8px; font-size: 13px; max-width: 100%;
  }
  .settingsStatus { grid-column: 2; font-size: 11.5px; color: var(--muted); margin-top: -3px; }
  .settingsActions { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; margin-top: 2px; }
  .settingsActions button {
    background: var(--accent); color: #07110b; border: 0; border-radius: 7px;
    padding: 6px 14px; font-weight: 800; font-size: 12px; cursor: pointer;
  }
  .settingsMessage { font-size: 11.5px; color: var(--muted); }
  @media (max-width: 680px) {
    .coachGrid { grid-template-columns: 1fr; }
  }
  @media (max-height: 560px) {
    main { padding: 11px 14px 12px; gap: 8px; }
    .stage { padding: 14px 17px; justify-content: flex-start; overflow-y: auto; }
    .why, .read { margin-top: 12px; padding-top: 10px; }
    .defense { margin-top: 10px; padding: 8px 10px; }
    .diagramCard, .guideCard { min-height: 180px; }
    .diagramWrap { min-height: 150px; }
    .diagramWrap svg { height: 155px; }
  }
</style>
</head>
<body>
<main>
  <div class="top">
    <div id="pageTitle" class="title">CFB 27 COORDINATOR</div>
    <div class="live"><span id="dot" class="dot"></span><span id="liveText">CONNECTING</span></div>
  </div>
  <details class="settingsPanel">
    <summary>⚙ PLAYBOOKS</summary>
    <div class="settingsBody">
      <label for="offenseSelect">Offense</label>
      <select id="offenseSelect"><option value="">Loading…</option></select>
      <div id="offenseStatus" class="settingsStatus"></div>
      <label for="defenseSelect">Defense</label>
      <select id="defenseSelect"><option value="">Loading…</option></select>
      <div id="defenseStatus" class="settingsStatus"></div>
      <div class="settingsActions">
        <button id="savePlaybooks" type="button">Save</button>
        <span id="settingsMessage" class="settingsMessage"></span>
      </div>
    </div>
  </details>
  <div id="situation" class="situation"><span class="pill">Waiting for game state…</span></div>
  <section id="stage" class="stage">
    <div id="eyebrow" class="eyebrow">STARTING</div>
    <div id="play" class="play">Connecting…</div>
    <div id="formation" class="formation"></div>
    <div id="defense" class="defense" hidden></div>
    <div id="detail" class="why"></div>
  </section>
  <div class="footer"><span id="book"></span><span id="game"></span></div>
</main>
<script>
const els = {
  dot: document.getElementById('dot'), liveText: document.getElementById('liveText'),
  situation: document.getElementById('situation'), eyebrow: document.getElementById('eyebrow'),
  play: document.getElementById('play'), formation: document.getElementById('formation'),
  defense: document.getElementById('defense'), detail: document.getElementById('detail'),
  book: document.getElementById('book'), game: document.getElementById('game'),
  pageTitle: document.getElementById('pageTitle')
};
let lastUpdated = null;

// Offense/defense phases have reliable side semantics (each is only ever set
// from one side's code path); 'result' currently has no side indicator in
// state at all (showResult() is wired to the offense path only today, but
// that's an implementation detail, not something this display should assume
// will always remain true) and 'waiting'/'error' precede knowing a side --
// all three get the neutral title rather than a guess.
function titleForPhase(phase) {
  if (phase === 'defensive_huddle' || phase === 'defensive_unavailable') return 'CFB 27 DEFENSIVE COORDINATOR';
  if (phase === 'huddle' || phase === 'selected' || phase === 'audible' || phase === 'unavailable') return 'CFB 27 OFFENSIVE COORDINATOR';
  return 'CFB 27 COORDINATOR';
}

function setFormation(text) {
  if (text) {
    els.formation.hidden = false;
    els.formation.textContent = text;
  } else {
    els.formation.hidden = true;
    els.formation.textContent = '';
  }
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}
function clock(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return '?:??';
  const w = Math.floor(n);
  return Math.floor(w / 60) + ':' + String(w % 60).padStart(2, '0');
}
function ordinal(down) { return ({1:'1st',2:'2nd',3:'3rd',4:'4th'})[Number(down)] || '?'; }
function situationHtml(s) {
  if (!s) return '<span class="pill">Waiting for game state…</span>';
  const dist = Number(s.distance) === 0 ? 'Goal' : esc(s.distance ?? '?');
  const yd = Number.isFinite(Number(s.yardLine)) ? 'Yard ' + esc(s.yardLine) : 'Yard ?';
  return '<span class="pill">Q' + esc(s.quarter ?? '?') + ' ' + clock(s.gameClockSeconds) + '</span>' +
         '<span class="pill">' + ordinal(s.down) + ' & ' + dist + '</span>' +
         '<span class="pill">' + yd + '</span>';
}
function detail(label, value) {
  if (!value || (Array.isArray(value) && !value.length)) return '';
  const body = Array.isArray(value)
    ? value.map(v => '<div class="runStep">' + esc(v) + '</div>').join('')
    : esc(value);
  return '<span class="smallLabel">' + esc(label) + '</span>' + body;
}
function routePath(kind) {
  const p = {
    crossLeftToRight: 'M55 145 C105 120 165 100 255 92',
    crossRightToLeft: 'M285 145 C235 122 175 105 85 95',
    flatRight: 'M205 142 C245 140 275 132 310 118',
    flatLeft: 'M135 142 C95 140 65 132 30 118',
    deepOutRight: 'M245 148 L245 82 Q248 55 310 48',
    midOutRight: 'M205 148 L205 105 Q215 88 300 86',
    seamLeft: 'M135 148 L135 35',
    goRight: 'M260 148 L260 30',
    slantLeft: 'M65 148 L155 80',
    slantRight: 'M275 148 L185 80',
    cornerRight: 'M205 148 L205 95 Q215 68 300 42',
    stickRight: 'M210 148 L210 103 L235 90',
    hitchLeft: 'M75 148 L75 95 Q75 84 58 90',
    screenRight: 'M285 148 C260 142 238 128 220 112 C245 112 278 105 310 92',
    deepInRight: 'M270 148 L270 62 Q255 54 170 68',
    shallowInLeft: 'M65 148 C110 130 145 120 195 120',
    postRight: 'M275 148 L275 74 L185 34',
    curlRight: 'M275 148 L275 78 Q275 65 258 78',
    curlLeft: 'M65 148 L65 78 Q65 65 82 78',
    shortOutLeft: 'M135 148 L135 112 Q120 100 55 102',
    runInside: 'M170 160 L170 70'
  };
  return p[kind] || p.deepInRight;
}
function baseOffense() {
  return '<line class="fieldLine" x1="10" y1="170" x2="330" y2="170" />' +
    '<circle class="skill" cx="55" cy="150" r="7"/><circle class="skill" cx="285" cy="150" r="7"/>' +
    '<circle class="skill" cx="115" cy="150" r="7"/><circle class="skill" cx="225" cy="150" r="7"/>' +
    '<circle class="oline" cx="135" cy="165" r="6"/><circle class="oline" cx="153" cy="165" r="6"/><circle class="oline" cx="170" cy="165" r="6"/><circle class="oline" cx="187" cy="165" r="6"/><circle class="oline" cx="205" cy="165" r="6"/>' +
    '<circle class="qb" cx="170" cy="190" r="8"/>';
}
function numberBubble(x, y, number) {
  return '<circle class="routeNum" cx="'+x+'" cy="'+y+'" r="11"/><text class="routeNumText" x="'+x+'" y="'+y+'">'+esc(number)+'</text>';
}
function receiverPoint(receiver) {
  const x = Number(receiver?.x);
  const y = Number(receiver?.y);
  const sx = Number.isFinite(x) ? Math.max(28, Math.min(312, 170 + x * 6.4)) : 170;
  const sy = Number.isFinite(y) ? Math.max(70, Math.min(198, 164 + (-y) * 4.0)) : 150;
  return [sx, sy];
}
function exactAssignmentRoute(receiver) {
  const points = receiver?.assignmentGeometry?.points || [];
  if (points.length < 2) return null;
  const [sx, sy] = receiverPoint(receiver);
  const scale = 4;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  return points.map((point, index) => {
    const rx = Number(point.relativeX ?? point.x ?? 0);
    const ry = Number(point.relativeY ?? point.y ?? 0);
    const x = clamp(sx + (Number.isFinite(rx) ? rx : 0) * scale, 16, 324);
    const y = clamp(sy - (Number.isFinite(ry) ? ry : 0) * scale, 20, 198);
    return (index === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
  }).join(' ');
}
function assignmentRoute(receiver) {
  const exact = exactAssignmentRoute(receiver);
  if (exact) return exact;
  const [sx, sy] = receiverPoint(receiver);
  const inward = sx < 170 ? 1 : -1;
  switch (receiver?.routeFamily) {
    case 'slant': return 'M'+sx+' '+sy+' L'+(sx + inward*70)+' '+(sy-62);
    case 'vertical': return 'M'+sx+' '+sy+' L'+sx+' '+Math.max(28, sy-105);
    case 'cross': return 'M'+sx+' '+sy+' C'+(sx+inward*45)+' '+(sy-16)+' '+(170+inward*35)+' '+(sy-25)+' '+(170+inward*115)+' '+(sy-28);
    case 'screen': return 'M'+sx+' '+sy+' C'+(sx-inward*12)+' '+(sy-5)+' '+(sx-inward*38)+' '+(sy-12)+' '+(sx-inward*58)+' '+(sy-22);
    case 'post': return 'M'+sx+' '+sy+' L'+sx+' '+(sy-38)+' L'+(sx+inward*62)+' '+Math.max(30,sy-92);
    default: return null;
  }
}
function receiverButton(receiver) {
  const [x,y] = receiverPoint(receiver);
  const label = esc(receiver.readMarker || receiver.button || '?');
  return '<circle class="targetButton" cx="'+x+'" cy="'+y+'" r="12"/><text class="targetButtonText" x="'+x+'" y="'+y+'">'+label+'</text>';
}
function partialAssignmentDiagram(guide) {
  const receivers = guide?.receivers || [];
  let svg = '<svg viewBox="0 0 340 215" role="img" aria-label="Partial assignment view with receiver buttons"><defs><marker id="arrowPartial" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#79e29d"/></marker></defs>' +
    '<line class="fieldLine" x1="10" y1="170" x2="330" y2="170"/>' +
    '<circle class="oline" cx="135" cy="165" r="6"/><circle class="oline" cx="153" cy="165" r="6"/><circle class="oline" cx="170" cy="165" r="6"/><circle class="oline" cx="187" cy="165" r="6"/><circle class="oline" cx="205" cy="165" r="6"/><circle class="qb" cx="170" cy="190" r="8"/>';
  for (const receiver of receivers) {
    const route = assignmentRoute(receiver);
    if (route) svg += '<path class="route" d="'+route+'" marker-end="url(#arrowPartial)"/>';
  }
  for (const receiver of receivers) svg += receiverButton(receiver);
  svg += '</svg>';
  return svg;
}
function passDiagram(guide) {
  if (guide?.diagramMode === 'assignment_partial' || guide?.diagramMode === 'assignment_geometry') return partialAssignmentDiagram(guide);
  const paths = guide?.paths || [];
  const ends = [[268,54],[212,92],[298,120]];
  const estimated = guide?.diagramMode !== 'verified';
  let svg = '<svg viewBox="0 0 340 215" role="img" aria-label="'+(estimated?'Estimated concept sketch':'Verified play view')+'"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#79e29d"/></marker></defs>' + baseOffense();
  paths.slice(0,3).forEach((kind, i) => {
    const baseCls = i === 0 ? 'route' : (i === 1 ? 'route secondary' : 'route tertiary');
    const cls = baseCls + (estimated ? ' estimated' : '');
    svg += '<path class="'+cls+'" d="'+routePath(kind)+'" marker-end="url(#arrow)"/>';
    if (!estimated) {
      const e = ends[i] || [170,55];
      const read = guide?.reads?.[i];
      svg += numberBubble(e[0], e[1], String(read?.button || read?.number || i+1));
    }
  });
  svg += '</svg>';
  return svg;
}
function runDiagram(guide) {
  const lane = guide?.lane || 'inside';
  let laneShape = '<path class="runLane" d="M145 172 L195 172 L190 58 L150 58 Z"/>';
  let arrow = 'M170 188 C170 150 170 108 170 62';
  if (lane === 'outside' || lane === 'edge') {
    laneShape = '<path class="runLane" d="M205 172 L330 172 L330 72 L270 72 Z"/>';
    arrow = 'M170 188 C210 165 245 140 300 82';
  } else if (lane === 'offGuard') {
    laneShape = '<path class="runLane" d="M180 172 L248 172 L240 70 L195 70 Z"/>';
    arrow = 'M170 188 C195 158 210 120 220 76';
  } else if (lane === 'option') {
    laneShape = '<path class="runLane" d="M145 172 L205 172 L195 72 L150 72 Z"/><path class="runLane" d="M205 172 L325 172 L325 92 L270 92 Z"/>';
    arrow = 'M170 188 C186 150 190 110 188 80 M170 188 C220 165 255 138 300 102';
  }
  return '<svg viewBox="0 0 340 215" role="img" aria-label="Simplified coach view of intended run area"><defs><marker id="runArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#79e29d"/></marker></defs>' +
    '<line class="fieldLine" x1="10" y1="170" x2="330" y2="170"/>' + laneShape + baseOffense() +
    '<path class="route" d="'+arrow+'" marker-end="url(#runArrow)"/><text x="170" y="28" fill="#79e29d" font-size="13" font-weight="900" text-anchor="middle">LOOK FOR SPACE HERE</text></svg>';
}
function renderGuide(guide) {
  if (!guide) return detail('READ', 'No specific adjustment.');
  if (guide.mode === 'run') {
    const steps = (guide.steps || []).map(x => '<div class="runStep">'+esc(x)+'</div>').join('');
    const note = guide.coverageNote ? '<div class="plainCallout">'+esc(guide.coverageNote)+'</div>' : '';
    return '<div class="coachGrid"><div class="diagramCard"><div class="diagramTitle">WHERE TO RUN</div><div class="diagramWrap">'+runDiagram(guide)+'</div></div>' +
      '<div class="guideCard"><div class="guideTitle">WHAT TO DO</div><div class="runHeadline">'+esc(guide.headline || '')+'</div><div class="watchBox"><b>WATCH:</b> '+esc(guide.watch || '')+'</div>'+steps+note+'</div></div>';
  }

  const verified = guide.progressionStatus === 'verified' && (guide.reads || []).length;
  const derived = guide.progressionStatus === 'derived' && (guide.reads || []).length;
  const targets = guide.targets || [];
  const receivers = guide.receivers || [];
  let body = '';
  let title = verified ? 'READ IN THIS ORDER' : (derived ? 'DERIVED READ ORDER' : 'WHAT WE KNOW');

  if (verified || derived) {
    body = (guide.reads || []).map(r => '<div class="guideRow"><div class="guideNum">'+esc(r.button || r.number)+'</div><div><div class="guideLabel">'+esc(r.label)+'</div><div class="guideText">'+esc(r.detail)+'</div></div></div>').join('');
  } else if (targets.length) {
    title = 'ROUTES WE CAN IDENTIFY';
    body = targets.map(r => '<div class="guideRow"><div class="guideNum">'+esc(r.button || '?')+'</div><div><div class="guideLabel">'+esc(r.label)+'</div><div class="guideText">'+esc(r.detail || '')+'</div></div></div>').join('');
  } else if (receivers.length) {
    title = 'RECEIVER BUTTONS';
    const order = {X:1,Y:2,A:3,B:4,RB:5};
    body = [...receivers].sort((a,b)=>(order[a.button]||9)-(order[b.button]||9)).map(r => '<div class="guideRow"><div class="guideNum">'+esc(r.button || '?')+'</div><div><div class="guideLabel">Target identified by alignment</div><div class="guideText">Exact route and designed read order are not verified yet.</div></div></div>').join('');
  } else {
    body = '<div class="runHeadline">Exact routes are not verified yet.</div><div class="guideText">Use the in-game play art for this call. The coordinator will not invent a read order.</div>';
  }

  const warning = !verified && guide.warning ? '<div class="knowledgeWarn">'+esc(guide.warning)+'</div>' : '';
  const note = guide.coverageNote ? '<div class="plainCallout"><b>DEFENSE:</b> '+esc(guide.coverageNote)+'</div>' : '';
  return '<div class="coachGrid"><div class="diagramCard"><div class="diagramTitle">'+esc(guide.diagramLabel || 'CONCEPT VIEW')+'</div><div class="diagramWrap">'+passDiagram(guide)+'</div></div>' +
    '<div class="guideCard"><div class="guideTitle">'+esc(title)+'</div>'+body+warning+note+'</div></div>';
}
function render(s) {
  lastUpdated = s.updatedAt || null;
  els.dot.classList.toggle('on', Boolean(s.connected));
  els.liveText.textContent = s.connected ? 'LIVE' : 'CONNECTING';
  els.situation.innerHTML = situationHtml(s.situation);
  els.book.textContent = s.playbook ? s.playbook : '';
  els.game.textContent = s.gameId ? 'Game ' + s.gameId : '';
  els.defense.hidden = true;
  els.defense.innerHTML = '';
  els.detail.className = 'why';
  const title = titleForPhase(s.phase);
  els.pageTitle.textContent = title;
  document.title = title;

  if (s.phase === 'huddle') {
    els.eyebrow.textContent = 'CALL';
    els.play.textContent = s.call || 'NO CALL AVAILABLE';
    setFormation(s.formation);
    els.detail.innerHTML = detail('WHY', s.why);
  } else if (s.phase === 'selected' || s.phase === 'audible') {
    els.eyebrow.textContent = s.phase === 'audible' ? 'AUDIBLE' : 'YOUR CALL';
    els.play.textContent = s.call || 'PLAY SELECTED';
    setFormation(s.formation);
    if (s.defense) {
      els.defense.hidden = false;
      els.defense.innerHTML = detail('DEFENSE', s.defense + (s.defenseFormation ? ' — ' + s.defenseFormation : ''));
    }
    els.detail.className = 'read';
    els.detail.innerHTML = renderGuide(s.guide) ||
      detail('READ', Array.isArray(s.read) && s.read.length ? s.read : (s.read || 'No specific adjustment.'));
  } else if (s.phase === 'defensive_huddle') {
    els.eyebrow.textContent = 'DEFENSIVE CALL';
    els.play.textContent = s.call || 'NO CALL AVAILABLE';
    setFormation(s.formation);
    if (s.cpuPlay) {
      els.defense.hidden = false;
      els.defense.innerHTML = detail('OFFENSE', s.cpuPlay + (s.cpuFormation ? ' — ' + s.cpuFormation : ''));
    }
    els.detail.innerHTML = detail('WHY', s.why);
  } else if (s.phase === 'defensive_unavailable') {
    els.eyebrow.textContent = 'NO CALL';
    els.play.textContent = 'Defensive recommendation unavailable';
    setFormation(null);
    if (s.cpuPlay) {
      els.defense.hidden = false;
      els.defense.innerHTML = detail('OFFENSE', s.cpuPlay + (s.cpuFormation ? ' — ' + s.cpuFormation : ''));
    }
    els.detail.className = 'why warn';
    els.detail.innerHTML = detail('WHY', s.why || 'Waiting for a valid defensive read.');
  } else if (s.phase === 'result') {
    els.eyebrow.textContent = 'RESULT';
    els.play.textContent = s.result || 'Play complete';
    setFormation(s.call);
    els.detail.innerHTML = s.why ? detail('RECORDED', s.why) : '';
  } else if (s.phase === 'unavailable') {
    els.eyebrow.textContent = 'NO CALL';
    els.play.textContent = 'Recommendation unavailable';
    setFormation(null);
    els.detail.className = 'why warn';
    els.detail.innerHTML = detail('WHY', s.why || 'Waiting for a valid huddle state.');
  } else if (s.phase === 'error') {
    els.eyebrow.textContent = 'CONNECTION';
    els.play.textContent = 'Coordinator waiting';
    setFormation(null);
    els.detail.className = 'why danger';
    els.detail.innerHTML = detail('STATUS', s.error || 'Telemetry unavailable.');
  } else {
    els.eyebrow.textContent = 'READY';
    els.play.textContent = s.message || 'Waiting for huddle…';
    setFormation(null);
    els.detail.innerHTML = '';
  }
}
async function poll() {
  try {
    const r = await fetch('/api/state?t=' + Date.now(), { cache: 'no-store' });
    if (r.ok) render(await r.json());
  } catch (_) {}
}
poll();
setInterval(poll, 250);

const settingsEls = {
  offenseSelect: document.getElementById('offenseSelect'),
  defenseSelect: document.getElementById('defenseSelect'),
  offenseStatus: document.getElementById('offenseStatus'),
  defenseStatus: document.getElementById('defenseStatus'),
  saveButton: document.getElementById('savePlaybooks'),
  message: document.getElementById('settingsMessage')
};
let playbookLists = { offense: [], defense: [] };

function describeBook(book) {
  if (!book) return '';
  if (book.membershipVerified) return book.playCount + ' verified paths';
  return book.playCount + ' catalog plays / unverified membership';
}
function populateSelect(select, books, selectedId, placeholder) {
  const options = ['<option value="">' + esc(placeholder) + '</option>'];
  for (const book of books) {
    const sel = String(book.id) === String(selectedId) ? ' selected' : '';
    options.push('<option value="' + esc(book.id) + '"' + sel + '>' + esc(book.name) + '</option>');
  }
  select.innerHTML = options.join('');
}
function updateStatus(el, books, selectedId, emptyText) {
  if (selectedId == null || selectedId === '') { el.textContent = emptyText; return; }
  const book = books.find(b => String(b.id) === String(selectedId));
  el.textContent = book ? describeBook(book) : 'selected playbook not found in current list';
}
async function loadSettingsPanel() {
  try {
    const [playbooksRes, configRes] = await Promise.all([
      fetch('/api/playbooks', { cache: 'no-store' }),
      fetch('/api/config', { cache: 'no-store' })
    ]);
    playbookLists = playbooksRes.ok ? await playbooksRes.json() : { offense: [], defense: [] };
    const config = configRes.ok ? await configRes.json() : {};
    populateSelect(settingsEls.offenseSelect, playbookLists.offense || [], config.offensePlaybookId, 'Select offensive playbook');
    populateSelect(settingsEls.defenseSelect, playbookLists.defense || [], config.defensePlaybookId, 'Select defensive playbook');
    updateStatus(settingsEls.offenseStatus, playbookLists.offense || [], config.offensePlaybookId, 'none selected');
    updateStatus(settingsEls.defenseStatus, playbookLists.defense || [], config.defensePlaybookId, 'none selected');
  } catch (_) {
    settingsEls.message.textContent = 'Could not load playbook list.';
  }
}
settingsEls.offenseSelect.addEventListener('change', () => {
  updateStatus(settingsEls.offenseStatus, playbookLists.offense || [], settingsEls.offenseSelect.value, 'none selected');
});
settingsEls.defenseSelect.addEventListener('change', () => {
  updateStatus(settingsEls.defenseStatus, playbookLists.defense || [], settingsEls.defenseSelect.value, 'none selected');
});
settingsEls.saveButton.addEventListener('click', async () => {
  settingsEls.message.textContent = 'Saving…';
  const requests = [];
  if (settingsEls.offenseSelect.value) requests.push(['offense', settingsEls.offenseSelect.value]);
  if (settingsEls.defenseSelect.value) requests.push(['defense', settingsEls.defenseSelect.value]);
  if (!requests.length) { settingsEls.message.textContent = 'Choose a playbook first.'; return; }
  try {
    const results = [];
    for (const [side, playbookId] of requests) {
      const r = await fetch('/api/config/playbooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ side, playbookId })
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || ('Failed to save ' + side + ' playbook'));
      results.push(body);
    }
    const applied = results.some(r => r.appliedImmediately);
    settingsEls.message.textContent = 'Saved' + (applied ? ' — recommendation updated' : ' — applies to next recommendation');
    await loadSettingsPanel();
  } catch (error) {
    settingsEls.message.textContent = String(error?.message || error);
  }
});
loadSettingsPanel();
</script>
</body>
</html>`;
}

function readJsonBody(req, maxLength = 10_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxLength) req.destroy();
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

class CoordinatorWindow {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = Number(options.port || 0);
    this.autoOpen = options.autoOpen !== false;
    this.title = options.title || 'CFB 27 Offensive Coordinator';
    // Optional: { listPlaybooks(), getConfig(), setPlaybookSelection({side, playbookId}) }.
    // Kept generic/injected so this class stays a pure UI/state renderer and
    // never becomes database-aware itself.
    this.playbookService = options.playbookService || null;
    this.server = null;
    this.url = null;
    this.launch = null;
    this.state = {
      version: 1,
      phase: 'waiting',
      connected: false,
      message: 'Waiting for CFB 27…',
      playbook: null,
      gameId: null,
      membershipVerified: false,
      situation: null,
      call: null,
      formation: null,
      why: null,
      defense: null,
      defenseFormation: null,
      cpuPlay: null,
      cpuFormation: null,
      read: null,
      guide: null,
      result: null,
      error: null,
      updatedAt: new Date().toISOString()
    };
  }

  _set(patch) {
    this.state = {
      ...this.state,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    return this.state;
  }

  setGameInfo({ playbook, gameId, membershipVerified } = {}) {
    return this._set({
      playbook: playbook || this.state.playbook,
      gameId: gameId ?? this.state.gameId,
      membershipVerified: Boolean(membershipVerified)
    });
  }

  updateSituation(state) {
    if (!state) return this.state;
    return this._set({
      connected: true,
      error: null,
      ...(this.state.phase === 'error' ? { phase: 'waiting', message: 'Waiting for huddle…' } : {}),
      situation: {
        quarter: state.quarter ?? null,
        gameClockSeconds: state.gameClockSeconds ?? null,
        down: state.down ?? null,
        distance: state.distance ?? null,
        yardLine: state.yardLine ?? null
      }
    });
  }

  showRecommendation(action, state) {
    this.updateSituation(state);
    if (!action?.available) {
      return this._set({
        phase: 'unavailable',
        call: null,
        formation: null,
        why: action?.reason || 'No legal recommendation is available.',
        defense: null,
        defenseFormation: null,
        cpuPlay: null,
        cpuFormation: null,
        read: null,
        guide: null,
        result: null
      });
    }
    return this._set({
      phase: 'huddle',
      call: action.play?.name || null,
      formation: action.locator?.formation || action.play?.formation || null,
      why: action.reasons && action.reasons.length ? action.reasons : (action.reason || null),
      defense: null,
      defenseFormation: null,
      cpuPlay: null,
      cpuFormation: null,
      read: null,
      guide: null,
      result: null
    });
  }

  showDefensiveRecommendation(action, state) {
    this.updateSituation(state);
    if (!action?.available) {
      return this._set({
        phase: 'defensive_unavailable',
        cpuPlay: action?.cpuPlay?.name || null,
        cpuFormation: action?.cpuPlay?.formation || null,
        call: null,
        formation: null,
        why: action?.reason || 'No legal defensive recommendation is available.',
        defense: null,
        defenseFormation: null,
        read: null,
        guide: null,
        result: null
      });
    }
    return this._set({
      phase: 'defensive_huddle',
      cpuPlay: action.cpuPlay?.name || null,
      cpuFormation: action.cpuPlay?.formation || null,
      call: action.play?.name || null,
      formation: action.locator?.formation || action.play?.formation || null,
      why: action.reasons && action.reasons.length ? action.reasons : (action.reason || null),
      defense: null,
      defenseFormation: null,
      read: null,
      guide: null,
      result: null
    });
  }

  showSelection(action, advice, state) {
    this.updateSituation(state);
    const known = advice?.available && advice?.advice?.known;
    const a = known ? advice.advice : null;
    const notes = known ? [
      a.headline || null,
      ...(a.reasons || []),
      ...(a.coaching?.preSnap || []).slice(0, 2)
    ].filter(Boolean) : [];
    return this._set({
      phase: action?.type === 'audible' ? 'audible' : 'selected',
      call: action?.play?.name || null,
      formation: action?.play?.formation || null,
      why: null,
      defense: action?.opponentPlay?.name || null,
      defenseFormation: action?.opponentPlay?.formation || null,
      cpuPlay: null,
      cpuFormation: null,
      read: notes,
      guide: advice?.guide || null,
      result: null
    });
  }

  showResult(action, state) {
    this.updateSituation(state);
    const event = action?.event || {};
    const r = event.result || {};
    const yards = r.yards == null ? 'Yards unknown' : `${r.yards >= 0 ? '+' : ''}${r.yards} yards`;
    const flags = [];
    if (r.touchdown) flags.push('TOUCHDOWN');
    else if (r.firstDown) flags.push('FIRST DOWN');
    if (r.turnover) flags.push('CHANGE OF POSSESSION');
    if (typeof r.yards === 'number' && Math.abs(r.yards) >= 20) flags.push('BIG PLAY');
    return this._set({
      phase: 'result',
      call: event.play?.name || null,
      formation: event.play?.formation || null,
      why: null,
      defense: null,
      defenseFormation: null,
      cpuPlay: null,
      cpuFormation: null,
      read: null,
      guide: null,
      result: [yards, ...flags].join(' • ')
    });
  }

  showError(error, state = null) {
    if (state) this.updateSituation(state);
    return this._set({
      phase: 'error',
      connected: Boolean(state),
      error: String(error?.message || error || 'Telemetry unavailable.')
    });
  }

  async start() {
    if (this.server) return { url: this.url, launch: this.launch };
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/api/state')) {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store, max-age=0'
        });
        res.end(JSON.stringify(this.state));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/playbooks') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, max-age=0' });
        res.end(JSON.stringify(this.playbookService ? this.playbookService.listPlaybooks() : { offense: [], defense: [] }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/config') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, max-age=0' });
        res.end(JSON.stringify(this.playbookService ? this.playbookService.getConfig() : {}));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/config/playbooks') {
        if (!this.playbookService) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Playbook selection is not available in this session.' }));
          return;
        }
        readJsonBody(req).then(body => {
          const result = this.playbookService.setPlaybookSelection({ side: body.side, playbookId: body.playbookId });
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        }).catch(error => {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: String(error?.message || error) }));
        });
        return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('ok');
        return;
      }
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store, max-age=0'
        });
        res.end(renderPage(this.title));
        return;
      }
      if (req.url === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });

    const address = this.server.address();
    this.url = `http://${this.host}:${address.port}/`;
    this.launch = this.autoOpen ? openAppWindow(this.url) : { opened: false, mode: 'manual' };
    return { url: this.url, launch: this.launch };
  }

  close() {
    if (!this.server) return Promise.resolve();
    const server = this.server;
    this.server = null;
    return new Promise(resolve => server.close(() => resolve()));
  }
}

module.exports = { CoordinatorWindow, openAppWindow, renderPage };



