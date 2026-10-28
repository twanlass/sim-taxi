// Dev server only: keeps the talk (/talk/) and the games inside it from reloading when the model
// workshop's agent edits the game's source mid-talk. See docs/talk.md#the-workshop-and-the-dev-server.
//
// The game has no hot-reload boundary — main.js boots the game on import, so nothing can swap a
// module under it — and Vite's answer to an edit that reaches a module with no boundary is a
// `full-reload` broadcast to *every* page on the server, whatever page the module belongs to. The
// talk keeps a game running in its live phone, so every edit the workshop's agent saved mid-demo
// reloaded the whole deck: back to slide 9, out of the phone, the run gone. (It was reported as
// the phone "minimising back to the slide view" as the opening story finished, which is about when
// the agent kicked off during the demo got round to writing its first file.)
//
// So every page served while the top window is the talk drops a `full-reload` unless it was set
// off by the talk's own files (talk/ or src/talk/), which still reload the deck as they should
// while it is being worked on. Not the workshop's frame: it shows an edit by reloading, and that
// is the point of having it up. It is a classic inline script at the top of <head>, ahead of Vite's
// own client — a module script, so deferred — and it wraps the HMR socket the client opens.

const GUARD = `(() => {
  let top;
  try { top = window.top.location.pathname; } catch { return; }
  if (!top.startsWith('/talk') || location.pathname.startsWith('/workshop')) return;
  const Native = window.WebSocket;
  function Held(url, protocols) {
    const socket = new Native(url, protocols);
    if (protocols !== 'vite-hmr') return socket;
    const add = socket.addEventListener.bind(socket);
    socket.addEventListener = (type, fn, options) => add(type, type !== 'message' ? fn : (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch {}
      if (message?.type === 'full-reload' && !/\\/(src\\/)?talk\\//.test(message.triggeredBy ?? '')) {
        console.info('[talk] held a page reload for', message.triggeredBy);
        return;
      }
      fn(event);
    }, options);
    return socket;
  }
  Held.prototype = Native.prototype;
  Object.assign(Held, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Held;
})();`;

export function talkHold() {
  return {
    name: 'talk-hold',
    apply: 'serve',
    transformIndexHtml: () => [{ tag: 'script', children: GUARD, injectTo: 'head-prepend' }],
  };
}
