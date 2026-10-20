/**
 * Feedback effects: synthesised sound, confetti, toasts and haptics.
 * No audio or image files -- every sound is built with WebAudio on the fly, and
 * confetti is drawn on one fixed canvas. Nothing here touches app state.
 */

const MUTE_KEY = "astra_review_muted";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

let ctx = null;
let master = null;
let muted = read(MUTE_KEY) === "1";

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

/* ---------------------------------------------------------------- sound -- */

// Browsers only allow an AudioContext to start inside a user gesture, so it is
// created lazily by the first sound, which is always triggered by a tap.
function audio() {
  if (muted) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.22;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

/** One enveloped oscillator note. `at` is seconds from now. */
function note(freq, { at = 0, dur = 0.14, type = "sine", gain = 1, glide = 0 } = {}) {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + at;
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glide) osc.frequency.exponentialRampToValueAtTime(freq * glide, t + dur);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(env).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// C major pentatonic, so any run of ticks sounds consonant.
const PENTA = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];

export const sound = {
  /** A score tap: pitch rises with the value, so 0 sounds low and 10 bright. */
  tick(value = 5, max = 10) {
    const i = Math.round((value / max) * (PENTA.length - 1));
    note(PENTA[i] / 2, { dur: 0.07, type: "triangle", gain: 0.5 });
  },
  /** A score cleared. */
  untick() {
    note(330, { dur: 0.08, type: "triangle", gain: 0.35, glide: 0.7 });
  },
  /** A reaction saved. */
  success() {
    note(659.25, { dur: 0.12, type: "sine", gain: 0.7 });
    note(987.77, { at: 0.08, dur: 0.22, type: "sine", gain: 0.6 });
  },
  /** A whole molecule finished. */
  fanfare() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      note(f, { at: i * 0.09, dur: 0.3, type: "triangle", gain: 0.6 }));
    note(1318.5, { at: 0.38, dur: 0.6, type: "sine", gain: 0.45 });
  },
  /** A badge or a leaderboard climb. */
  sparkle() {
    [1318.5, 1567.98, 2093.0].forEach((f, i) =>
      note(f, { at: i * 0.06, dur: 0.16, type: "sine", gain: 0.3 }));
  },
  /** Moving to a different molecule. */
  swoosh() {
    note(220, { dur: 0.25, type: "sine", gain: 0.35, glide: 2.4 });
  },
};

export function isMuted() { return muted; }
export function setMuted(value) {
  muted = !!value;
  write(MUTE_KEY, muted ? "1" : "0");
  if (muted && ctx) ctx.suspend();
}

/** A tiny buzz on phones that support it (Android; iOS ignores it). */
export function haptic(ms = 8) {
  if (navigator.vibrate) try { navigator.vibrate(ms); } catch { /* not allowed */ }
}

/* ------------------------------------------------------------- confetti -- */

let canvas = null;
let pieces = [];
let raf = 0;

const COLORS = ["#6366f1", "#818cf8", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4"];

/** Burst confetti from (x, y) in viewport px; defaults to the top centre. */
export function confetti({ x = innerWidth / 2, y = innerHeight * 0.3, count = 120, spread = 1 } = {}) {
  if (reducedMotion.matches) return;
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "confetti";
    canvas.setAttribute("aria-hidden", "true");
    document.body.append(canvas);
    // A phone rotated mid-burst would otherwise stretch the pieces into streaks.
    addEventListener("resize", sizeCanvas);
  }
  sizeCanvas();

  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * spread;
    const speed = 6 + Math.random() * 9;
    pieces.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 5 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.35,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      life: 0,
    });
  }
  if (!raf) raf = requestAnimationFrame(frame);
}

function sizeCanvas() {
  const dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
}

function frame() {
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, innerWidth, innerHeight);
  pieces = pieces.filter((p) => p.life < 160 && p.y < innerHeight + 40);
  for (const p of pieces) {
    p.life++;
    p.vy += 0.28;            // gravity
    p.vx *= 0.985;           // drag
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    g.save();
    g.globalAlpha = Math.max(0, 1 - p.life / 160);
    g.translate(p.x, p.y);
    g.rotate(p.rot);
    g.fillStyle = p.color;
    g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 2)));
    g.restore();
  }
  raf = pieces.length ? requestAnimationFrame(frame) : 0;
  if (!raf) g.clearRect(0, 0, innerWidth, innerHeight);
}

/* --------------------------------------------------------------- toasts -- */

/**
 * A transient message at the bottom of the screen.
 * kind: "" | "ok" | "err" | "badge"; `icon` is a Font Awesome solid icon name
 * (e.g. "medal" for fa-medal) shown before the text.
 */
export function toast(text, { kind = "", icon = "", ms = 3200 } = {}) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = Object.assign(document.createElement("div"), { id: "toasts" });
    host.setAttribute("aria-live", "polite");
    document.body.append(host);
  }
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  if (icon) {
    const i = Object.assign(document.createElement("i"), { className: `ti fa-solid fa-${icon}` });
    i.setAttribute("aria-hidden", "true");
    t.append(i);
  }
  t.append(Object.assign(document.createElement("span"), { textContent: text }));
  host.append(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => {
    t.classList.remove("in");
    t.addEventListener("transitionend", () => t.remove(), { once: true });
    setTimeout(() => t.remove(), 600);     // in case the transition never fires
  }, ms);
}

/** Restart a CSS animation class on an element (e.g. a number "pop"). */
export function pulse(node, cls = "pop") {
  if (!node || reducedMotion.matches) return;
  node.classList.remove(cls);
  void node.offsetWidth;                  // force reflow so the animation restarts
  node.classList.add(cls);
}

export const motionOK = () => !reducedMotion.matches;
