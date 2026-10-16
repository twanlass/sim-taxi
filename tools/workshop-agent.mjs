/**
 * The model workshop's chat panel, server side — see docs/workshop.md.
 *
 * A Vite plugin, dev server only (`apply: 'serve'`), that hands each chat message to the Claude
 * Code CLI running headless in the repo (`claude -p`). That is the whole trick, and the reason the
 * panel needs no API key and no server of its own: it borrows the login of whoever ran
 * `npm run dev`, and the agent edits the real source files, which Vite then hot-reloads into the
 * viewer. There is no "export the values back into the game" step because the values never left.
 *
 * Three endpoints under `/__workshop/`:
 *
 *   POST /chat              { message, sessionId?, model: { id, label, source }, view, image? }
 *                           → { runId }. `image` is a PNG data URL of the canvas, written to
 *                           `.workshop/view.png` for the agent to Read.
 *   GET  /runs/:id?from=n   the run's events from index `n`, as NDJSON, held open until it ends.
 *   POST /runs/:id/stop     kill it.
 *   POST /runs/:id/undo     put every file the run edited back the way it was before the run.
 *
 * **A run outlives the request that started it.** An edit to something the viewer's whole import
 * graph hangs off (the palette, the scene) or to the page itself reloads the tab, and the tab is
 * where the stream was being read — if the child were tied to that socket, the agent would be
 * killed by its own edit. So the run buffers every event it emits, and a reloaded page reattaches
 * with `from=` and replays what it missed.
 *
 * Loopback only. This endpoint edits files and runs `npm run check`; `vite --host` would otherwise
 * hand that to the whole Wi-Fi network.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/**
 * What the agent may do without asking. Headless, there is nobody to ask, so anything not on this
 * list is simply refused: edits (via `acceptEdits`), reads, searches, the check suite, and looking
 * at its own diff. No git writes, no network, no servers.
 */
const ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(npm run check)', 'Bash(node tools/*)', 'Bash(git diff*)', 'Bash(git status*)',
].join(',');

const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The system-prompt addendum for one turn: what is on the bench and where its code lives. */
export function workshopPrompt(model, { image = null, view = 'orbit' } = {}) {
  const lines = [
    'You are running inside the Rocket Rides model workshop (/workshop/ on the Vite dev server).',
    `The person chatting is looking at the "${model.label}" on the bench. It is built by ${model.source}.`,
    'Every model there is built by the game\'s own code, so make the change they ask for directly in that source.',
    'Vite hot-reloads your edit into their viewer within a second, and it is the shipped game code: there is no separate copy to sync back.',
    view === 'game'
      ? 'They are looking through the game camera: the fixed orthographic 3/4 view. Detail smaller than about a tenth of a unit will not read there.'
      : 'They are orbiting the model up close. In the game it is seen from a fixed orthographic 3/4 view at about 7.7 px per unit, so tiny details may not read in play.',
  ];
  if (image) {
    lines.push(`A screenshot of exactly what they see is at ${image}. Read it before any visual change, and refer to parts by what is visible in it.`);
  }
  lines.push(
    'Follow CLAUDE.md: colours live in src/palette.js, geometry constants in src/city/grid.js, trees go through treeParts, water through the shared shader, and comments carry the why.',
    'Keep the change scoped to this model unless asked otherwise. Do not commit, push, install packages, or start servers.',
    'Finish with one or two plain sentences saying what you changed and where (file:line). No headings, no lists unless asked.',
  );
  return lines.join('\n');
}

/** Boil the CLI's stream-json down to the four things the panel draws. */
function translate(line, run, emit) {
  let event;
  try { event = JSON.parse(line); } catch { return; }

  if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
    emit({ type: 'session', id: event.session_id });
  } else if (event.type === 'stream_event') {
    const inner = event.event;
    if (inner?.type === 'message_start') {
      run.streamed = false;
      emit({ type: 'break' });
    } else if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
      run.streamed = true;
      emit({ type: 'text', text: inner.delta.text });
    }
  } else if (event.type === 'assistant' && !event.parent_tool_use_id) {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'text' && !run.streamed) {
        emit({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        const input = block.input ?? {};
        if (EDITING_TOOLS.has(block.name) && input.file_path) run.touched.add(String(input.file_path));
        const detail = input.file_path ?? input.command ?? input.pattern ?? input.path ?? '';
        emit({ type: 'tool', name: block.name, detail: String(detail) });
      }
    }
  } else if (event.type === 'result') {
    run.result = { ok: !event.is_error, error: event.is_error ? String(event.result ?? 'failed') : null };
  }
}

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * The working tree as it stood before a run, for undo. `git stash create` writes the tree with
 * every uncommitted change in it as a dangling commit and touches nothing — not the index, not the
 * stash list, not a file — and prints nothing on a clean tree, where HEAD is the same answer. It
 * cannot hold an untracked file, so those are listed: a file the agent created is deleted on undo,
 * and one that was already lying around untracked is left alone, since there is no copy of it.
 */
function snapshot(root) {
  try {
    const ref = git(root, ['stash', 'create']).trim() || git(root, ['rev-parse', 'HEAD']).trim();
    const untracked = new Set(git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
    return { ref, untracked };
  } catch {
    return null;    // not a git checkout: no undo, everything else still works
  }
}

/**
 * Put the files a run edited back. Edits made by hand to those same files *during* the run go
 * with them — the snapshot is from before the run, and that is the price of an undo this simple.
 */
function undo(root, run) {
  if (!run.before) throw new Error('No snapshot to undo to (not a git checkout?).');
  if (run.undone) return { restored: [], kept: [] };
  const restored = [];
  const kept = [];
  for (const file of run.touched) {
    const abs = resolve(root, file);
    const rel = relative(root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) { kept.push(file); continue; }
    const path = rel.split('\\').join('/');
    let original = null;
    try {
      original = execFileSync('git', ['show', `${run.before.ref}:${path}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { /* not in the snapshot */ }
    if (original) writeFileSync(abs, original);
    else if (run.before.untracked.has(path)) { kept.push(path); continue; }
    else if (existsSync(abs)) unlinkSync(abs);
    restored.push(path);
  }
  run.undone = true;
  return { restored, kept };
}

export function workshopAgent({ bin = process.env.CLAUDE_BIN || 'claude' } = {}) {
  const runs = new Map();
  let nextId = 1;
  let busy = null;

  function start(root, body) {
    const id = String(nextId++);
    const run = { id, events: [], listeners: new Set(), done: false, child: null, streamed: false, result: null, touched: new Set(), before: snapshot(root) };
    runs.set(id, run);
    // Keep the last few runs to reattach to; older ones are history nobody will ask for.
    for (const old of runs.keys()) if (runs.size > 8 && old !== id) runs.delete(old);

    const emit = (event) => {
      run.events.push(event);
      for (const listener of run.listeners) listener();
    };
    const finish = (event) => {
      if (run.done) return;
      run.done = true;
      busy = null;
      const edited = [...run.touched].map((file) => relative(root, resolve(root, file)));
      emit({ type: 'done', ...event, edited, undoable: Boolean(run.before) && edited.length > 0 });
    };

    let image = null;
    if (typeof body.image === 'string' && body.image.startsWith('data:image/png;base64,')) {
      const dir = join(root, '.workshop');
      mkdirSync(dir, { recursive: true });
      image = join(dir, 'view.png');
      writeFileSync(image, Buffer.from(body.image.slice('data:image/png;base64,'.length), 'base64'));
    }

    const args = [
      '-p', String(body.message ?? ''),
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', ALLOWED_TOOLS,
      '--append-system-prompt', workshopPrompt(body.model ?? { label: 'model', source: 'src/' }, { image, view: body.view }),
    ];
    if (typeof body.sessionId === 'string' && /^[\w-]+$/.test(body.sessionId)) args.push('--resume', body.sessionId);

    let child;
    try {
      child = spawn(bin, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ ok: false, error: error.message });
      return run;
    }
    run.child = child;
    busy = run;

    let buffer = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) translate(line, run, emit);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', (error) => finish({
      ok: false,
      error: error.code === 'ENOENT'
        ? `Couldn't find the Claude Code CLI (\`${bin}\`). Install it, or set CLAUDE_BIN, and restart npm run dev.`
        : error.message,
    }));
    child.on('close', (code, signal) => {
      if (signal) finish({ ok: false, error: 'Stopped.' });
      else if (run.result) finish(run.result);
      else finish({ ok: code === 0, error: code === 0 ? null : (stderr.trim() || `claude exited with ${code}`) });
    });
    return run;
  }

  function stream(run, from, res) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    let sent = Math.max(0, from);
    const flush = () => {
      while (sent < run.events.length) res.write(`${JSON.stringify(run.events[sent++])}\n`);
      if (run.done) {
        run.listeners.delete(flush);
        res.end();
      }
    };
    run.listeners.add(flush);
    res.on('close', () => run.listeners.delete(flush));
    flush();
  }

  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };

  return {
    name: 'workshop-agent',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root;
      server.middlewares.use('/__workshop', (req, res) => {
        if (!LOOPBACK.has(req.socket.remoteAddress)) return json(res, 403, { error: 'loopback only' });
        const url = new URL(req.url, 'http://localhost');
        const runMatch = url.pathname.match(/^\/runs\/(\d+)(\/stop|\/undo)?$/);

        if (req.method === 'POST' && url.pathname === '/chat') {
          if (busy) return json(res, 409, { error: 'Still working on the last message.', runId: busy.id });
          let raw = '';
          req.setEncoding('utf8');
          req.on('data', (chunk) => { raw += chunk; });
          req.on('end', () => {
            let body;
            try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
            if (!body.message?.trim()) return json(res, 400, { error: 'empty message' });
            json(res, 200, { runId: start(root, body).id });
          });
          return undefined;
        }
        if (runMatch) {
          const run = runs.get(runMatch[1]);
          if (!run) return json(res, 404, { error: 'no such run' });
          if (runMatch[2] === '/stop' && req.method === 'POST') {
            run.child?.kill('SIGTERM');
            return json(res, 200, { ok: true });
          }
          if (runMatch[2] === '/undo' && req.method === 'POST') {
            if (!run.done || busy) return json(res, 409, { error: 'Wait for the reply to finish first.' });
            try {
              return json(res, 200, undo(root, run));
            } catch (error) {
              return json(res, 500, { error: error.message });
            }
          }
          return stream(run, Number(url.searchParams.get('from')) || 0, res);
        }
        if (url.pathname === '/status') return json(res, 200, { busy: busy?.id ?? null });
        return json(res, 404, { error: 'not found' });
      });
    },
  };
}
