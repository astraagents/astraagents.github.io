/**
 * ASTRA expert review -- reaction-level scoring.
 *
 * Each reviewer is assigned one molecule at a time (spread across reviewers by
 * js/db.js#assignNetwork) and scores its reactions one card at a time. All
 * database access goes through js/db.js; sound, confetti and toasts through
 * js/fx.js. The whole network can still be opened in the Pathway Explorer,
 * embedded unmodified through explorer.html.
 */

import * as db from "./db.js";
import * as fx from "./fx.js";
import { $, el, icon, setLabel, pretty } from "./dom.js";
import { startAdmin } from "./admin.js";

const SAVE_DEBOUNCE_MS = 600;
const SCORE_MAX = 5;                // scores are 0-5; keep in step with js/db.js
const TARGET_REVIEWERS = 3;         // independent reviews wanted per reaction
const SECONDS_PER_REACTION = 45;    // for the "~N min" estimate only
const BOARD_REFRESH_MS = 60_000;
const BOARD_SHOWN = 8;              // rows before the reviewer's own is appended

// Signing in with this username opens the admin dashboard (js/admin.js) instead
// of the review flow. A UI switch only -- every reviewer already holds the same
// database credentials, so it grants nothing they could not already read.
const ADMIN_USERNAME = "admin_123";

const CREDS_KEY = "astra_review_db";
const USER_KEY = "astra_review_user";
const PASS_KEY = "astra_review_pass";   // the reviewer's password hash, for auto sign-in
const PBKDF2_ITERATIONS = 200_000;

/**
 * What each criterion asks, so every reviewer reads it the same way. `question` is
 * the row's heading and `help` the line under it; `anchors` (one per score) and
 * `note` open behind its (?) button. Adapted from GeminiJudgePrompt.md for a single
 * reaction; Chemical Feasibility and Reaction Justification are merged into
 * Reaction Detail Validity. The keys are what the database stores, and differ from
 * the earlier 0-10 criteria so old scores are never read on the 0-5 scale.
 */
const CRITERION_GUIDE = {
  "Reaction Detail Validity": {
    question: "Are the reaction details chemically valid and justified?",
    help: "Is the step thermodynamically and kinetically plausible as written, balanced, giving the expected product, with a stated reaction type and a rationale backed by literature or flagged as speculative?",
    anchors: [
      ["0", "Thermodynamically forbidden, gives the wrong product, or no coherent reaction is described."],
      ["1", "A major error: unbalanced in a way that changes the chemistry, a missing key reagent, or a rationale that contradicts the reaction."],
      ["2", "Plausible in principle, but a key aspect is doubtful (kinetics at the stated temperature, regio/stereochemical outcome) and the rationale is generic."],
      ["3", "Chemically reasonable, but the rationale is generic and literature support or speculative status is unstated."],
      ["4", "Sound and balanced, with a specific reaction type and rationale and a citation or explicit speculative flag; minor issues only (an optimistic rate, unstated by-products)."],
      ["5", "Sound, balanced and consistent with known reactivity; a specific, internally consistent rationale, with side reactions or selectivity discussed where relevant."],
    ],
    note: "Judges whether the written step and its justification hold up. It is not an arrow-pushing mechanism review; the networks don't contain full mechanisms.",
  },
  "Geochemical Realism": {
    question: "Are the conditions realistic for the stated early-Earth environment?",
    help: "Are the concentrations, catalysts, energy source and reagents consistent with published constraints for that environment?",
    anchors: [
      ["0", "Needs modern lab or biological inputs: O₂, enzymes, or purified modern reagents."],
      ["1", "Key reagents or concentrations are inconsistent with early Earth, e.g. implausibly high concentrations with no concentration mechanism."],
      ["2", "Some conditions are plausible, but key reagents or concentrations are unsupported."],
      ["3", "Generally consistent, but some conditions or concentrations are only weakly argued."],
      ["4", "Consistent with published geochemical constraints; minor assumptions are stated."],
      ["5", "All conditions, catalysts and concentrations are explicitly tied to published constraints for the stated environment."],
    ],
    note: "Not whether this is the origin-of-life scenario. No framework (cyanosulfidic, iron–sulfur, formamide…) or feedstock is privileged; competing scenarios are scored on the same basis.",
  },
  "Reaction Novelty": {
    question: "How novel is this reaction?",
    help: "Does the step go beyond a standard textbook reaction while remaining chemically defensible?",
    anchors: [
      ["0", "A standard textbook reaction."],
      ["1", "A textbook reaction with a minor variation."],
      ["2", "Mostly standard, with one non-obvious element (reagent, intermediate or condition)."],
      ["3", "Several non-obvious elements, each defensible."],
      ["4", "A non-obvious but defensible transformation, intermediate or catalytic strategy."],
      ["5", "A substantially novel yet chemically defensible step."],
    ],
    note: "Novelty that is chemically unsound should not score above 3.",
  },
};
/** Criteria whose scoring guide is expanded; kept open from card to card. */
const openGuides = new Set();

/** `icon` is a Font Awesome solid icon name; `hue` tints it once earned. */
const BADGES = [
  { icon: "vial", hue: 200, name: "First reaction", hint: "Review your first reaction", test: (s) => s.reactions >= 1 },
  { icon: "flask", hue: 160, name: "Warming up", hint: "Review 5 reactions", test: (s) => s.reactions >= 5 },
  { icon: "microscope", hue: 245, name: "Bench chemist", hint: "Review 10 reactions", test: (s) => s.reactions >= 10 },
  { icon: "dna", hue: 290, name: "Molecule done", hint: "Finish a whole molecule", test: (s) => s.molecules >= 1 },
  { icon: "compass", hue: 30, name: "Pathfinder", hint: "Review 25 reactions", test: (s) => s.reactions >= 25 },
  { icon: "pen-to-square", hue: 330, name: "Annotator", hint: "Leave 5 notes", test: (s) => s.notes >= 5 },
  { icon: "diagram-project", hue: 190, name: "Network weaver", hint: "Review 50 reactions", test: (s) => s.reactions >= 50 },
  { icon: "volcano", hue: 12, name: "Hydrothermal", hint: "Finish 3 molecules", test: (s) => s.molecules >= 3 },
  { icon: "earth-americas", hue: 140, name: "Origin hunter", hint: "Review 100 reactions", test: (s) => s.reactions >= 100 },
  { icon: "crown", hue: 45, name: "Full panel", hint: "Finish all 9 molecules", test: (s) => s.molecules >= 9 },
];

/** @type {{criteria:{reaction:string[]}, molecules:string[], networks:any[]}} */
let manifest = null;
let criteria = [];
let username = "";
/** Reviewer's saved work, keyed "<netKey>|reaction|<reactionId>". */
let progress = { scores: {}, comments: {} };
/** { entry, meta, reactions, idx } for the assigned network. */
let current = null;
let board = [];
let myRank = null;
let me = { reactions: 0, molecules: 0, notes: 0 };
let earned = new Set();
let streak = 0;
let boardTimer = null;
let activeSaver = null;            // flushes the open card's pending scores
let busy = false;                  // a network switch is in flight

const cell = (netKey, rid) => `${netKey}|reaction|${rid}`;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

/* ------------------------------------------------------------- sign-in --- */

/**
 * An invite link carries the database credentials in its fragment
 * (#k=<base64url("user:password")>, from tools/make_invite.py). Fragments never
 * reach a server; we keep the credentials in localStorage so a phone reconnects
 * on its own, and strip the fragment from the address bar straight away.
 */
function readInvite() {
  const m = /(?:^#|&)k=([^&]+)/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const text = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const i = text.indexOf(":");
    if (i > 0) store.set(CREDS_KEY, JSON.stringify({ user: text.slice(0, i), password: text.slice(i + 1) }));
  } catch {
    showMsg($("login-msg"), "That invite link looks damaged. Ask for a fresh one.");
  }
}

function storedCreds() {
  try { return JSON.parse(store.get(CREDS_KEY) || "null"); } catch { return null; }
}

function initLogin() {
  readInvite();
  const creds = storedCreds();
  $("invite-ok").hidden = !creds;
  $("db-details").open = !creds;

  const remembered = store.get(USER_KEY);
  if (remembered) $("in-user").value = remembered;
  if (remembered) $("in-pass").focus();
  else $("in-user").focus();

  $("login-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    signIn();
  });

  // Returning reviewer on the same device: straight back in.
  if (remembered && creds && store.get(PASS_KEY)) signIn({ auto: true });
}

async function signIn({ auto = false } = {}) {
  const msg = $("login-msg");
  const btn = $("btn-login");

  // One normalisation, at the door: "Jane_Doe" and "jane_doe" are the same person.
  const name = $("in-user").value.trim().toLowerCase();
  $("in-user").value = name;
  if (!name) return showMsg(msg, "Choose a username to appear on the leaderboard.");
  if (!/^[a-z0-9_.-]{2,32}$/.test(name)) {
    return showMsg(msg, "Use 2–32 letters, digits, dots, dashes or underscores. No spaces.");
  }
  const password = $("in-pass").value;
  if (!auto && password.length < 6) return showMsg(msg, "Enter a password of at least 6 characters.");

  // Typed credentials win only while their section is open, so a stale prefill
  // (js/local-creds.js) can't override the ones an invite link just stored.
  const typed = $("db-details").open;
  const typedUser = typed ? $("in-db-user").value.trim() : "";
  const typedPass = typed ? $("in-db-pass").value : "";
  const creds = typedUser && typedPass ? { user: typedUser, password: typedPass } : storedCreds();
  if (!creds) {
    $("db-details").open = true;
    return showMsg(msg, "Open your invite link, or enter the database credentials.");
  }

  msg.hidden = true;
  btn.disabled = true;
  btn.textContent = "Connecting…";

  try {
    await db.connect(creds);
    store.set(CREDS_KEY, JSON.stringify(creds));   // kept even if the password is wrong
    store.set(PASS_KEY, await checkPassword(name, auto ? null : password));
    username = name;
    store.set(USER_KEY, name);
    $("in-pass").value = "";

    if (!manifest) manifest = await fetchJSON("data/review_index.json");
    criteria = manifest.criteria.reaction;

    $("login").hidden = true;
    $("app").hidden = false;
    $("who-name").textContent = username;
    paintAvatar($("who-avatar"), username);

    if (username === ADMIN_USERNAME) {
      if (!wired) wireChrome();
      wired = true;
      await startAdmin({ manifest, username, targetReviewers: TARGET_REVIEWERS });
      return;
    }
    progress = await db.loadProgress(username);
    await startApp();
  } catch (err) {
    if (auto) store.del(PASS_KEY);
    $("login").hidden = false;
    $("app").hidden = true;
    showMsg(msg, auto ? "Please enter your password to sign in again." : err.message);
  } finally {
    btn.disabled = false;
    setLabel(btn, "Start reviewing", "arrow-right");
  }
}

/**
 * Check `password` against the username's account, creating the account if it has
 * none yet, and return the hash to remember on this device. With no password
 * (auto sign-in), the hash remembered from last time is checked instead.
 */
async function checkPassword(name, password) {
  let account = await db.getAccount(name);
  if (!account && password != null) {
    const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await hashPassword(password, salt);
    if (await db.createAccount(name, salt, hash)) return hash;
    account = await db.getAccount(name);   // claimed by someone else a moment ago
  }
  const hash = password == null ? store.get(PASS_KEY) : await hashPassword(password, account?.salt);
  if (!account || hash !== account.hash) {
    await db.disconnect();
    throw new Error("Wrong password for this username. If it isn't yours, choose another one.");
  }
  return hash;
}

/** PBKDF2-SHA256 of the password, as hex. Only the salt and this hash are stored. */
async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITERATIONS },
    key, 256
  );
  return toHex(new Uint8Array(bits));
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status}).`);
  return res.json();
}

function showMsg(node, text, kind = "") {
  node.textContent = text;
  node.className = `notice ${kind}`;
  node.hidden = false;
}

/* ----------------------------------------------------------- app start --- */

let wired = false;

async function startApp() {
  if (!wired) wireChrome();
  wired = true;

  await refreshBoard();
  earned = new Set(BADGES.filter((b) => b.test(me)).map((b) => b.name));
  renderBadges();

  clearInterval(boardTimer);
  boardTimer = setInterval(() => refreshBoard({ announce: true }).catch(() => {}), BOARD_REFRESH_MS);

  const mine = await db.myAssignments(username);
  const keyOf = (r) => [r.model, r.molecule, r.config, r.run, r.attempt].join("|");
  const activeKey = mine.filter((r) => r.status === "active").map(keyOf)[0];
  const entry = manifest.networks.find((n) => n.key === activeKey)
    || await db.assignNetwork(username, manifest.networks);

  if (!entry) return allDoneView();
  await openNetwork(entry, { intro: true });
}

function wireChrome() {
  $("btn-logout").addEventListener("click", askLogout);
  $("leave-yes").addEventListener("click", logout);
  $("leave-no").addEventListener("click", () => { $("leave-sheet").hidden = true; });

  const sound = $("btn-sound");
  const paintSound = () => {
    sound.replaceChildren(icon(fx.isMuted() ? "volume-xmark" : "volume-high"));
    sound.setAttribute("aria-pressed", String(!fx.isMuted()));
  };
  paintSound();
  sound.addEventListener("click", () => {
    fx.setMuted(!fx.isMuted());
    paintSound();
    fx.sound.tick(8);
  });

  $("btn-rail").addEventListener("click", () => setRail(!document.body.classList.contains("rail-open")));
  $("rail-backdrop").addEventListener("click", () => setRail(false));

  $("sheet-close").addEventListener("click", closeSheet);
  $("net-sheet").addEventListener("click", (ev) => { if (ev.target === $("net-sheet")) closeSheet(); });
  $("leave-sheet").addEventListener("click", (ev) => {
    if (ev.target === $("leave-sheet")) $("leave-sheet").hidden = true;
  });

  document.addEventListener("keydown", onKeydown);
}

function setRail(open) {
  document.body.classList.toggle("rail-open", open);
  $("rail-backdrop").hidden = !open;
  $("btn-rail").setAttribute("aria-expanded", String(open));
}

function onKeydown(ev) {
  if (ev.key === "Escape") {
    if (!$("net-sheet").hidden) return closeSheet();
    if (!$("leave-sheet").hidden) { $("leave-sheet").hidden = true; return; }
    return setRail(false);
  }
  const typing = /^(TEXTAREA|INPUT|SELECT|SUMMARY)$/.test(document.activeElement?.tagName);
  if (typing || !$("net-sheet").hidden || !current?.reactions) return;
  if (!document.querySelector(".rxn-view")) return;

  if (ev.key === "Enter") {
    // Enter on a focused pill would otherwise "click" it and clear its score.
    if (document.activeElement?.classList.contains("pill")) ev.preventDefault();
    const btn = $("btn-next");
    if (btn && !btn.disabled) { ev.preventDefault(); btn.click(); }
  } else if (ev.key === "ArrowRight" && current.idx < current.reactions.length - 1) {
    goTo(current.idx + 1, 1);
  } else if (ev.key === "ArrowLeft" && current.idx > 0) {
    goTo(current.idx - 1, -1);
  }
}

/* ------------------------------------------------------------ networks --- */

function metaOf(entry) {
  return {
    reviewerName: username,
    model: entry.model,
    molecule: entry.molecule,
    config: entry.config,
    run: entry.run,
    attempt: entry.attempt ?? "",
  };
}

async function openNetwork(entry, { intro = false } = {}) {
  const meta = metaOf(entry);
  const reactions = await db.loadReactions(meta);
  current = { entry, meta, reactions, idx: 0 };

  if (!reactions.length) {
    return stage(el("section", { className: "card view" }, [
      el("h2", { textContent: "Nothing to review yet" }),
      el("p", {
        className: "muted",
        textContent: `The reactions for ${pretty(entry.molecule)} are not in the database. ` +
          "Run expert_review/tools/seed_reactions.py, then reload.",
      }),
    ]));
  }
  if (intro || doneCount() === reactions.length) introView();
  else reactionView(nextUnscored(-1) ?? 0);
}

const isComplete = (rid) => {
  const s = progress.scores[cell(current.entry.key, rid)] || {};
  return criteria.every((c) => Object.prototype.hasOwnProperty.call(s, c));
};
const scoredCriteria = (rid) => {
  const s = progress.scores[cell(current.entry.key, rid)] || {};
  return criteria.filter((c) => Object.prototype.hasOwnProperty.call(s, c)).length;
};
const doneCount = () => current.reactions.filter((r) => isComplete(r.id)).length;

/** The first reaction after `from` (wrapping) that is not fully scored, or null. */
function nextUnscored(from, { skip = null } = {}) {
  const n = current.reactions.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from + step) % n) + n) % n;
    if (i !== skip && !isComplete(current.reactions[i].id)) return i;
  }
  return null;
}

async function swapMolecule() {
  if (busy) return;
  busy = true;
  try {
    await activeSaver?.flush();
    fx.sound.swoosh();
    const pick = await db.assignNetwork(username, manifest.networks, { exclude: current.entry.key });
    if (!pick) return allDoneView();
    if (pick.key === current.entry.key) {
      fx.toast("That's the only molecule left for you. Nearly there!", { icon: "flag-checkered" });
    }
    await openNetwork(pick, { intro: true });
  } catch (err) {
    fx.toast(err.message, { kind: "err" });
  } finally {
    busy = false;
  }
}

async function nextMolecule() {
  if (busy) return;
  busy = true;
  try {
    const pick = await db.assignNetwork(username, manifest.networks, { exclude: current.entry.key });
    if (!pick || pick.key === current.entry.key) return allDoneView();
    fx.sound.swoosh();
    await openNetwork(pick, { intro: true });
  } catch (err) {
    fx.toast(err.message, { kind: "err" });
  } finally {
    busy = false;
  }
}

/* --------------------------------------------------------------- views --- */

/** Swap the main stage content, with an entrance animation. */
function stage(view, dir = 0) {
  setRail(false);
  view.classList.add("view", dir > 0 ? "enter-r" : dir < 0 ? "enter-l" : "enter-up");
  $("stage").replaceChildren(view);
  scrollTo({ top: 0, behavior: fx.motionOK() ? "smooth" : "auto" });
}

function introView() {
  activeSaver = null;
  const { entry, reactions } = current;
  const n = reactions.length;
  const done = doneCount();
  const left = n - done;
  const mins = Math.max(1, Math.round((left * SECONDS_PER_REACTION) / 60));

  const ring = progressRing(done / n, `${done}/${n}`);
  const start = el("button", { className: "btn primary big", type: "button" });
  setLabel(start, done === n ? "Next molecule" : done ? `Continue · ${left} to go` : "Start reviewing", "arrow-right");
  start.addEventListener("click", () => {
    fx.sound.tick(10);
    if (done === n) return nextMolecule();
    reactionView(nextUnscored(-1) ?? 0, 1);
  });

  const swap = el("button", {
    className: "btn ghost", type: "button",
    textContent: done === n ? "Review my scores" : "Not my area? Swap molecule",
  });
  swap.addEventListener("click", () => (done === n ? reactionView(0, 1) : swapMolecule()));

  // Every reaction scored but never marked done (e.g. the tab closed first).
  if (done === n) db.setAssignmentStatus(username, current.meta, "done").catch(() => {});

  const view = el("section", { className: "card intro" }, [
    el("div", { className: "intro-art", ariaHidden: "true" }, [el("i"), el("i"), el("i"), el("b")]),
    el("p", { className: "eyebrow", textContent: done ? "Welcome back, your molecule" : "Your assignment" }),
    el("h1", { className: "intro-title", textContent: pretty(entry.molecule) }),
    el("p", {
      className: "muted",
      textContent: done && done < n
        ? `You're ${Math.round((done / n) * 100)}% through. Just ${left} reaction${left === 1 ? "" : "s"} left to finish ${pretty(entry.molecule)}.`
        : `A proposed prebiotic synthesis network for ${pretty(entry.molecule)}. ` +
          `Score each reaction on ${criteria.length} criteria. Your scores save as you tap.`,
    }),
    el("div", { className: "intro-stats" }, [
      ring,
      el("div", {}, [el("b", { textContent: String(n) }), el("span", { textContent: "reactions" })]),
      el("div", {}, [el("b", { textContent: done === n ? "0" : `~${mins}` }), el("span", { textContent: "minutes left" })]),
    ]),
    el("div", { className: "intro-actions" }, [start, swap]),
    el("p", {
      className: "tiny dim",
      textContent: "Molecules are shared out across reviewers so every network gets independent expert eyes.",
    }),
  ]);
  stage(view);
}

function progressRing(frac, label) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("class", "ring");
  svg.innerHTML =
    `<circle cx="32" cy="32" r="${r}" class="ring-bg"/>` +
    `<circle cx="32" cy="32" r="${r}" class="ring-fg" stroke-dasharray="${c}" stroke-dashoffset="${c}"/>`;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    svg.querySelector(".ring-fg").style.strokeDashoffset = String(c * (1 - frac));
  }));
  return el("div", { className: "ringwrap" }, [svg, el("span", { textContent: label })]);
}

/* ------------------------------------------------------------ reaction --- */

function goTo(i, dir) {
  activeSaver?.flush();
  reactionView(i, dir);
}

function reactionView(i, dir = 0) {
  current.idx = i;
  const rxn = current.reactions[i];
  const n = current.reactions.length;
  const key = cell(current.entry.key, rxn.id);
  const wasComplete = isComplete(rxn.id);

  /* --- header: where am I --- */
  const segs = el("nav", { className: "segs", ariaLabel: "Reactions" });
  current.reactions.forEach((r, j) => {
    const s = el("button", {
      type: "button", className: "seg", title: `Reaction ${j + 1}: ${r.name}`,
    });
    s.setAttribute("aria-label", `Reaction ${j + 1}`);
    if (isComplete(r.id)) s.classList.add("done");
    else if (scoredCriteria(r.id)) s.classList.add("part");
    if (j === i) s.setAttribute("aria-current", "step");
    s.addEventListener("click", () => { if (j !== current.idx) goTo(j, j > current.idx ? 1 : -1); });
    segs.append(s);
  });

  const done = doneCount();
  const swap = el("button", { className: "btn ghost small", type: "button" }, [icon("shuffle"), " Swap molecule"]);
  swap.addEventListener("click", swapMolecule);

  const head = el("div", { className: "rxn-head" }, [
    el("div", { className: "rxn-head-row" }, [
      el("span", { className: "chip mol", textContent: pretty(current.entry.molecule) }),
      el("span", { className: "rxn-count", innerHTML: `Reaction <b>${i + 1}</b> of ${n}` }),
      el("span", { className: "spacer" }),
      el("span", { className: "tiny dim", id: "done-count", textContent: `${done} done · ${n - done} to go` }),
      swap,
    ]),
    segs,
  ]);

  /* --- the scoring form --- */
  const { card: scoreCard, saver } = scoreForm(rxn, key);
  activeSaver = saver;

  /* --- actions --- */
  const skip = el("button", { className: "btn ghost", type: "button", textContent: "Skip for now" });
  const next = el("button", { className: "btn primary big", type: "button", id: "btn-next" });
  const paintNext = () => {
    const have = criteria.filter((c) => saver.sel[c] != null).length;
    next.disabled = have < criteria.length;
    if (have < criteria.length) setLabel(next, `Score all (${have}/${criteria.length})`);
    else setLabel(next, "Save & next", wasComplete ? "arrow-right" : "check");
  };
  saver.onChange = paintNext;
  paintNext();

  skip.addEventListener("click", () => {
    const j = nextUnscored(i, { skip: i });
    if (j == null) return fx.toast("This is the last reaction left. You can do it!", { icon: "hand-fist" });
    goTo(j, 1);
  });
  next.addEventListener("click", () => saveAndNext(rxn, saver, wasComplete, next));

  const view = el("div", { className: "rxn-view" }, [
    head,
    reactionCard(rxn),
    scoreCard,
    el("div", { className: "actionbar" }, [skip, next]),
  ]);
  stage(view, dir);

  const ahead = nextUnscored(i, { skip: i });
  if (ahead != null) preloadStructures(current.reactions[ahead]);
}

async function saveAndNext(rxn, saver, wasComplete, btn) {
  btn.disabled = true;
  try {
    await saver.flush();
  } catch {
    btn.disabled = false;
    return;                         // the saver already reported the error
  }

  const newlyDone = !wasComplete && isComplete(rxn.id);
  if (newlyDone) {
    streak++;
    me.reactions++;
    fx.sound.success();
    fx.haptic(18);
    const r = btn.getBoundingClientRect();
    fx.confetti({ x: r.left + r.width / 2, y: r.top, count: 28, spread: 0.55 });
    floatPlusOne(btn);
    paintStreak();
    paintStats();
    checkBadges();
    refreshBoard({ announce: true }).catch(() => {});
    db.setAssignmentStatus(username, current.meta, "active").catch(() => {});   // keep it fresh
  }

  // Revisiting a finished molecule just pages through it; the celebration
  // happens once, on the save that completes it.
  let j = nextUnscored(current.idx);
  if (j == null && !newlyDone) {
    j = current.idx + 1 < current.reactions.length ? current.idx + 1 : null;
    if (j == null) return finishMolecule({ celebrate: false });
  }
  if (j == null) return finishMolecule({ celebrate: true });

  const view = document.querySelector(".rxn-view");
  if (view && fx.motionOK()) {
    view.classList.add("fly-out");
    setTimeout(() => reactionView(j, 1), 220);
  } else {
    reactionView(j, 1);
  }
}

function floatPlusOne(anchor) {
  if (!fx.motionOK()) return;
  const r = anchor.getBoundingClientRect();
  const n = el("div", { className: "plus-one", textContent: "+1" });
  n.style.left = `${r.left + r.width / 2}px`;
  n.style.top = `${r.top}px`;
  document.body.append(n);
  setTimeout(() => n.remove(), 1000);
}

/** The reaction itself: equation, setting, conditions, mechanism, reasoning. */
function reactionCard(rxn) {
  const card = el("section", { className: "card rxn" });
  const view = el("button", { className: "btn ghost small netbtn", type: "button" },
    [icon("diagram-project"), " View in network"]);
  view.addEventListener("click", () => openSheet(rxn));
  card.append(el("div", { className: "rxn-title-row" }, [
    el("h2", { className: "rxn-name", textContent: rxn.name }),
    view,
  ]));

  const side = (mols) => el("div", { className: "eq-side" },
    (mols || []).flatMap((m, k) => [k ? el("span", { className: "eq-plus", ariaHidden: "true", textContent: "+" }) : null, molCard(m)]));
  card.append(el("div", { className: "eq" }, [
    side(rxn.inputs),
    el("span", { className: "eq-arrow" }, [icon("arrow-right-long")]),
    side(rxn.outputs),
  ]));

  // Short conditions as key/value chips; anything longer goes to the list below.
  const tags = el("div", { className: "tags", ariaLabel: "Reaction conditions" });
  tags.setAttribute("role", "list");
  const tag = (cls, iconName, k, v) => {
    const t = el("span", { className: `chip ${cls}` }, [
      iconName ? icon(iconName) : null,
      el("span", { className: "k", textContent: k }),
      el("span", { className: "v", textContent: v }),
    ]);
    t.setAttribute("role", "listitem");
    return t;
  };
  if (rxn.environment) {
    const env = tag("env", "location-dot", "Setting", String(rxn.environment));
    env.style.setProperty("--h", String(hue(String(rxn.environment))));
    tags.append(env);
  }
  const long = [];
  const cond = rxn.conditions;
  if (cond && typeof cond === "object" && !Array.isArray(cond)) {
    for (const [k, v] of Object.entries(cond)) {
      if (isEmpty(v)) continue;
      const phase = k === "aqueous" && typeof v === "boolean";
      const text = phase ? (v ? "aqueous" : "dry / gas phase") : scalar(v);
      const name = phase ? "Phase" : /^ph$/i.test(k) ? "pH" : k === "other" ? "Notes" : label(k);
      if (text.length <= 34 && k !== "other") tags.append(tag("cond", CONDITION_ICON[k], name, text));
      else long.push([name, text]);
    }
  } else if (!isEmpty(cond)) {
    long.push(["Conditions", scalar(cond)]);
  }
  if (tags.childNodes.length) card.append(tags);

  if (!isEmpty(rxn.agents)) {
    card.append(el("div", { className: "agents" }, [
      el("span", { className: "lbl", textContent: "Agents" }),
      ...[].concat(rxn.agents).filter((a) => !isEmpty(a)).map((a) => el("span", { className: "chip agent", textContent: scalar(a) })),
    ]));
  }
  if (long.length) {
    card.append(el("dl", { className: "kv" }, long.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })])));
  }

  const fold = (title, body, open = true) => {
    const d = el("details", { className: "fold", open }, [el("summary", { textContent: title }), el("p", { textContent: body })]);
    return d;
  };
  if (!isEmpty(rxn.mechanism)) card.append(fold("Mechanism", scalar(rxn.mechanism)));
  if (!isEmpty(rxn.reasoning)) card.append(fold("Scientific reasoning", scalar(rxn.reasoning)));

  // Any other fields this network's schema carries (e.g. description, catalyst).
  for (const [k, v] of Object.entries(rxn)) {
    if (KNOWN_FIELDS.has(k) || isEmpty(v)) continue;
    card.append(fold(label(k), scalar(v), false));
  }
  return card;
}

/**
 * One molecule: its 2D structure from PubChem (by CID, resolved offline by
 * tools/resolve_pubchem.py), name and formula. Molecules PubChem does not know
 * get a formula tile instead. When the structure's formula disagrees with the
 * network's own, the card says so -- that inconsistency is itself worth a
 * reviewer's attention.
 */
function molCard(m) {
  const fig = el("figure", { className: `mol-card role-${m.role || "x"}` });
  const roleNote = m.role ? ` (${m.role.replace(/_/g, " ")})` : "";

  let tile;
  if (m.cid) {
    tile = el("a", {
      className: "mol-img loading", href: `https://pubchem.ncbi.nlm.nih.gov/compound/${m.cid}`,
      target: "_blank", rel: "noopener", title: `Open ${m.name} on PubChem`,
    });
    loadStructure(m.cid).then((s) => {
      tile.classList.remove("loading");
      if (!s?.url) return tile.replaceChildren(formulaTile(m, s?.blank ? "" : "image unavailable"));
      const img = el("img", { src: s.url, alt: `2D structure of ${m.name}`, decoding: "async" });
      // Cap the zoom so NH3 still looks small next to arginine, as in any textbook.
      img.style.maxWidth = `${s.w * MAX_ZOOM}px`;
      img.style.maxHeight = `${s.h * MAX_ZOOM}px`;
      tile.replaceChildren(img);
    });
  } else {
    tile = el("div", { className: "mol-img none", title: "Not found in PubChem" }, [formulaTile(m, "not in PubChem")]);
  }

  fig.append(tile, el("figcaption", { title: m.name + roleNote }, [
    el("b", { textContent: m.name }),
    m.formula && m.formula !== m.name ? formulaNode(m.formula) : null,
    m.cid && m.cid_match === false
      ? el("span", {
        className: "mol-warn",
        title: `The network states ${m.formula}, but its structure resolves in PubChem to ${m.pubchem_formula}.`,
      }, [icon("triangle-exclamation"), ` PubChem: ${m.pubchem_formula}`])
      : null,
  ]));
  return fig;
}

function formulaTile(m, note) {
  return el("span", { className: "mol-noimg" }, [
    m.formula ? formulaNode(m.formula) : el("span", { textContent: "?" }),
    note ? el("small", { textContent: note }) : null,
  ]);
}

/* ------------------------------------------------------ PubChem images -- */

const STRUCTURE_PX = 500;           // fetched size; drawings scale with the canvas
const INK_BOOST = 1.9;              // darkening applied to PubChem's thin strokes
const MAX_ZOOM = 0.7;               // tile px per source px, so tiny molecules stay modest
const structureUrl = (cid) =>
  `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/PNG?record_type=2d&image_size=${STRUCTURE_PX}x${STRUCTURE_PX}`;

/** cid -> Promise<{url, w, h} | {blank: true} | null>, one fetch per compound. */
const structures = new Map();

// PubChem allows ~5 requests/second; a card plus its preloaded successor can
// ask for a dozen at once, so keep a few in flight at a time.
const fetchQueue = [];
let fetching = 0;
function throttle(job) {
  return new Promise((resolve) => {
    fetchQueue.push(() => job().then(resolve));
    pump();
  });
}
function pump() {
  while (fetching < 4 && fetchQueue.length) {
    fetching++;
    fetchQueue.shift()().finally(() => { fetching--; setTimeout(pump, 200); });
  }
}

function loadStructure(cid) {
  if (!structures.has(cid)) {
    structures.set(cid, throttle(() => new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";          // PubChem sends ACAO: *, so the canvas stays readable
      img.onload = () => {
        try { resolve(trimStructure(img)); } catch { resolve({ url: img.src, w: STRUCTURE_PX, h: STRUCTURE_PX }); }
      };
      img.onerror = () => { structures.delete(cid); resolve(null); };   // let a later card retry
      img.src = structureUrl(cid);
    })));
  }
  return structures.get(cid);
}

/**
 * PubChem pads every drawing to the full canvas on a #f5f5f5 background, which
 * leaves small molecules as a speck. Crop to the drawn pixels and lift the grey
 * to white. Some compounds (H2: implicit hydrogens) render as an empty canvas,
 * reported as blank so the card falls back to the formula.
 */
function trimStructure(img) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, w, h);
  const px = data.data;
  const bg = [px[0], px[1], px[2]];

  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]);
      if (d > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      // Levels: background grey -> white, then deepen the ink. PubChem draws
      // 1px bonds, which turn faint once the drawing is scaled into a tile.
      for (let k = 0; k < 3; k++) {
        const v = Math.min(255, (px[i + k] * 255) / Math.max(1, bg[k]));
        px[i + k] = Math.max(0, 255 - (255 - v) * INK_BOOST);
      }
    }
  }
  if (x1 < 0) return { blank: true };

  g.putImageData(data, 0, 0);
  const pad = 14;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d").drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return { url: out.toDataURL("image/png"), w: out.width, h: out.height };
}

/** Warm the cache with the next card's structures, so it appears complete. */
function preloadStructures(rxn) {
  for (const m of [...(rxn?.inputs || []), ...(rxn?.outputs || [])]) {
    if (m.cid) loadStructure(m.cid);
  }
}

const KNOWN_FIELDS = new Set(["id", "name", "position", "inputs", "outputs", "environment",
  "agents", "conditions", "mechanism", "reasoning"]);
/** Font Awesome icons for common condition keys; others are labelled in words. */
const CONDITION_ICON = { temperature: "temperature-half", pressure: "gauge-high", aqueous: "droplet",
  catalyst: "flask", uv: "sun", time: "clock" };

function isEmpty(v) {
  if (v == null || v === "") return true;
  if (Array.isArray(v)) return v.every(isEmpty);
  if (typeof v === "object") return Object.keys(v).every((k) => isEmpty(v[k]));
  return false;
}
function scalar(v) {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.filter((x) => !isEmpty(x)).map(scalar).join(", ");
  if (v && typeof v === "object") {
    return Object.entries(v).filter(([, x]) => !isEmpty(x)).map(([k, x]) => `${k}: ${scalar(x)}`).join("; ");
  }
  return String(v);
}
function label(key) {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** "C2H5NO2" with digits after an element or bracket set as subscripts. */
function formulaNode(formula) {
  const span = el("span", { className: "formula" });
  for (const part of String(formula).split(/(\d+)/)) {
    if (!part) continue;
    if (/^\d+$/.test(part) && /[A-Za-z)\]]$/.test(span.textContent)) span.append(el("sub", { textContent: part }));
    else span.append(part);
  }
  return span;
}

/* -------------------------------------------------------------- scoring -- */

/**
 * One row of 0-5 tap pills per criterion, plus an optional note. Every tap autosaves after a
 * short debounce; tapping the selected pill again clears that score (the row is
 * deleted, never stored as a zero). Returns the card and its saver, whose
 * flush() resolves once everything pending is in the database.
 */
function scoreForm(rxn, key) {
  const meta = current.meta;       // pinned: a save must land on the network it was made for
  const saved = progress.scores[key] || {};
  const saver = makeSaver(meta, rxn.id, key);
  for (const c of criteria) saver.sel[c] = Object.prototype.hasOwnProperty.call(saved, c) ? saved[c] : null;

  const card = el("section", { className: "card scorecard" });
  card.append(el("div", { className: "score-h" }, [
    el("h3", { textContent: "Your scores" }),
    el("span", { className: "scale tiny dim", innerHTML: "<b>0</b> poor · <b>5</b> excellent" }),
  ]));

  for (const criterion of criteria) {
    const row = el("div", { className: "crit" });
    const value = el("span", { className: "crit-val" });
    const pills = el("div", { className: "pills", role: "radiogroup", ariaLabel: CRITERION_GUIDE[criterion]?.question || criterion });

    const paint = () => {
      const v = saver.sel[criterion];
      row.classList.toggle("set", v != null);
      value.textContent = v == null ? "–" : String(v);
      if (v != null) row.style.setProperty("--c", scoreColor(v));
      for (const p of pills.children) {
        const on = Number(p.dataset.v) === v;
        p.setAttribute("aria-checked", String(on));
        p.tabIndex = on || (v == null && p.dataset.v === "0") ? 0 : -1;
      }
    };

    for (let v = 0; v <= SCORE_MAX; v++) {
      const p = el("button", { type: "button", className: "pill", textContent: String(v) });
      p.dataset.v = String(v);
      p.setAttribute("role", "radio");
      p.style.setProperty("--c", scoreColor(v));
      p.addEventListener("click", () => {
        const clear = saver.sel[criterion] === v;
        saver.set(criterion, clear ? null : v);
        if (clear) fx.sound.untick(); else fx.sound.tick(v, SCORE_MAX);
        fx.haptic();
        paint();
        if (!clear) fx.pulse(value);
      });
      p.addEventListener("keydown", (ev) => {
        const d = ev.key === "ArrowRight" || ev.key === "ArrowUp" ? 1
          : ev.key === "ArrowLeft" || ev.key === "ArrowDown" ? -1 : 0;
        if (!d) return;
        ev.preventDefault();
        ev.stopPropagation();
        const t = pills.children[Math.min(SCORE_MAX, Math.max(0, v + d))];
        t.focus();
        t.click();
      });
      pills.append(p);
    }

    const guide = CRITERION_GUIDE[criterion];
    let tip = null, more = null;
    if (guide) {
      const id = `guide-${criteria.indexOf(criterion)}`;
      more = el("div", { className: "crit-guide", id, hidden: !openGuides.has(criterion) }, [
        el("dl", {}, guide.anchors.flatMap(([band, text]) => [
          el("dt", { textContent: band }),
          el("dd", { textContent: text }),
        ])),
        guide.note ? el("p", { className: "crit-guide-note", textContent: guide.note }) : null,
      ]);
      tip = el("button", { type: "button", className: "crit-tip", title: "How to score this" }, [icon("circle-question")]);
      tip.setAttribute("aria-label", `How to score ${criterion}`);
      tip.setAttribute("aria-controls", id);
      tip.setAttribute("aria-expanded", String(!more.hidden));
      tip.addEventListener("click", () => {
        more.hidden = !more.hidden;
        tip.setAttribute("aria-expanded", String(!more.hidden));
        if (more.hidden) openGuides.delete(criterion); else openGuides.add(criterion);
      });
    }

    row.append(
      el("div", { className: "crit-h" }, [
        el("span", { className: "crit-name" }, [guide?.question || criterion, tip]),
        value,
      ]),
      el("p", { className: "crit-help", textContent: guide?.help || "" }),
      more,
      pills
    );
    paint();
    card.append(row);
  }

  /* --- optional note --- */
  const note = progress.comments[key] || "";
  const ta = el("textarea", {
    rows: 3, value: note, id: "rxn-note",
    placeholder: "What's wrong, missing, or especially good? A reference helps.",
  });
  const noteBox = el("details", { className: "note", open: !!note }, [
    el("summary", { textContent: note ? "Your note" : "Add a note (optional)" }),
    ta,
  ]);
  let timer = null;
  ta.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => saveNote(meta, rxn.id, key, ta.value, saver), SAVE_DEBOUNCE_MS);
  });
  saver.flushNote = () => {
    if (!timer) return Promise.resolve();
    clearTimeout(timer);
    timer = null;
    return saveNote(meta, rxn.id, key, ta.value, saver);
  };
  card.append(noteBox, saver.status);

  return { card, saver };
}

async function saveNote(meta, rid, key, text, saver) {
  const had = !!progress.comments[key];
  try {
    await db.saveComment(meta, "reaction", rid, text);
    const body = text.trim();
    if (body) progress.comments[key] = body;
    else delete progress.comments[key];
    if (!had && body) { me.notes++; paintStats(); checkBadges(); }
    if (had && !body) { me.notes = Math.max(0, me.notes - 1); paintStats(); }
    saver.say("Note saved", "ok");
  } catch (err) {
    saver.say(err.message, "err");
    fx.toast(err.message, { kind: "err" });
  }
}

/** Debounced, serialised score saving for one reaction card. */
function makeSaver(meta, rid, key) {
  let pending = {};
  let timer = null;
  let chain = Promise.resolve();
  const status = el("div", { className: "saving", ariaLive: "polite" });

  const saver = {
    sel: {},
    status,
    onChange: null,
    flushNote: null,
    say(text, kind = "") {
      const mark = { ok: "check", err: "triangle-exclamation" }[kind];
      status.replaceChildren(...(mark ? [icon(mark), " "] : []), text);
      status.className = `saving ${kind}`;
    },
    set(criterion, value) {
      saver.sel[criterion] = value;
      pending[criterion] = value;
      saver.onChange?.();
      clearTimeout(timer);
      timer = setTimeout(() => saver.flush().catch(() => {}), SAVE_DEBOUNCE_MS);
    },
    /** Resolves when every pending score (and the note) is saved; rejects on failure. */
    flush() {
      clearTimeout(timer);
      const batch = pending;
      pending = {};
      const note = saver.flushNote ? saver.flushNote() : Promise.resolve();
      if (!Object.keys(batch).length) return Promise.all([chain, note]).then(() => {});

      saver.say("Saving…");
      chain = chain.catch(() => {}).then(async () => {
        try {
          await db.saveScores(meta, "reaction", rid, batch);
        } catch (err) {
          // Put the batch back under anything newer, so a retry sends it.
          pending = { ...batch, ...pending };
          saver.say(err.message, "err");
          fx.toast("Couldn't save. Check your connection and try again.", { kind: "err", icon: "triangle-exclamation" });
          throw err;
        }
        const s = (progress.scores[key] ||= {});
        for (const [c, v] of Object.entries(batch)) {
          if (v == null) delete s[c];
          else s[c] = v;
        }
        saver.say("Saved", "ok");
        repaintSegments();
      });
      return Promise.all([chain, note]).then(() => {});
    },
  };
  return saver;
}

function repaintSegments() {
  const segs = document.querySelectorAll(".segs .seg");
  current.reactions.forEach((r, j) => {
    const s = segs[j];
    if (!s) return;
    s.classList.toggle("done", isComplete(r.id));
    s.classList.toggle("part", !isComplete(r.id) && scoredCriteria(r.id) > 0);
  });
  const d = $("done-count");
  if (d) d.textContent = `${doneCount()} done · ${current.reactions.length - doneCount()} to go`;
}

/** 0 = red through amber to SCORE_MAX = green. */
function scoreColor(v) {
  return `hsl(${Math.round((v / SCORE_MAX) * 125)} 72% 44%)`;
}

/* ------------------------------------------------------- finish / done --- */

async function finishMolecule({ celebrate = true } = {}) {
  activeSaver = null;
  const { entry, meta, reactions } = current;
  if (celebrate) {
    try {
      await db.setAssignmentStatus(username, meta, "done");
    } catch (err) {
      fx.toast(err.message, { kind: "err" });
    }
    me.molecules++;
    paintStats();
    fx.sound.fanfare();
    fx.haptic(40);
    fx.confetti({ count: 180, spread: 1.1 });
    setTimeout(() => fx.confetti({ x: innerWidth * 0.2, y: innerHeight * 0.5, count: 60, spread: 0.6 }), 250);
    setTimeout(() => fx.confetti({ x: innerWidth * 0.8, y: innerHeight * 0.5, count: 60, spread: 0.6 }), 450);
    checkBadges();
    refreshBoard({ announce: true }).catch(() => {});
  }

  // Your mean per criterion over this network, next to the rest of the panel's.
  const mine = Object.fromEntries(criteria.map((c) => {
    const vals = reactions.map((r) => progress.scores[cell(entry.key, r.id)]?.[c]).filter((v) => v != null);
    return [c, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null];
  }));
  let panel = {};
  try { panel = await db.panelAverages(meta, username); } catch { /* the comparison is a bonus */ }
  const others = Math.max(0, ...Object.values(panel).map((p) => p.reviewers));

  const rows = criteria.map((c) => {
    const you = mine[c];
    const them = panel[c]?.mean;
    return el("div", { className: "cmp-row" }, [
      el("span", { className: "cmp-name", textContent: c }),
      el("div", { className: "cmp-bars" }, [
        bar("you", you),
        them != null ? bar("panel", them) : null,
      ]),
    ]);
  });

  const next = el("button", { className: "btn primary big", type: "button" });
  setLabel(next, "Next molecule", "arrow-right");
  next.addEventListener("click", nextMolecule);
  const revisit = el("button", { className: "btn ghost", type: "button", textContent: "Revisit my scores" });
  revisit.addEventListener("click", () => reactionView(0, -1));

  stage(el("section", { className: "card finish" }, [
    el("div", { className: "trophy" }, [icon("trophy")]),
    el("p", { className: "eyebrow", textContent: "Molecule complete" }),
    el("h1", { className: "intro-title", textContent: `${pretty(entry.molecule)} done!` }),
    el("p", {
      className: "muted",
      textContent: `You reviewed all ${reactions.length} reactions. ` + (others
        ? `Here's how your scores compare with ${others} other reviewer${others === 1 ? "" : "s"}.`
        : `You're the first to finish ${pretty(entry.molecule)}. The panel comparison unlocks as others finish it.`),
    }),
    el("div", { className: "cmp" }, [
      el("div", { className: "cmp-legend tiny" }, [
        el("span", { className: "k you", textContent: "you" }),
        others ? el("span", { className: "k panel", textContent: "panel average" }) : null,
      ]),
      ...rows,
    ]),
    el("div", { className: "intro-actions" }, [next, revisit]),
  ]));
}

function bar(kind, v) {
  const b = el("div", { className: `cmp-bar ${kind}` }, [el("i"), el("span", { textContent: v == null ? "–" : v.toFixed(1) })]);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    b.querySelector("i").style.width = `${((v ?? 0) / SCORE_MAX) * 100}%`;
  }));
  return b;
}

function allDoneView() {
  activeSaver = null;
  fx.confetti({ count: 200, spread: 1.2 });
  fx.sound.fanfare();
  stage(el("section", { className: "card finish" }, [
    el("div", { className: "trophy" }, [icon("crown")]),
    el("p", { className: "eyebrow", textContent: "Every molecule reviewed" }),
    el("h1", { className: "intro-title", textContent: "You did it all." }),
    el("p", {
      className: "muted",
      textContent: `You've reviewed every network on the panel: ${me.reactions} reactions in total. ` +
        "Thank you! This is exactly what makes the evaluation trustworthy.",
    }),
  ]));
}

/* ---------------------------------------------------------- leaderboard -- */

async function refreshBoard({ announce = false } = {}) {
  const { model, config } = manifest.networks[0];
  const rows = await db.leaderboard(model, config, criteria);
  const before = myRank;
  board = rows;
  const i = rows.findIndex((r) => r.reviewer === username);
  myRank = i >= 0 ? i + 1 : null;
  const mine = rows[i];
  // The server is the source of truth, but never move the counters backwards
  // under an optimistic +1 that is still in flight.
  if (mine) {
    me.reactions = Math.max(mine.reactions, announce ? me.reactions : 0);
    me.molecules = Math.max(mine.molecules, announce ? me.molecules : 0);
    me.notes = mine.notes;
  }

  renderBoard();
  paintStats();
  renderPanel();

  if (!announce) return;
  if (before == null && myRank != null) {
    fx.toast(`You're on the leaderboard at #${myRank}!`, { icon: "ranking-star", kind: "badge" });
    fx.sound.sparkle();
  } else if (before != null && myRank != null && myRank < before) {
    const passed = rows[myRank]?.reviewer;
    fx.toast(passed ? `You passed @${passed}, now #${myRank}!` : `Up to #${myRank}!`, { icon: "rocket", kind: "badge" });
    fx.sound.sparkle();
    fx.pulse($("btn-rail"));
  }
}

function renderBoard() {
  const list = $("lb-list");
  const top = board.reduce((m, r) => Math.max(m, r.reactions), 1);
  const shown = board.slice(0, BOARD_SHOWN);
  const rowFor = (r, rank) => {
    const li = el("li", { className: r.reviewer === username ? "me" : "" });
    const av = el("span", { className: "avatar sm" });
    paintAvatar(av, r.reviewer);
    li.append(
      rank <= 3
        ? el("span", { className: `rank medal m${rank}`, title: `#${rank}` }, [icon("medal")])
        : el("span", { className: "rank", textContent: String(rank) }),
      av,
      el("span", { className: "lb-name" }, [
        el("span", { textContent: `@${r.reviewer}` }),
        el("span", { className: "lb-bar" }, [Object.assign(el("i"), { style: `width:${(r.reactions / top) * 100}%` })]),
      ]),
      el("b", { className: "lb-n", textContent: String(r.reactions) })
    );
    return li;
  };

  const items = shown.map((r, k) => rowFor(r, k + 1));
  if (myRank && myRank > BOARD_SHOWN) {
    items.push(el("li", { className: "gap" }, [icon("ellipsis")]), rowFor(board[myRank - 1], myRank));
  }
  if (!items.length) items.push(el("li", { className: "empty", textContent: "No reviews yet. Be the first!" }));
  list.replaceChildren(...items);

  $("rank-short").textContent = myRank ? `#${myRank}` : "–";

  const nudge = $("lb-nudge");
  if (!myRank) {
    nudge.replaceChildren(icon("flag-checkered"), " Review your first reaction to join the board.");
  } else if (myRank === 1) {
    const lead = board.length > 1 ? board[0].reactions - board[1].reactions : 0;
    nudge.replaceChildren(icon("crown"), board.length > 1
      ? (lead ? ` You lead by ${lead}. Keep it up!` : " Tied for first. One more takes the lead!")
      : " You're setting the pace.");
  } else {
    const ahead = board[myRank - 2];
    const gap = ahead.reactions - me.reactions + 1;
    nudge.replaceChildren(icon("arrow-up"), ` ${gap} more to pass @${ahead.reviewer}`);
  }
}

function renderPanel() {
  const totalReactions = manifest.networks.reduce((a, n) => a + n.n_reactions, 0);
  const target = totalReactions * TARGET_REVIEWERS;
  const doneAll = board.reduce((a, r) => a + r.reactions, 0);
  $("panel-frac").textContent = `${doneAll} / ${target}`;
  $("panel-bar").style.width = `${Math.min(100, (doneAll / target) * 100)}%`;
  $("panel-note").textContent =
    `${board.length} reviewer${board.length === 1 ? "" : "s"} so far. Goal: ${TARGET_REVIEWERS} independent reviews of all ${totalReactions} reactions.`;
}

function paintStats() {
  for (const [id, v] of [["st-reactions", me.reactions], ["st-molecules", me.molecules], ["st-notes", me.notes]]) {
    const node = $(id);
    if (node.textContent !== String(v)) {
      node.textContent = String(v);
      fx.pulse(node);
    }
  }
}

function paintStreak() {
  const s = $("streak");
  s.hidden = streak < 2;
  s.replaceChildren(icon("fire"), ` ${streak}`);
  s.title = `${streak} in a row this session`;
  fx.pulse(s);
}

function renderBadges() {
  $("badges").replaceChildren(...BADGES.map((b) => {
    const on = earned.has(b.name);
    const node = el("span", { className: `badge${on ? " on" : ""}`, title: on ? b.name : `Locked: ${b.hint}` }, [
      icon(b.icon, "bi"),
      el("span", { className: "bn" }, [on ? b.name : icon("lock")]),
    ]);
    node.style.setProperty("--bh", String(b.hue));
    node.dataset.name = b.name;
    return node;
  }));
}

function checkBadges() {
  const fresh = BADGES.filter((b) => !earned.has(b.name) && b.test(me));
  if (!fresh.length) return;
  fresh.forEach((b, k) => {
    earned.add(b.name);
    setTimeout(() => {
      fx.toast(`Badge unlocked: ${b.name}`, { icon: b.icon, kind: "badge", ms: 4000 });
      fx.sound.sparkle();
      fx.confetti({ count: 70, spread: 0.8 });
    }, 500 + k * 900);
  });
  renderBadges();
  for (const b of fresh) fx.pulse(document.querySelector(`.badge[data-name="${CSS.escape(b.name)}"]`), "shine");
}

function hue(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function paintAvatar(node, name) {
  node.textContent = (name[0] || "?").toUpperCase();
  node.style.setProperty("--h", String(hue(name)));
}

/* ---------------------------------------------------------------- sheet -- */

function openSheet(rxn) {
  const { entry } = current;
  const frame = $("explorer");
  $("sheet-title").textContent = `${pretty(entry.molecule)} network`;
  $("net-sheet").hidden = false;
  document.body.classList.add("noscroll");

  // Same network already loaded: just move the focus, no reload.
  if (frame.dataset.file === entry.file && frame.contentWindow) {
    frame.contentWindow.postMessage({ type: "astra-focus", id: rxn.id }, location.origin);
    return;
  }
  // explorer.html serves this one network to the unmodified explorer as its
  // whole file index; paths are relative to pathway_explorer/.
  const q = new URLSearchParams({ f: entry.file, v: entry.validation || "", m: entry.molecule, focus: rxn.id });
  frame.dataset.file = entry.file;
  frame.src = `explorer.html?${q}`;
}

function closeSheet() {
  $("net-sheet").hidden = true;
  document.body.classList.remove("noscroll");
}

/* --------------------------------------------------------------- logout -- */

function askLogout() {
  const left = current?.reactions ? current.reactions.length - doneCount() : 0;
  if (left > 0 && left <= 5 && document.querySelector(".rxn-view, .intro")) {
    $("leave-text").textContent =
      `Only ${left} reaction${left === 1 ? "" : "s"} left to finish ${pretty(current.entry.molecule)}. ` +
      "Finish now and unlock the panel comparison?";
    $("leave-sheet").hidden = false;
    return;
  }
  logout();
}

async function logout() {
  clearInterval(boardTimer);
  try { await activeSaver?.flush(); } catch { /* signing out regardless */ }
  await db.disconnect();
  // The database credentials stay, so signing back in needs no invite link.
  store.del(PASS_KEY);
  location.replace(location.pathname);
}

initLogin();
