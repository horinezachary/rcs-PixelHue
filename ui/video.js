// Live canvases from the switcher's input preview (the same file is in ui/ and web/; a test keeps them equal).
//
// The module relays the switcher's preview streams (a grid of inputs, about 5 fps) as fragmented MP4 in UI
// messages. Each stream plays in a hidden <video> through Media Source Extensions, and every canvas on the page
// is painted from it: each layer gets its input's tile, cropped out of the grid and scaled to the layer's
// place on the screen. A multiviewer tile showing a screen's PGM or PVW gets that screen, drawn the same way.
// Layers with no live picture keep the plain boxes drawn under the video.

const ASK_MS = 5000;
const FRAME_MS = 100;

// A classic script (module frames are sandboxed, so an ES module import would be a cross-origin load).
window.createVideo = function createVideo(rcs) {
  let snap = null;
  /** Canvases on the page now: { el, scr, layers }. */
  let regs = [];
  /** `${sw}:${stream}` → player */
  const players = new Map();
  let asked = '';
  let askedAt = 0;

  function player(key) {
    let p = players.get(key);
    if (p) return p;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;left:0;top:0';
    document.body.append(video);
    p = { key, video, ms: null, sb: null, mime: '', queue: [], parts: new Map(), started: false };
    players.set(key, p);
    return p;
  }

  function closePlayer(p) {
    p.video.removeAttribute('src');
    p.video.load();
    p.video.remove();
    if (p.url) URL.revokeObjectURL(p.url);
    players.delete(p.key);
  }

  function open(p, mime, data) {
    if (p.ms) {
      p.video.removeAttribute('src');
      if (p.url) URL.revokeObjectURL(p.url);
    }
    p.mime = mime;
    p.queue = [data];
    p.sb = null;
    p.started = false;
    if (!window.MediaSource || !MediaSource.isTypeSupported(mime)) return;
    const ms = new MediaSource();
    p.ms = ms;
    p.url = URL.createObjectURL(ms);
    ms.addEventListener('sourceopen', () => {
      if (p.ms !== ms) return;
      try {
        p.sb = ms.addSourceBuffer(mime);
        p.sb.mode = 'segments';
        p.sb.addEventListener('updateend', () => pump(p));
        pump(p);
      } catch {}
    }, { once: true });
    p.video.src = p.url;
  }

  function pump(p) {
    const sb = p.sb;
    if (!sb || sb.updating || !p.queue.length) return;
    // Keep only the last few seconds.
    const b = sb.buffered;
    if (b.length && p.video.currentTime - b.start(0) > 12) {
      try {
        sb.remove(b.start(0), p.video.currentTime - 6);
        return;
      } catch {}
    }
    try {
      sb.appendBuffer(p.queue.shift());
    } catch {
      p.queue = [];
    }
  }

  function onMessage(m) {
    if (m?.type !== 'video') return;
    const p = player(`${m.sw}:${m.stream}`);
    const id = `${m.kind}:${m.seq}`;
    let parts = p.parts.get(id);
    if (!parts) p.parts.set(id, (parts = []));
    parts[m.part] = m.data;
    if (parts.filter((x) => x != null).length < m.parts) return;
    p.parts.delete(id);
    // Each part is base64 on its own.
    const bins = parts.map((x) => atob(x));
    const bytes = new Uint8Array(bins.reduce((a, b) => a + b.length, 0));
    let at = 0;
    for (const b of bins) for (let i = 0; i < b.length; i++) bytes[at++] = b.charCodeAt(i);
    if (m.kind === 'init') return open(p, m.mime, bytes);
    if (!p.ms) return;
    p.queue.push(bytes);
    if (p.queue.length > 60) p.queue.splice(0, p.queue.length - 60);
    pump(p);
  }

  /** Stay at the live edge, and step over any gap a slow connection left. */
  function keepLive(p) {
    const v = p.video;
    const b = v.buffered;
    if (!b.length) return;
    const end = b.end(b.length - 1);
    const inRange = [...Array(b.length).keys()].some((i) => v.currentTime >= b.start(i) && v.currentTime <= b.end(i));
    if (!inRange || end - v.currentTime > 1.5) v.currentTime = Math.max(b.start(b.length - 1), end - 0.25);
    if (v.paused) v.play().catch(() => {});
  }

  const streams = () => (snap?.video && snap.switcher?.reachable ? snap.switcher.echo ?? [] : []);

  function tileFor(inputId) {
    if (inputId == null) return null;
    for (const e of streams()) {
      const t = e.tiles.find((x) => x.inputId === inputId);
      if (!t) continue;
      const p = players.get(`${snap.switcher.id}:${e.index}`);
      if (!p || p.video.readyState < 2 || !p.video.videoWidth) return { e, t, p: null };
      return { e, t, p };
    }
    return null;
  }

  /** The streams the canvases on the page need. */
  function needed() {
    const want = new Set();
    const screens = snap?.switcher?.screens ?? [];
    const add = (layers, deep) => {
      for (const l of layers) {
        if (l.screenRef != null && deep) {
          const s = screens.find((x) => x.id === l.screenRef);
          if (s) add(l.sourceType === 4 ? s.pvw : s.pgm, false);
          continue;
        }
        for (const e of streams()) if (e.tiles.some((t) => t.inputId === l.inputId)) want.add(e.index);
      }
    };
    for (const r of regs) add(r.layers, true);
    return [...want].sort((a, b) => a - b);
  }

  function ask(force) {
    if (!snap?.switcher) {
      for (const p of [...players.values()]) closePlayer(p);
      return;
    }
    const list = needed();
    const key = `${snap.switcher.id}:${list.join(',')}`;
    if (!force && key === asked && Date.now() - askedAt < ASK_MS) return;
    if (!list.length && !asked) return;
    asked = list.length ? key : '';
    askedAt = Date.now();
    rcs.send({ type: 'video', sw: snap.switcher.id, streams: list });
    // Players for streams no longer wanted go.
    for (const p of [...players.values()]) {
      const [sw, idx] = p.key.split(':');
      if (sw !== snap.switcher.id || !list.includes(Number(idx))) closePlayer(p);
    }
  }

  function paintLayers(g, layers, scr, ox, oy, sx, sy, depth) {
    let any = false;
    for (const l of layers) {
      const x = ox + l.x * sx, y = oy + l.y * sy, w = l.w * sx, h = l.h * sy;
      if (w < 1 || h < 1) continue;
      if (l.screenRef != null && depth === 0) {
        const s = (snap.switcher.screens ?? []).find((q) => q.id === l.screenRef);
        if (!s) continue;
        g.save();
        g.beginPath();
        g.rect(x, y, w, h);
        g.clip();
        g.fillStyle = '#000';
        g.fillRect(x, y, w, h);
        const k = Math.min(w / s.width, h / s.height);
        const drew = paintLayers(g, l.sourceType === 4 ? s.pvw : s.pgm, s, x + (w - s.width * k) / 2, y + (h - s.height * k) / 2, k, k, 1);
        g.restore();
        if (drew) {
          tag(g, l.source, x, y, w);
          any = true;
        } else g.clearRect(x, y, w, h);
        continue;
      }
      const f = tileFor(l.inputId);
      if (!f?.p) continue;
      const v = f.p.video;
      const kx = v.videoWidth / f.e.width, ky = v.videoHeight / f.e.height;
      try {
        g.drawImage(v, f.t.x * kx, f.t.y * ky, f.t.w * kx, f.t.h * ky, x, y, w, h);
        any = true;
        if (depth === 0) tag(g, l.source, Math.max(x, 0), Math.max(y, 0), w);
      } catch {}
    }
    return any;
  }

  function tag(g, text, x, y, w) {
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(10 * dpr);
    g.font = `600 ${size}px system-ui, sans-serif`;
    const tw = Math.min(g.measureText(text).width + 8 * dpr, Math.max(0, w));
    if (tw < 12 * dpr) return;
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillRect(x, y, tw, size + 6 * dpr);
    g.fillStyle = '#fff';
    g.save();
    g.beginPath();
    g.rect(x, y, tw, size + 6 * dpr);
    g.clip();
    g.fillText(text, x + 4 * dpr, y + size + 1 * dpr);
    g.restore();
  }

  function frame() {
    for (const p of players.values()) keepLive(p);
    regs = regs.filter((r) => r.el.isConnected);
    for (const r of regs) {
      const dpr = window.devicePixelRatio || 1;
      const box = r.el.getBoundingClientRect();
      const cw = Math.round(box.width * dpr), ch = Math.round(box.height * dpr);
      if (!cw || !ch) continue;
      if (r.cv.width !== cw || r.cv.height !== ch) {
        r.cv.width = cw;
        r.cv.height = ch;
      }
      const g = r.cv.getContext('2d');
      g.clearRect(0, 0, cw, ch);
      g.imageSmoothingQuality = 'low';
      const live = paintLayers(g, r.layers, r.scr, 0, 0, cw / r.scr.width, ch / r.scr.height, 0);
      r.el.classList.toggle('video', live);
    }
    ask(false);
  }

  setInterval(frame, FRAME_MS);

  return {
    onMessage,
    /** A new snapshot: forget the canvases, draw() registers the new ones. */
    setSnapshot(s) {
      snap = s;
      regs = [];
    },
    /** A canvas element just drawn for a screen's layers. */
    register(el, scr, layers) {
      if (!snap?.video) return;
      const cv = document.createElement('canvas');
      cv.className = 'vid';
      cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
      el.append(cv);
      regs.push({ el, cv, scr, layers });
    },
    /** After a draw: ask for what the new canvases need now. */
    drawn() {
      regs = regs.filter((r) => r.el.isConnected);
      ask(false);
    }
  };
};
