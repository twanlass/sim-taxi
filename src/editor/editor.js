import * as THREE from 'three';
import { GRID } from '../city/grid.js';
import {
  editorStateToLevel, levelToEditorState, serialize, validate,
  encodeUrl, segmentBetween, SESSION_KEY,
} from '../city/level.js';
import { createEditorOverlay } from './overlay.js';

// Editor mode. A DOM toolbar plus a picker that raycasts against the overlay's invisible pick
// planes, mutating a small state object and re-syncing the visible feedback layer.
//
// Play does the round-trip via reload: we serialise the current state, stash it in
// sessionStorage under ?level=session, and let the ordinary boot path pick it up. That way the
// city, sim, and taxi are all constructed the normal way from a level rather than needing bespoke
// in-place rebuild code — the cost is one page reload and a fresh run.

const TOOLS = [
  { id: 'built',    label: 'Buildings', desc: 'Paint block as built. Click a road to close it (paint over it).' },
  { id: 'park',     label: 'Park',      desc: 'Paint block as park. Two adjacent parks pair into a district. Click a road to close it.' },
  { id: 'plaza',    label: 'Plaza',     desc: 'Paint block as an empty plaza. Click a road to close it.' },
  { id: 'road',     label: 'Road',      desc: 'Eraser for road closures — click a closed segment to reopen it.' },
  { id: 'arterial', label: 'Arterial',  desc: 'Click a road to make it a main street. Click again to flip its coordinated direction, once more to remove.' },
  { id: 'taxi',     label: 'Taxi start', desc: 'Click an intersection to spawn the taxi there. Each click rotates through the four headings.' },
];

const PAINT_TOOLS = new Set(['built', 'park', 'plaza']);

export function createEditor({
  scene,
  camera,
  domElement,
  initialLevel,     // if set, edit this level; otherwise start from the currently loaded layout
  currentLayout,    // the block array as passed to createGround et al — used to seed the state
  onEnter,
  onExit,
}) {
  const overlay = createEditorOverlay();
  scene.add(overlay.group);

  const state = initialLevel
    ? levelToEditorState(initialLevel)
    : levelToEditorState(serialize(currentLayout));

  let active = false;
  let currentTool = 'built';

  // --- History (undo) ---
  const history = [];
  const HISTORY_LIMIT = 40;
  const snapshot = () => JSON.stringify(editorStateToLevel(state));
  const push = () => {
    history.push(snapshot());
    if (history.length > HISTORY_LIMIT) history.shift();
  };
  const undo = () => {
    if (!history.length) return;
    const prev = history.pop();
    const s = levelToEditorState(JSON.parse(prev));
    Object.assign(state, s);
    overlay.syncState(state);
  };

  // --- DOM ---
  const root = document.createElement('div');
  root.id = 'editor';
  root.hidden = true;
  root.innerHTML = `
    <div class="editor-bar editor-tools">
      ${TOOLS.map((t) => `<button type="button" class="editor-tool" data-tool="${t.id}" title="${t.desc}">${t.label}</button>`).join('')}
      <button type="button" class="editor-tool" data-action="undo" title="Undo last edit (Ctrl+Z)">Undo</button>
    </div>
    <div class="editor-bar editor-actions">
      <button type="button" data-action="import">Import…</button>
      <button type="button" data-action="export">Export</button>
      <button type="button" data-action="share">Copy URL</button>
      <button type="button" data-action="reset">Reset</button>
      <button type="button" data-action="play" class="editor-play">▶ Play</button>
      <button type="button" data-action="exit" class="editor-exit" title="Discard and leave editor">✕</button>
    </div>
    <div class="editor-status" aria-live="polite"></div>
    <textarea class="editor-json" spellcheck="false" hidden></textarea>
  `;
  document.body.appendChild(root);

  const toggle = document.createElement('button');
  toggle.id = 'editor-toggle';
  toggle.type = 'button';
  toggle.title = 'Open the level editor';
  toggle.textContent = 'Edit';
  document.body.appendChild(toggle);

  const status = root.querySelector('.editor-status');
  const jsonBox = root.querySelector('.editor-json');
  const toolButtons = root.querySelectorAll('.editor-tool[data-tool]');
  const refreshToolButtons = () => {
    toolButtons.forEach((b) => b.classList.toggle('is-active', b.dataset.tool === currentTool));
  };
  refreshToolButtons();

  function flash(msg) {
    status.textContent = msg;
    status.classList.remove('is-flashing');
    void status.offsetWidth;
    status.classList.add('is-flashing');
  }

  // --- Tool actions --------------------------------------------------------

  function applyBlockPaint(bi, bj, type) {
    push();
    const key = `${bi},${bj}`;
    const wasPark = state.cellTypes.get(key) === 'park';

    // Leaving a district: also remove the pairing on the twin and reopen the closure.
    if (wasPark && state.districtOf.has(key)) {
      const districtId = state.districtOf.get(key);
      for (const [k, id] of [...state.districtOf]) {
        if (id !== districtId) continue;
        state.districtOf.delete(k);
        // If the twin remains a park it stays as a lone park; nothing else to do.
      }
      for (const closureKey of collectDistrictClosures(districtId)) state.closed.delete(closureKey);
    }

    if (type === 'built') state.cellTypes.delete(key);
    else state.cellTypes.set(key, type);

    // Painting a park adjacent to another lone park pairs them into a fresh district.
    if (type === 'park') {
      for (const [dbi, dbj] of neighbours(bi, bj)) {
        const nk = `${dbi},${dbj}`;
        if (state.cellTypes.get(nk) !== 'park') continue;
        if (state.districtOf.has(nk)) continue;      // already in a district
        if (state.districtOf.has(key)) continue;     // this cell already paired
        const id = nextDistrictId();
        state.districtOf.set(key, id);
        state.districtOf.set(nk, id);
        const segment = segmentBetween(bi, bj, dbi, dbj);
        if (segment) state.closed.add(segment);
        break;
      }
    }
  }

  function collectDistrictClosures(districtId) {
    // Find the two cells in this district and the segment between them.
    const members = [...state.districtOf].filter(([, id]) => id === districtId).map(([k]) => k.split(',').map(Number));
    if (members.length < 2) return [];
    const [a, b] = members;
    const seg = segmentBetween(a[0], a[1], b[0], b[1]);
    return seg ? [seg] : [];
  }

  function neighbours(bi, bj) {
    const out = [];
    if (bi > 0) out.push([bi - 1, bj]);
    if (bi < GRID - 1) out.push([bi + 1, bj]);
    if (bj > 0) out.push([bi, bj - 1]);
    if (bj < GRID - 1) out.push([bi, bj + 1]);
    return out;
  }

  function nextDistrictId() {
    let id = 0;
    const used = new Set(state.districtOf.values());
    while (used.has(id)) id++;
    return id;
  }

  /**
   * Arterial rotation: off → +1 → -1 → off. So the same tool covers three states with a familiar
   * click-to-cycle idiom. Because arterials live on *lines* not segments, we translate the picked
   * segment to its line (the perpendicular index) and act on that.
   */
  function cycleArterial(i, j, d) {
    push();
    const runsAlongX = d === 0;   // segment runs along X → sits on a road whose axis is X (line j)
    const set = runsAlongX ? state.arterialX : state.arterialZ;
    const dirs = runsAlongX ? state.dirX : state.dirZ;
    const line = runsAlongX ? j : i;
    if (!set.has(line)) {
      set.add(line);
      dirs.set(line, 1);
    } else if (dirs.get(line) === 1) {
      dirs.set(line, -1);
    } else {
      set.delete(line);
      dirs.delete(line);
    }
  }

  function cycleTaxiStart(i, j) {
    push();
    if (state.taxiStart && state.taxiStart.i === i && state.taxiStart.j === j) {
      // Same intersection — rotate the heading through the four cardinal directions, dropping
      // back to null after a full cycle so the tool can also *remove* the pin.
      const d = (state.taxiStart.d + 1) % 5;
      state.taxiStart = d === 4 ? null : { i, j, d };
    } else {
      state.taxiStart = { i, j, d: 0 };
    }
  }

  // --- Pointer / picker (only active while editor is open) -----------------

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hovered = null;

  function pickAt(event) {
    const rect = domElement.getBoundingClientRect();
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    for (const hit of raycaster.intersectObjects(overlay.pickTargets, true)) {
      const ud = hit.object.userData;
      if (!ud?.pickable) continue;
      // Filter to what the current tool cares about, so a hover doesn't glow on things this
      // tool can't affect. Paint tools accept both blocks and road segments: painting on a road
      // closes it, which is the "paint over the pavement" gesture the user expected.
      if (PAINT_TOOLS.has(currentTool) && ud.pickable !== 'block' && ud.pickable !== 'segment') continue;
      if (currentTool === 'road' && ud.pickable !== 'segment') continue;
      if (currentTool === 'arterial' && ud.pickable !== 'segment') continue;
      if (currentTool === 'taxi' && ud.pickable !== 'intersection') continue;
      return ud;
    }
    return null;
  }

  function onMove(event) {
    if (!active) return;
    const picked = pickAt(event);
    hovered = picked;
    if (picked) overlay.setHover(picked.pickable, picked);
    else overlay.setHover(null);
  }

  function onClick(event) {
    if (!active) return;
    const picked = pickAt(event);
    if (!picked) return;

    if (picked.pickable === 'block' && PAINT_TOOLS.has(currentTool)) {
      applyBlockPaint(picked.bi, picked.bj, currentTool);
    } else if (picked.pickable === 'segment' && PAINT_TOOLS.has(currentTool)) {
      // Painting on the pavement closes the road. Doesn't reopen an already-closed one — Road
      // is the eraser for that, so a paint stroke that hits both blocks and roads never
      // accidentally un-does closures the user just painted.
      if (!state.closed.has(picked.key)) {
        push();
        state.closed.add(picked.key);
      }
    } else if (picked.pickable === 'segment' && currentTool === 'road') {
      if (state.closed.has(picked.key)) {
        push();
        state.closed.delete(picked.key);
      }
    } else if (picked.pickable === 'segment' && currentTool === 'arterial') {
      cycleArterial(picked.i, picked.j, picked.d);
    } else if (picked.pickable === 'intersection' && currentTool === 'taxi') {
      cycleTaxiStart(picked.i, picked.j);
    }
    overlay.syncState(state);
  }

  function onKey(event) {
    if (!active) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'z') {
      event.preventDefault();
      undo();
      flash('Undo');
    }
  }

  domElement.addEventListener('pointermove', onMove);
  domElement.addEventListener('click', onClick);
  window.addEventListener('keydown', onKey);

  // --- Actions -------------------------------------------------------------

  function selectTool(id) {
    currentTool = id;
    refreshToolButtons();
    overlay.setHover(null);
    flash(TOOLS.find((t) => t.id === id)?.desc ?? '');
  }

  function open() {
    if (active) return;
    active = true;
    root.hidden = false;
    toggle.textContent = 'Close';
    overlay.show(true);
    overlay.syncState(state);
    onEnter?.();
    flash('Editor open — click a block or road to edit. Play to try it out.');
  }

  function close({ discard = true } = {}) {
    if (!active) return;
    active = false;
    root.hidden = true;
    toggle.textContent = 'Edit';
    overlay.show(false);
    overlay.setHover(null);
    if (discard) onExit?.();
  }

  function levelJson() {
    return editorStateToLevel(state);
  }

  function play() {
    const level = levelJson();
    const errors = validate(level);
    if (errors.length) {
      flash(`Cannot play: ${errors[0]}`);
      return;
    }
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(level));
    // Preserve any ?seed/?run/?cars that were already on the URL so a familiar setup carries
    // over. Drop ?shot — the editor isn't for review framings.
    const params = new URLSearchParams(window.location.search);
    params.set('level', 'session');
    params.delete('shot');
    window.location.search = params.toString();
  }

  function exportJson() {
    const level = levelJson();
    jsonBox.value = JSON.stringify(level, null, 2);
    jsonBox.hidden = false;
    jsonBox.focus();
    jsonBox.select();
    flash('Exported. Copy the JSON, or paste new JSON in and click Import.');
  }

  function importJson() {
    jsonBox.hidden = false;
    if (!jsonBox.value.trim()) {
      jsonBox.value = JSON.stringify(levelJson(), null, 2);
      jsonBox.focus();
      jsonBox.select();
      flash('Paste your level JSON in the box, then click Import again.');
      return;
    }
    try {
      const parsed = JSON.parse(jsonBox.value);
      const errors = validate(parsed);
      if (errors.length) {
        flash(`Import failed: ${errors[0]}`);
        return;
      }
      push();
      const next = levelToEditorState(parsed);
      Object.assign(state, next);
      overlay.syncState(state);
      flash('Imported.');
    } catch (err) {
      flash(`Import failed: ${err.message}`);
    }
  }

  async function share() {
    const level = levelJson();
    const url = new URL(window.location.href);
    url.searchParams.set('level', `raw:${encodeUrl(level)}`);
    url.searchParams.delete('shot');
    try {
      await navigator.clipboard?.writeText(url.toString());
      flash('URL copied to clipboard.');
    } catch {
      jsonBox.value = url.toString();
      jsonBox.hidden = false;
      jsonBox.focus();
      jsonBox.select();
      flash('URL is in the box below — copy it manually.');
    }
  }

  function reset() {
    if (!confirm('Reset to a blank city (all blocks built, no closures, no arterials)?')) return;
    push();
    state.cellTypes.clear();
    state.districtOf.clear();
    state.closed.clear();
    state.arterialX.clear();
    state.arterialZ.clear();
    state.dirX.clear();
    state.dirZ.clear();
    state.taxiStart = null;
    overlay.syncState(state);
    flash('Reset.');
  }

  root.addEventListener('click', (event) => {
    const el = event.target;
    if (el.dataset.tool) return selectTool(el.dataset.tool);
    if (el.dataset.action === 'undo') { undo(); flash('Undo'); return; }
    if (el.dataset.action === 'import') return importJson();
    if (el.dataset.action === 'export') return exportJson();
    if (el.dataset.action === 'share') return share();
    if (el.dataset.action === 'reset') return reset();
    if (el.dataset.action === 'play') return play();
    if (el.dataset.action === 'exit') return close();
  });
  toggle.addEventListener('click', () => (active ? close() : open()));

  return {
    open,
    close,
    isActive: () => active,
    /** Test hook — mutate the state directly without going through DOM events. */
    _state: state,
  };
}
