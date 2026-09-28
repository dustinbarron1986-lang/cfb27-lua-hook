'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const dbPath = path.join(root, 'data', 'coordinator.db');

const { renderPage, CoordinatorWindow } = require('../src/football/ui/coordinator-window.js');
const { CoordinatorDatabase } = require('../src/football/db/coordinator-database');
const { DatabasePlaybookRepository } = require('../src/football/playbooks/database-playbook-repository');
const { PlayLocationIndex } = require('../src/football/playbooks/play-location-index');
const { findPlay } = require('../src/coordinator/playbook-loader.cjs');
const { printDefensiveRecommendation } = require('../src/coordinator/live-coordinator.cjs');
const { FootballEngine } = require('../src/football/engine');

// ---- Layout ----

test('main grid has five explicit row sizes (one per grid child, including the settings panel)', () => {
  const html = renderPage('test');
  const match = html.match(/grid-template-rows:\s*([^;]+);/);
  assert.ok(match, 'grid-template-rows rule not found');
  const rows = match[1].trim().split(/\s+/);
  assert.equal(rows.length, 5, `expected 5 row sizes, got: ${match[1]}`);
  assert.equal(rows[3], '1fr', 'the stage/coaching card row must remain the flexible 1fr row');
});

// ---- Client-script helpers (titleForPhase / setFormation), executed for real ----

function makeElement() {
  return {
    hidden: false,
    textContent: '',
    innerHTML: '',
    className: '',
    value: '',
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
  };
}

function loadClientScript() {
  const html = renderPage('test');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('client script block not found');

  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    title: '',
  };
  const context = {
    document,
    fetch: () => Promise.reject(new Error('no network in test sandbox')),
    setInterval: () => 0,
    Date,
    console,
  };
  vm.createContext(context);
  vm.runInContext(match[1], context);
  return { context, elements };
}

test('titleForPhase maps offense/defense/neutral phases correctly', () => {
  const { context } = loadClientScript();
  assert.equal(context.titleForPhase('huddle'), 'CFB 27 OFFENSIVE COORDINATOR');
  assert.equal(context.titleForPhase('selected'), 'CFB 27 OFFENSIVE COORDINATOR');
  assert.equal(context.titleForPhase('audible'), 'CFB 27 OFFENSIVE COORDINATOR');
  assert.equal(context.titleForPhase('unavailable'), 'CFB 27 OFFENSIVE COORDINATOR');
  assert.equal(context.titleForPhase('defensive_huddle'), 'CFB 27 DEFENSIVE COORDINATOR');
  assert.equal(context.titleForPhase('defensive_unavailable'), 'CFB 27 DEFENSIVE COORDINATOR');
  // No reliable side semantics -- must not guess.
  assert.equal(context.titleForPhase('result'), 'CFB 27 COORDINATOR');
  assert.equal(context.titleForPhase('waiting'), 'CFB 27 COORDINATOR');
  assert.equal(context.titleForPhase('error'), 'CFB 27 COORDINATOR');
  assert.equal(context.titleForPhase(undefined), 'CFB 27 COORDINATOR');
});

test('render() sets the in-page heading and document.title from the phase, not stale prior state', () => {
  const { context, elements } = loadClientScript();
  context.render({ phase: 'huddle', call: 'PA JET SWEEP' });
  assert.equal(elements.get('pageTitle').textContent, 'CFB 27 OFFENSIVE COORDINATOR');
  assert.equal(context.document.title, 'CFB 27 OFFENSIVE COORDINATOR');

  context.render({ phase: 'defensive_huddle', call: '1 Edge Pinch' });
  assert.equal(elements.get('pageTitle').textContent, 'CFB 27 DEFENSIVE COORDINATOR');
  assert.equal(context.document.title, 'CFB 27 DEFENSIVE COORDINATOR');

  // A neutral 'result' phase right after a defensive huddle must not inherit
  // the previous phase's side -- it has to go neutral, not stay DEFENSIVE.
  context.render({ phase: 'result', result: '+4 yards' });
  assert.equal(elements.get('pageTitle').textContent, 'CFB 27 COORDINATOR');
});

test('setFormation hides the formation element rather than showing a placeholder when there is no formation', () => {
  const { context, elements } = loadClientScript();
  const formationEl = elements.get('formation');

  context.setFormation('Singleback Ace');
  assert.equal(formationEl.hidden, false);
  assert.equal(formationEl.textContent, 'Singleback Ace');

  context.setFormation(null);
  assert.equal(formationEl.hidden, true);
  assert.equal(formationEl.textContent, '');
});

test('render() omits the formation line (hidden) for a defensive huddle with no known formation', () => {
  const { context, elements } = loadClientScript();
  context.render({ phase: 'defensive_huddle', call: '1 Edge Pinch', formation: null });
  const formationEl = elements.get('formation');
  assert.equal(formationEl.hidden, true);
  assert.equal(formationEl.textContent, '');
  assert.ok(!/set:\d/.test(formationEl.textContent));
});

// ---- Data layer: no more fabricated "set:<id>" formation ----

test('_normalizePlay (via an unverified defense playbook) never fabricates a "set:<id>" formation', () => {
  const database = new CoordinatorDatabase({ dbPath, readOnly: true });
  try {
    const repo = new DatabasePlaybookRepository(database);
    const book = repo.get(503, { side: 'defense' }); // "3-4", no verified overlay
    assert.equal(book.membershipVerified, false);
    assert.ok(book.plays.length > 0);
    for (const play of book.plays.slice(0, 50)) {
      // A raw-Frosty-XML-derived location index now legitimately enriches
      // many of these (e.g. "1 Edge Pinch" -> "3-4 Grizzly"); the invariant
      // this guards is "never the raw set:<id> fallback", not "always null".
      assert.ok(!/^set:\d/.test(String(play.formation)));
    }
  } finally {
    database.close();
  }
});

test('a play with no location-index entry keeps formation null; formationId/setId remain populated regardless', () => {
  const database = new CoordinatorDatabase({ dbPath, readOnly: true });
  try {
    // Inject a deliberately empty location index so this test doesn't depend
    // on which specific raw XML files happen to be missing/present.
    const repo = new DatabasePlaybookRepository(database, {
      playLocationIndex: new PlayLocationIndex({ data: { playbooks: {} } }),
    });
    const book = repo.get(503, { side: 'defense' });
    const play = book.plays.find(p => p.setId === 3159739393);
    assert.ok(play, 'expected the known catalog play with setId 3159739393 to be present');
    assert.equal(play.formation, null);
    assert.equal(play.formationName, null);
    assert.equal(play.setName, null);
    assert.equal(play.setId, 3159739393);
    assert.equal(play.formationId, 16);
  } finally {
    database.close();
  }
});

test('when real location data IS available (1 Edge Pinch), it is used instead of null', () => {
  const database = new CoordinatorDatabase({ dbPath, readOnly: true });
  try {
    const repo = new DatabasePlaybookRepository(database);
    const book = repo.get(503, { side: 'defense' });
    const play = book.plays.find(p => p.setId === 3159739393);
    assert.equal(play.formationName, '3-4');
    assert.equal(play.setName, 'Grizzly');
    assert.equal(play.formation, '3-4 Grizzly');
  } finally {
    database.close();
  }
});

test('findPlay() still resolves a defense play by name alone when formation is null', () => {
  const database = new CoordinatorDatabase({ dbPath, readOnly: true });
  try {
    const repo = new DatabasePlaybookRepository(database);
    const book = repo.get(503, { side: 'defense' });
    const found = findPlay(book, { name: 'Cover 2 Invert', set: 'Nickel 2-4 Dbl Mug' });
    assert.ok(found, 'expected name-only fallback match to still find the play');
    assert.equal(found.name, 'Cover 2 Invert');
  } finally {
    database.close();
  }
});

test('a live defensive recommendation for an unverified book never surfaces a raw set: string', () => {
  const database = new CoordinatorDatabase({ dbPath, readOnly: true });
  try {
    const repo = new DatabasePlaybookRepository(database);
    const defensePlaybook = repo.get(503, { side: 'defense' });
    const engine = new FootballEngine();
    const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
    const io = { log: () => {} };

    const state = {
      possession: 1, quarter: 1, down: 2, distance: 7, yardLine: 40, fieldX: 40, gameClockSeconds: 400,
      offensiveCallAvailable: true, offensiveSet: 'Gun Trio Y-Flex', offensivePlay: 'Shock H Option', offensivePlayId: 55,
    };
    printDefensiveRecommendation(engine, { defense: defensePlaybook }, state, null, { offense: true }, io, coordinatorWindow);

    assert.equal(coordinatorWindow.state.phase, 'defensive_huddle');
    assert.ok(coordinatorWindow.state.call, 'expected a real recommended play');
    // The recommended play may now legitimately have a real enriched
    // formation (e.g. "3-4 Grizzly") -- the invariant is "never a raw
    // set:<id> string", not "always null".
    assert.ok(!/^set:\d/.test(String(coordinatorWindow.state.formation)));
  } finally {
    database.close();
  }
});

test('authoritative assignment diagram uses derived readMarker without inventing a controller button', () => {
  const { context } = loadClientScript();
  const receiver = { button: null, readMarker: '2', x: 10, y: 0,
    assignmentGeometry: { points: [{ x: 0, y: 0 }, { x: 0, y: 8 }, { x: -8, y: 8 }] } };
  const svg = context.partialAssignmentDiagram({ receivers: [receiver] });
  assert.match(svg, />2<\/text>/);
  assert.doesNotMatch(svg, />\?<\/text>/);
  assert.equal(receiver.button, null);
});


test('showSelection preserves the guide contract while exposing pre-snap audible advice', () => {
  const coordinatorWindow = new CoordinatorWindow({ autoOpen: false });
  const guide = { mode: 'pass', reads: [{ number: 1, label: 'X', detail: 'read leverage' }] };
  const audible = {
    decision: 'RUN', actionable: true,
    box: { classification: 'LIGHT', confidence: 'MEDIUM', provenance: 'HEURISTIC' },
    offense: { family: 'PASS', confidence: 'HIGH', provenance: 'EA_AUTHORED' },
    reason: 'Light box against a pass-family call creates a conservative run-check opportunity.',
  };
  coordinatorWindow.showSelection(
    { type: 'selected', play: { name: 'Four Verticals', formation: 'Gun Spread' }, opponentPlay: { name: 'Cover 4 Drop', formation: 'Dime 3-2' } },
    { available: true, advice: { known: false }, guide, audible },
    { quarter: 1, gameClockSeconds: 700, down: 1, distance: 10, yardLine: 25 }
  );
  assert.equal(coordinatorWindow.state.phase, 'selected');
  assert.deepEqual(coordinatorWindow.state.guide, guide);
  assert.deepEqual(coordinatorWindow.state.audibleRecommendation, audible);
});

test('render() shows audible advice alongside the existing read/guide surface', () => {
  const { context, elements } = loadClientScript();
  context.render({
    phase: 'selected',
    call: 'Four Verticals',
    formation: 'Gun Spread',
    defense: 'Cover 4 Drop',
    defenseFormation: 'Dime 3-2',
    read: 'Read leverage',
    guide: null,
    audibleRecommendation: {
      decision: 'RUN',
      box: { classification: 'LIGHT', confidence: 'MEDIUM' },
      reason: 'Light box against a pass-family call creates a conservative run-check opportunity.',
    },
  });
  const html = elements.get('detail').innerHTML;
  assert.match(html, /AUDIBLE: RUN/);
  assert.match(html, /LIGHT box \/ MEDIUM confidence/);
  assert.match(html, /Read leverage/);
});
