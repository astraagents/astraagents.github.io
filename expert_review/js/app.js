/**
 * ASTRA expert review -- UI, slide deck and form state.
 * All database access goes through js/db.js; the graph popup through js/graph.js.
 */

import * as db from "./db.js";
import * as graph from "./graph.js";

const SAVE_DEBOUNCE_MS = 700;
const AUTO_ADVANCE_MS = 900;
const SCORE_MAX = 10;      // scores are 0-10; SCORE_MAX + 1 tick dots are drawn

/** @type {{criteria:{reaction:string[],network:string[]}, molecules:string[], networks:any[]}} */
let manifest = null;
/** Reviewer's saved work, keyed "<netKey>|<scope>|<reactionId>". */
let progress = { scores: {}, comments: {}, submitted: new Set() };
let username = "";
let current = null;                 // { entry, meta, net, slides, index }
const loadedNetworks = new Map();   // file -> parsed JSON
let autoAdvanceTimer = null;

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) n.append(k);
  return n;
};
const cell = (netKey, scope, rid = "") => `${netKey}|${scope}|${rid}`;

/* --------------------------------------------------------------- login --- */

$("login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const msg = $("login-msg");
  const btn = $("btn-login");

  // One normalisation, at the door. Everything downstream uses this value, so a
  // reviewer typing "Jane_Doe" and "jane_doe" is the same person -- previously a
  // difference in case silently started them over with an empty slate.
  const name = $("in-user").value.trim().toLowerCase();
  if (!name) return showMsg(msg, "Please enter your reviewer username.");
  if (/\s/.test(name)) return showMsg(msg, "Username cannot contain spaces.");
  $("in-user").value = name;

  hide(msg);
  btn.disabled = true;
  btn.textContent = "Connecting…";

  try {
    await db.connect({ user: $("in-db-user").value.trim(), password: $("in-db-pass").value });
    username = name;
    sessionStorage.setItem("astra_reviewer_username", name);

    if (!manifest) manifest = await fetchJSON("data/review_index.json");
    progress = await db.loadProgress(username);

    $("login").hidden = true;
    $("app").hidden = false;
    $("who-name").textContent = username;
    await startApp();
  } catch (err) {
    showMsg(msg, err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});

$("btn-logout").addEventListener("click", async () => {
  await db.disconnect();
  sessionStorage.removeItem("astra_reviewer_username");
  location.reload();
});

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
const hide = (node) => { node.hidden = true; };

/* ----------------------------------------------------------- app start --- */

async function startApp() {
  const sel = $("sel-molecule");
  sel.replaceChildren(
    ...manifest.molecules.map((m) =>
      el("option", { value: m, textContent: m.replace(/_/g, "-") }))
  );
  sel.addEventListener("change", () => selectMolecule(sel.value));

  $("btn-prev").addEventListener("click", () => { cancelAutoAdvance(); go(current.index - 1); });
  $("btn-next").addEventListener("click", () => { cancelAutoAdvance(); go(current.index + 1); });
  $("btn-graph").addEventListener("click", openGraph);

  graph.initGraphControls();
  graph.setReactionTapHandler((rid) => {
    const i = current.slides.findIndex((s) => s.rxn && s.rxn.id === rid);
    if (i >= 0) go(i);
  });

  document.addEventListener("keydown", onKeydown);

  await resume();
}

/** Where the reviewer should land: the first network still needing work. */
async function resume() {
  const queue = queueOrder();
  const next = queue.find((n) => !progress.submitted.has(n.key));

  if (!next) {
    await selectNetwork(queue[0]);
    showMsg($("app-msg"), "All 36 networks are complete. Thank you!", "ok");
    return;
  }

  $("sel-molecule").value = next.molecule;
  renderNetButtons(next.molecule);
  await selectNetwork(next);

  // Within that network, the first reaction still missing a score. If they are
  // all done, the remaining work is the overall assessment.
  const firstTodo = current.slides.findIndex((s) => s.rxn && !reactionDone(s.rxn.id));
  go(firstTodo >= 0 ? firstTodo : current.slides.length - 1);
}

/** Queue order: molecules as listed in the manifest, then blind label A..D. */
function queueOrder() {
  const order = new Map(manifest.molecules.map((m, i) => [m, i]));
  return [...manifest.networks].sort((a, b) =>
    (order.get(a.molecule) - order.get(b.molecule)) || a.blind.localeCompare(b.blind));
}

function networksFor(molecule) {
  return manifest.networks
    .filter((n) => n.molecule === molecule)
    .sort((a, b) => a.blind.localeCompare(b.blind));
}

function renderNetButtons(molecule) {
  $("net-buttons").replaceChildren(
    ...networksFor(molecule).map((n) => {
      const b = el("button", { className: "netbtn", type: "button" });
      b.setAttribute("aria-pressed", "false");
      b.dataset.key = n.key;
      b.addEventListener("click", () => selectNetwork(n));
      return b;
    })
  );
}

function selectMolecule(molecule) {
  hide($("app-msg"));
  renderNetButtons(molecule);
  selectNetwork(networksFor(molecule)[0]);
}

async function selectNetwork(entry) {
  cancelAutoAdvance();

  for (const b of $("net-buttons").children) {
    b.setAttribute("aria-pressed", String(b.dataset.key === entry.key));
  }

  let data = loadedNetworks.get(entry.file);
  if (!data) {
    try {
      data = await fetchJSON(entry.file);
      loadedNetworks.set(entry.file, data);
    } catch (err) {
      return showMsg($("app-msg"), err.message);
    }
  }

  current = {
    entry,
    meta: {
      reviewerName: username,
      model: entry.model,
      molecule: entry.molecule,
      config: entry.config,
      run: entry.run,
      attempt: entry.attempt ?? "",
    },
    net: data.network,
    slides: [],
    index: 0,
  };

  renderNetwork();
  go(0);
}

/* ------------------------------------------------------------ rendering -- */

function moleculeLookup(net) {
  const map = new Map();
  for (const m of net.molecules || []) {
    map.set(m.id, { label: m.common_name || m.iupac_name || m.id, formula: m.formula || "" });
  }
  return map;
}

function renderNetwork() {
  const { entry, net } = current;
  const reactions = net.reactions || [];
  const mols = moleculeLookup(net);

  $("net-title").textContent = `Network ${entry.blind} · ${entry.molecule.replace(/_/g, "-")}`;
  $("net-strategy").textContent = net.overall_strategy || "";

  // Every slide is built once and shown/hidden, so slider state and pending
  // autosaves survive paging back and forth.
  current.slides = reactions.map((rxn, i) => ({
    rxn,
    node: reactionSlide(rxn, i, mols),
  }));
  current.slides.push({ overall: true, node: overallSlide() });

  $("slides").replaceChildren(...current.slides.map((s) => s.node));
  renderChips();
  refreshProgress();
}

function formatSide(ids, mols) {
  if (!ids || !ids.length) return el("span", { className: "dim", textContent: "—" });
  const frag = document.createDocumentFragment();
  ids.forEach((id, i) => {
    if (i) frag.append(" + ");
    const m = mols.get(id);
    frag.append(el("span", { className: "mol", textContent: m ? m.label : id }));
    if (m?.formula) frag.append(el("span", { className: "f", textContent: ` (${m.formula})` }));
  });
  return frag;
}

function reactionSlide(rxn, i, mols) {
  const slide = el("div", { className: "slide" });
  const card = el("div", { className: "rxn" });
  card.dataset.rid = rxn.id;

  card.append(el("div", { className: "head" }, [
    el("span", { className: "rid", textContent: rxn.id }),
    el("span", { className: "rname", textContent: rxn.name || `Reaction ${i + 1}` }),
    el("span", { className: "state" }),
  ]));

  const eq = el("div", { className: "eq" });
  eq.append(formatSide(rxn.inputs, mols));
  eq.append(el("span", { className: "arrow", textContent: "→" }));
  eq.append(formatSide(rxn.outputs, mols));
  card.append(eq);

  if (rxn.environment) {
    card.append(el("span", { className: `tag ${rxn.environment}`, textContent: rxn.environment }));
  }

  const facts = el("dl", { className: "facts" });
  const addFact = (label, value) => {
    if (value === undefined || value === null || value === "") return;
    facts.append(el("dt", { textContent: label }), el("dd", { textContent: String(value) }));
  };
  const c = rxn.conditions || {};
  addFact("Temperature", c.temperature);
  addFact("Pressure", c.pressure);
  addFact("Catalyst", c.catalyst);
  if (typeof c.aqueous === "boolean") addFact("Aqueous", c.aqueous ? "yes" : "no");
  addFact("Other", c.other);
  if (rxn.agents?.length) addFact("Agents", rxn.agents.join(", "));
  if (facts.childElementCount) card.append(facts);

  const prose = el("div", { className: "prose" });
  if (rxn.mechanism) prose.append(el("h4", { textContent: "Mechanism" }), el("p", { textContent: rxn.mechanism }));
  if (rxn.reasoning) prose.append(el("h4", { textContent: "Reasoning" }), el("p", { textContent: rxn.reasoning }));
  if (prose.childElementCount) card.append(prose);

  card.append(scoreBlock("reaction", rxn.id, manifest.criteria.reaction, card));
  paintCardState(card);

  slide.append(card);
  return slide;
}

function overallSlide() {
  const slide = el("div", { className: "slide" });
  const panel = el("div", { className: "panel overall" });
  const key = cell(current.entry.key, "network", "");

  panel.append(
    el("h3", { textContent: "Overall assessment of this network" }),
    el("p", {
      className: "muted tiny",
      style: "margin:0 0 14px",
      textContent: `All seven criteria are required to mark the network complete. 0 = worst, ${SCORE_MAX} = best.`,
    }),
    scoreBlock("network", "", manifest.criteria.network, null)
  );

  const box = el("div", { className: "comment" });
  const ta = el("textarea", {
    id: "overall-opinion", rows: 5,
    placeholder: "Overall impressions, specific concerns, anything the numbers do not capture.",
    value: progress.comments[key] || "",
  });
  box.append(
    el("label", { htmlFor: "overall-opinion", textContent: "Your opinion on this network (optional)" }),
    ta
  );
  panel.append(box);

  const status = el("div", { className: "saving", id: "overall-saving" });
  const btn = el("button", { className: "btn primary", type: "button", id: "btn-submit" });
  btn.addEventListener("click", submitNetwork);
  panel.append(el("div", { className: "submitrow" }, [btn, status]));

  let timer = null;
  ta.addEventListener("focus", cancelAutoAdvance);
  ta.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      status.textContent = "Saving…";
      status.className = "saving";
      try {
        await db.saveComment(current.meta, "network", "", ta.value);
        if (ta.value.trim()) progress.comments[key] = ta.value.trim();
        else delete progress.comments[key];
        status.textContent = "Opinion saved";
        status.className = "saving ok";
      } catch (err) {
        status.textContent = err.message;
        status.className = "saving err";
      }
    }, SAVE_DEBOUNCE_MS);
  });

  slide.append(panel);
  return slide;
}

/* -------------------------------------------------------------- scoring -- */

/**
 * Sliders plus a comment box for one scope. Sliders start unset, shown as "--",
 * so an untouched criterion is never written as a real score.
 */
function scoreBlock(scope, reactionId, criteria, cardForState) {
  const key = cell(current.entry.key, scope, reactionId);
  const saved = progress.scores[key] || {};

  const block = el("div", { className: "scores" });
  block.append(el("h4", { textContent: scope === "reaction" ? `Your scores (0–${SCORE_MAX})` : "" }));

  const pending = {};
  let timer = null;
  const status = el("div", { className: "saving" });

  const flush = async () => {
    const batch = pending.scores;
    pending.scores = null;
    if (!batch) return;
    const wasDone = scope === "reaction" && reactionDone(reactionId);
    status.textContent = "Saving…";
    status.className = "saving";
    try {
      await db.saveScores(current.meta, scope, reactionId, batch);
      Object.assign((progress.scores[key] ||= {}), batch);
      for (const [crit, v] of Object.entries(batch)) {
        if (v === null) delete progress.scores[key][crit];
      }
      status.textContent = "Saved";
      status.className = "saving ok";
      if (cardForState) paintCardState(cardForState);
      renderChips();
      refreshProgress();
      // Only when this save is what completed the reaction -- not on every
      // later tweak of an already-complete one.
      if (scope === "reaction" && !wasDone && reactionDone(reactionId)) scheduleAutoAdvance();
    } catch (err) {
      status.textContent = err.message;
      status.className = "saving err";
    }
  };

  const queue = (criterion, value) => {
    (pending.scores ||= {})[criterion] = value;
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };

  for (const criterion of criteria) {
    const row = el("div", { className: "srow" });
    const id = `s-${scope}-${reactionId}-${criterion}`.replace(/[^\w-]/g, "_");
    const has = Object.prototype.hasOwnProperty.call(saved, criterion);

    const range = el("input", {
      type: "range", min: "0", max: String(SCORE_MAX), step: "1", id,
      value: has ? String(saved[criterion]) : String(Math.round(SCORE_MAX / 2)),
    });
    // One dot per selectable value, laid out with the same half-thumb inset as
    // the native track so each dot sits under the position it represents.
    const ticks = el("div", { className: "ticks" },
      Array.from({ length: SCORE_MAX + 1 }, () => el("span")));
    const track = el("div", { className: "track" }, [range, ticks]);
    const num = el("span", { textContent: has ? String(saved[criterion]) : "--" });
    const clear = el("button", {
      className: "clear", type: "button", title: "Clear this score", textContent: "×",
    });
    const out = el("span", { className: "val" }, [num, clear]);

    row.classList.toggle("unset", !has);
    row.append(el("label", { htmlFor: id, textContent: criterion }), track, out);

    range.addEventListener("input", () => {
      row.classList.remove("unset");
      num.textContent = range.value;
      queue(criterion, Number(range.value));
    });
    clear.addEventListener("click", () => {
      cancelAutoAdvance();
      row.classList.add("unset");
      num.textContent = "--";
      range.value = String(Math.round(SCORE_MAX / 2));
      queue(criterion, null);
    });

    block.append(row);
  }

  if (scope === "reaction") {
    const cid = `c-${reactionId}`;
    const ta = el("textarea", {
      id: cid, rows: 3,
      placeholder: "Optional note on this reaction",
      value: progress.comments[key] || "",
    });
    const box = el("div", { className: "comment" }, [
      el("label", { htmlFor: cid, textContent: "Note (optional)" }),
      ta,
    ]);
    // Reaching for the note must not have the slide pulled away mid-thought.
    ta.addEventListener("focus", cancelAutoAdvance);
    let ctimer = null;
    ta.addEventListener("input", () => {
      clearTimeout(ctimer);
      ctimer = setTimeout(async () => {
        status.textContent = "Saving…";
        status.className = "saving";
        try {
          await db.saveComment(current.meta, scope, reactionId, ta.value);
          if (ta.value.trim()) progress.comments[key] = ta.value.trim();
          else delete progress.comments[key];
          status.textContent = "Saved";
          status.className = "saving ok";
        } catch (err) {
          status.textContent = err.message;
          status.className = "saving err";
        }
      }, SAVE_DEBOUNCE_MS);
    });
    block.append(box);
  }

  block.append(status);
  return block;
}

/* ------------------------------------------------------------- deck nav -- */

function go(index) {
  if (!current || index < 0 || index >= current.slides.length) return;
  current.index = index;
  current.slides.forEach((s, i) => s.node.classList.toggle("active", i === index));

  const n = current.slides.length - 1;          // reaction count
  $("slide-count").textContent =
    index === n ? "Overall assessment" : `Reaction ${index + 1} of ${n}`;
  $("btn-prev").disabled = index === 0;
  $("btn-next").disabled = index === current.slides.length - 1;

  renderChips();
  if (current.slides[index].overall) updateSubmitButton();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderChips() {
  if (!current) return;
  const chips = current.slides.map((s, i) => {
    const b = el("button", { className: "chip", type: "button" });
    if (s.overall) {
      b.classList.add("overall");
      b.textContent = "Overall";
      const done = networkScored() === manifest.criteria.network.length;
      if (done) b.classList.add("done");
      else if (networkScored() > 0) b.classList.add("partial");
    } else {
      b.textContent = String(i + 1);
      const saved = progress.scores[cell(current.entry.key, "reaction", s.rxn.id)] || {};
      const count = Object.keys(saved).length;
      if (count === manifest.criteria.reaction.length) b.classList.add("done");
      else if (count > 0) b.classList.add("partial");
      b.title = s.rxn.name || s.rxn.id;
    }
    if (i === current.index) b.classList.add("current");
    b.addEventListener("click", () => { cancelAutoAdvance(); go(i); });
    return b;
  });
  $("chips").replaceChildren(...chips);
}

function onKeydown(ev) {
  if (graph.isOpen()) {
    if (ev.key === "Escape") graph.closeGraph();
    return;
  }
  // Let arrows do their native job inside a slider or a note.
  const tag = ev.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (ev.key === "ArrowLeft") { cancelAutoAdvance(); go(current.index - 1); }
  if (ev.key === "ArrowRight") { cancelAutoAdvance(); go(current.index + 1); }
}

function scheduleAutoAdvance() {
  cancelAutoAdvance();
  if (current.slides[current.index].overall) return;
  autoAdvanceTimer = setTimeout(() => {
    autoAdvanceTimer = null;
    // Re-check at fire time, not only via cancelAutoAdvance(). The save is
    // debounced and then round-trips to the database, so this timer is often
    // created AFTER the reviewer has already clicked into the note box -- there
    // would have been no timer to cancel. Never move the slide out from under
    // someone who is typing.
    const tag = document.activeElement?.tagName;
    if (tag === "TEXTAREA" || graph.isOpen()) return;
    const next = current.slides.findIndex(
      (s, i) => i > current.index && s.rxn && !reactionDone(s.rxn.id));
    go(next >= 0 ? next : current.index + 1);
  }, AUTO_ADVANCE_MS);
}

function cancelAutoAdvance() {
  clearTimeout(autoAdvanceTimer);
  autoAdvanceTimer = null;
}

function openGraph() {
  cancelAutoAdvance();
  const slide = current.slides[current.index];
  graph.openGraph(
    current.entry.file,
    slide.rxn ? slide.rxn.id : null,
    `Network ${current.entry.blind} · ${current.entry.molecule.replace(/_/g, "-")}`
  ).catch((err) => showMsg($("app-msg"), `Could not draw the graph: ${err.message}`));
}

/* ------------------------------------------------------------- progress -- */

function reactionDone(rid) {
  const saved = progress.scores[cell(current.entry.key, "reaction", rid)] || {};
  return manifest.criteria.reaction.every((c) =>
    Object.prototype.hasOwnProperty.call(saved, c));
}

function networkScored() {
  const saved = progress.scores[cell(current.entry.key, "network", "")] || {};
  return manifest.criteria.network.filter((c) =>
    Object.prototype.hasOwnProperty.call(saved, c)).length;
}

function paintCardState(card) {
  const done = reactionDone(card.dataset.rid);
  card.classList.toggle("done", done);
  const state = card.querySelector(".head .state");
  if (!state) return;
  const n = Object.keys(
    progress.scores[cell(current.entry.key, "reaction", card.dataset.rid)] || {}).length;
  const total = manifest.criteria.reaction.length;
  state.textContent = done ? "✓ reviewed" : n ? `${n}/${total}` : "not scored";
}

function updateSubmitButton() {
  const btn = $("btn-submit");
  if (!btn) return;
  const total = manifest.criteria.network.length;
  const have = networkScored();
  btn.disabled = have < total;
  btn.textContent = progress.submitted.has(current.entry.key)
    ? "Complete ✓ — click to re-confirm"
    : have < total
      ? `Mark network complete (${have}/${total} criteria)`
      : "Mark network complete";
}

async function submitNetwork() {
  const status = $("overall-saving");
  const btn = $("btn-submit");
  btn.disabled = true;
  status.textContent = "Submitting…";
  status.className = "saving";
  try {
    await db.markSubmitted(current.meta);
    progress.submitted.add(current.entry.key);
    status.textContent = "Network marked complete. Thank you.";
    status.className = "saving ok";
    refreshProgress();
  } catch (err) {
    status.textContent = err.message;
    status.className = "saving err";
  } finally {
    updateSubmitButton();
  }
}

function refreshProgress() {
  const reactions = current.net.reactions || [];
  const done = reactions.filter((r) => reactionDone(r.id)).length;

  $("net-progress").textContent =
    `${done} / ${reactions.length} reactions reviewed · ` +
    `${networkScored()} / ${manifest.criteria.network.length} overall criteria`;
  $("net-bar").style.width = reactions.length ? `${(done / reactions.length) * 100}%` : "0";

  const submitted = manifest.networks.filter((n) => progress.submitted.has(n.key)).length;
  $("overall-progress").textContent =
    `${submitted} / ${manifest.networks.length} networks complete`;
  $("overall-bar").style.width = `${(submitted / manifest.networks.length) * 100}%`;

  for (const b of $("net-buttons").children) {
    const n = manifest.networks.find((x) => x.key === b.dataset.key);
    if (!n) continue;
    // Counted from saved progress, not from the file, so networks that have not
    // been opened yet still show a real fraction rather than a bare total.
    b.replaceChildren(
      document.createTextNode(`Network ${n.blind}`),
      progress.submitted.has(n.key)
        ? el("span", { className: "tick", textContent: "✓" })
        : document.createTextNode(""),
      el("span", {
        className: "frac",
        textContent: `${countReactionsDone(n.key)}/${n.n_reactions} reactions`,
      })
    );
  }
  updateSubmitButton();
}

/** How many reactions of a network this reviewer has fully scored. */
function countReactionsDone(netKey) {
  const prefix = `${netKey}|reaction|`;
  let n = 0;
  for (const [key, saved] of Object.entries(progress.scores)) {
    if (!key.startsWith(prefix)) continue;
    if (manifest.criteria.reaction.every((c) =>
      Object.prototype.hasOwnProperty.call(saved, c))) n++;
  }
  return n;
}

/* Prefill the username if this tab already signed in. */
const remembered = sessionStorage.getItem("astra_reviewer_username");
if (remembered) $("in-user").value = remembered;
