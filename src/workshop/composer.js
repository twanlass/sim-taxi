// The workshop's composer: a text box with its controls sitting inside its bottom edge — the Speed
// picker bottom-left, the mic, Stop and Send bottom-right. One component for both places a message
// is written, the chat panel (chat.js) and the note beside a pin on the bench (viewer.js), so the
// two cannot drift: the pin note had been a bare box with a Send button and nothing else, which
// meant a pinned message could not pick its model or be dictated.
//
// Owns what every composer does: growing with its text, Enter to send (Shift-Enter for a newline),
// the Speed picker and its remembered value, and dictation. What only the chat does — pasted images,
// the draft kept across reloads, Queue and Stop's meaning — stays in chat.js, on top of `input`.
//
// Imports nothing, so chat.js can use it without breaking its own rule (it imports nothing from the
// game), and the viewer can rebuild it on every hot reload for free.

const SPEED_KEY = 'workshop-speed';
const SPEED_EVENT = 'workshop:speed';

const MIC_ICON = `<svg class="mic-icon" width="12" height="14" viewBox="0 0 12 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
  <rect x="3.75" y="0.75" width="4.5" height="8" rx="2.25" fill="currentColor" stroke="none"/>
  <path d="M1.5 6.5a4.5 4.5 0 0 0 9 0M6 11v2.25"/>
</svg>`;
const UP_ICON = `<svg class="up-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M7 12V2.5M2.75 6.75 7 2.5l4.25 4.25"/>
</svg>`;
const STOP_ICON = '<svg class="stop-icon" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor"/></svg>';

// The browser's own speech recognition (the Web Speech API, prefixed in Chrome and Safari), so
// nothing is uploaded by this page and nothing is installed. Firefox has none, and there the mic
// stays hidden. In Chrome the audio goes to Google's recognition service, which is the browser's
// doing and not ours.
const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;

// The waveform: how many bars, and how often a new level is pushed in at the right. ~70ms a step
// scrolls a syllable across a few bars, which reads as speech; every frame was a blur.
const WAVE_BARS = 10;            // 60px with its padding; 14 was 80 and crowded the box
const WAVE_STEP_MS = 70;

/**
 * Build a composer. Returns the element (not yet in the page) and handles on its parts.
 *
 * - `onSend(text)` runs on Enter or Send with the trimmed text. Empty text is not sent unless
 *   `canSend()` says there is something else to send (the chat's pasted images).
 * - `onInput()` runs after every change to the text, typed or dictated.
 * - `onError(message)` is told when dictation fails for a reason worth saying (a blocked mic).
 * - `stop` adds a Stop button, hidden until the caller shows it; `onStop` is its click.
 * - `signal` aborts the window-level listeners, for a caller that is torn down and rebuilt (the
 *   viewer, on every hot reload).
 */
export function createComposer({
  placeholder = '', rows = 3, inputId, className = '',
  onSend, onInput, onError, canSend = () => false,
  stop = false, onStop, signal,
} = {}) {
  const el = document.createElement('div');
  el.className = `field composer ${className}`.trim();

  const input = document.createElement('textarea');
  if (inputId) input.id = inputId;
  input.rows = rows;
  input.placeholder = placeholder;

  // Which model a message goes to: Auto lets the endpoint judge (`isSimple`), Fast and Smart say.
  // Kept in localStorage rather than the conversation, since it is a preference, not a turn, and
  // shared by every composer: changing it in one says so to the rest (`SPEED_EVENT`).
  const left = document.createElement('span');
  left.className = 'field-left';
  const speed = document.createElement('select');
  speed.className = 'speed';
  speed.title = 'Which model: Auto sends short, single requests to the fast one';
  for (const [value, label] of [['auto', 'Auto'], ['fast', 'Fast'], ['smart', 'Smart']]) {
    speed.append(new Option(label, value));
  }
  speed.value = localStorage.getItem(SPEED_KEY) ?? 'auto';
  speed.addEventListener('change', () => {
    localStorage.setItem(SPEED_KEY, speed.value);
    dispatchEvent(new CustomEvent(SPEED_EVENT, { detail: speed.value }));
  });
  addEventListener(SPEED_EVENT, (event) => { speed.value = event.detail; }, { signal });
  // A level meter that takes the picker's place while dictating (CSS, `.composer.listening`), so
  // there is something moving the moment you speak, before the recogniser has any words to show.
  const wave = document.createElement('span');
  wave.className = 'wave';
  wave.setAttribute('aria-hidden', 'true');
  const bars = Array.from({ length: WAVE_BARS }, () => wave.appendChild(document.createElement('i')));
  left.append(speed, wave);

  const actions = document.createElement('span');
  actions.className = 'field-actions';
  const mic = button('act mic', 'Dictate', MIC_ICON + STOP_ICON);
  mic.hidden = true;
  const stopButton = stop ? button('act stop', 'Stop', STOP_ICON) : null;
  if (stopButton) {
    stopButton.hidden = true;
    stopButton.addEventListener('click', () => onStop?.());
  }
  // An up arrow in every state, the same icon pill as Stop and send below: a "Send" / "Queue" word was
  // wider than the arrow that replaces it while dictating, so toggling voice mode shifted the row.
  const sendButton = button('act primary send', 'Send', UP_ICON);
  // Voice mode's second button, to the right of the mic-turned-Stop: end the dictation and send what
  // was heard. Only shown while listening (CSS, `.composer.listening`), where Send itself is hidden.
  const stopSend = button('act primary stopsend', 'Stop and send', UP_ICON);
  actions.append(...[mic, stopButton, sendButton, stopSend].filter(Boolean));
  el.append(input, left, actions);

  /** Send is only live with something to send. */
  function sync() {
    sendButton.disabled = !input.value.trim() && !canSend();
  }

  /**
   * Size the box to its text. Collapsed first so it can shrink as well as grow, then set to the
   * content's height plus the border (`scrollHeight` leaves it out and the box is border-box). The
   * CSS `min-height` and `max-height` are what bound it; past the cap it scrolls.
   */
  function autosize() {
    sync();
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight + 2}px`;
    // Kept at the end while it grows, so the line being typed is not the one scrolled away.
    if (input.scrollHeight > input.clientHeight) input.scrollTop = input.scrollHeight;
  }

  function submit() {
    recognizer?.stop();         // a send while dictating (Enter) ends it first
    const text = input.value.trim();
    if (!text && !canSend()) return;
    onSend?.(text);
  }

  input.addEventListener('input', () => { autosize(); onInput?.(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  sendButton.addEventListener('click', submit);

  // Dictation. Pressed, the mic starts listening and the transcript streams into the box as it is
  // recognised, interim words included, after whatever was already typed. While it listens the
  // picker, Stop and Send step aside and the mic is a stop button (CSS, `.composer.listening`).
  let recognizer = null;
  let meter = null;
  let sendOnEnd = false;          // Stop and send: the last words arrive after stop(), so send at onend
  stopSend.addEventListener('click', () => {
    if (!recognizer) return;
    sendOnEnd = true;
    recognizer.stop();
  });
  if (Recognition) {
    mic.hidden = false;
    mic.addEventListener('click', () => {
      if (recognizer) { recognizer.stop(); return; }
      const r = new Recognition();
      r.continuous = true;        // keep going through pauses until stopped
      r.interimResults = true;    // words appear as they are heard, then settle
      r.lang = navigator.language || 'en-US';
      // What was in the box when listening began, so the transcript goes after it, with a space
      // between if the box did not already end in one.
      const base = input.value && !/\s$/.test(input.value) ? `${input.value} ` : input.value;
      r.onresult = (event) => {
        let heard = '';
        // `results` is everything since `start()`, finished and in-progress alike, so the box is
        // rebuilt from base + all of it each time rather than appended to.
        for (let i = 0; i < event.results.length; i++) heard += event.results[i][0].transcript;
        input.value = base + heard.trimStart();
        // The same event a keystroke fires, so whatever listens for typing hears this too.
        input.dispatchEvent(new Event('input'));
      };
      r.onerror = (event) => {
        // `no-speech` and `aborted` are just a quiet room or our own stop: not worth a message.
        if (event.error === 'no-speech' || event.error === 'aborted') return;
        const message = event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? 'Microphone access was blocked. Allow it for this page in the browser, then try again.'
          : `Voice input stopped: ${event.error}.`;
        if (onError) onError(message); else console.warn(message);
      };
      r.onend = () => {
        recognizer = null;
        meter?.stop();
        meter = null;
        el.classList.remove('listening');
        label(mic, 'Dictate');
        input.focus();
        if (sendOnEnd) { sendOnEnd = false; submit(); }
      };
      try {
        r.start();
      } catch {
        return;                   // already running: a double press
      }
      recognizer = r;
      meter = listenLevels(bars);
      el.classList.add('listening');
      label(mic, 'Stop dictating');
    });
    // The page going away (or the caller being rebuilt) mid-dictation would leave a recognizer
    // talking to nothing.
    addEventListener('pagehide', () => { recognizer?.abort(); meter?.stop(); }, { signal });
    signal?.addEventListener('abort', () => { recognizer?.abort(); meter?.stop(); });
  }

  autosize();
  return {
    el, input, sendButton, stopButton, speedSelect: speed,
    autosize,
    get value() { return input.value; },
    set value(text) { input.value = text; autosize(); },
    focus: (options) => input.focus(options),
    /** "Queue" rather than "Send" while a reply is still going: it will wait its turn. */
    setQueued(queued) { label(sendButton, queued ? 'Queue' : 'Send'); },
    stopListening: () => recognizer?.stop(),
  };
}

/**
 * Drive the waveform's bars off the microphone. Speech recognition hands over words, never audio,
 * so this opens its own stream beside it and reads its loudness through an AnalyserNode. Each step
 * pushes the latest level in at the right and scrolls the rest left. If the mic cannot be opened
 * the bars just sit at their resting height; dictation does not depend on it. Returns `stop()`.
 */
function listenLevels(bars) {
  let stopped = false;
  let stream = null;
  let context = null;
  let raf = 0;
  const levels = bars.map(() => 0);
  const draw = () => bars.forEach((bar, i) => { bar.style.transform = `scaleY(${0.15 + 0.85 * levels[i]})`; });
  draw();
  navigator.mediaDevices?.getUserMedia({ audio: true }).then((s) => {
    if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
    stream = s;
    context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(s).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let last = 0;
    let peak = 0;
    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      // RMS of ordinary speech near a laptop mic is ~0.02–0.1, so it is scaled up and square-rooted
      // to make quiet talk still visibly move; the peak between steps keeps a short word from
      // falling through the gap.
      peak = Math.max(peak, Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length) * 8)));
      if (now - last < WAVE_STEP_MS) return;
      last = now;
      levels.shift();
      levels.push(peak);
      peak = 0;
      draw();
    };
    raf = requestAnimationFrame(tick);
  }).catch(() => {});
  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      context?.close();
      levels.fill(0);
      draw();
    },
  };
}

function button(className, name, html) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  if (name) label(b, name);
  b.innerHTML = html;
  return b;
}

function label(b, name) {
  b.setAttribute('aria-label', name);
  b.title = name;
}
