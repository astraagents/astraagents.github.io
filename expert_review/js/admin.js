/**
 * ASTRA expert review -- admin dashboard.
 *
 * Opened instead of the review flow when someone signs in as the admin username
 * (see ADMIN_USERNAME in js/app.js). Shows review progress per molecule and per
 * reviewer, recent activity, and exports the whole review database as CSV.
 * Reads only; all queries live in js/db.js.
 */

import * as db from "./db.js";
import * as fx from "./fx.js";
import { $, el, icon, setLabel, pretty } from "./dom.js";

const REFRESH_MS = 30_000;
const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

/** { manifest, username, targetReviewers, criteria, model, config, totalReactions } */
let ctx = null;
let timer = null;
let loadedAt = null;
let agoTimer = null;

export async function startAdmin({ manifest, username, targetReviewers }) {
  const { model, config } = manifest.networks[0];
  ctx = {
    manifest, username, targetReviewers, model, config,
    criteria: manifest.criteria.reaction,
    totalReactions: manifest.networks.reduce((a, n) => a + n.n_reactions, 0),
  };
  document.body.classList.add("admin");
  $("admin-pill").hidden = false;

  $("stage").replaceChildren(skeleton());
  await refresh();
  clearInterval(timer);
  timer = setInterval(() => refresh().catch(() => {}), REFRESH_MS);
  clearInterval(agoTimer);
  agoTimer = setInterval(paintUpdated, 5_000);
}

/* ------------------------------------------------------------- layout --- */

function skeleton() {
  const refreshBtn = el("button", { className: "btn small ghost", type: "button", id: "adm-refresh" },
    [icon("rotate"), " Refresh"]);
  refreshBtn.addEventListener("click", () => refresh({ manual: true }));

  return el("div", { className: "admin view enter-up" }, [
    el("div", { className: "adm-head" }, [
      el("div", {}, [
        el("p", { className: "eyebrow", textContent: "Admin" }),
        el("h1", { className: "adm-title", textContent: "Review status" }),
        el("p", {
          className: "muted tiny",
          textContent: `${ctx.totalReactions} reactions across ${ctx.manifest.networks.length} molecules · ` +
            `goal: ${ctx.targetReviewers} independent reviews each`,
        }),
      ]),
      el("span", { className: "spacer" }),
      el("span", { className: "tiny dim", id: "adm-updated" }),
      refreshBtn,
    ]),
    el("div", { className: "kpis", id: "adm-kpis" }),
    el("section", { className: "card" }, [
      el("div", { className: "card-h" }, [
        el("h2", {}, [icon("bullseye"), " Overall progress"]),
        el("span", { className: "tiny dim", id: "adm-overall-frac" }),
      ]),
      el("div", { className: "bar big" }, [el("i", { id: "adm-overall-bar" })]),
      el("p", { className: "tiny dim", id: "adm-overall-note" }),
    ]),
    el("section", { className: "card" }, [
      el("div", { className: "card-h" }, [
        el("h2", {}, [icon("flask"), " Molecules"]),
        el("span", { className: "tiny dim", textContent: "coverage = reactions with ≥ 1 complete review" }),
      ]),
      el("div", { className: "tablewrap", id: "adm-molecules" }),
    ]),
    el("div", { className: "adm-cols" }, [
      el("section", { className: "card" }, [
        el("div", { className: "card-h" }, [
          el("h2", {}, [icon("users"), " Reviewers"]),
          el("span", { className: "tiny dim", id: "adm-reviewer-count" }),
        ]),
        el("div", { className: "tablewrap", id: "adm-reviewers" }),
      ]),
      el("section", { className: "card" }, [
        el("div", { className: "card-h" }, [el("h2", {}, [icon("clock-rotate-left"), " Recent activity"])]),
        el("ol", { className: "activity", id: "adm-recent" }),
      ]),
    ]),
    exportCard(),
  ]);
}

/* -------------------------------------------------------------- data --- */

let refreshing = false;

async function refresh({ manual = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  const btn = $("adm-refresh");
  btn?.classList.add("spinning");
  try {
    const [overview, sizes] = await Promise.all([
      db.adminOverview(ctx.model, ctx.config, ctx.criteria, ctx.targetReviewers, ctx.username),
      db.tableSizes(),
    ]);
    renderKpis(overview);
    renderMolecules(overview.molecules);
    renderReviewers(overview.reviewers);
    renderRecent(overview.recent);
    renderTables(sizes);
    loadedAt = Date.now();
    paintUpdated();
    if (manual) fx.toast("Dashboard updated", { icon: "rotate", ms: 1600 });
  } catch (err) {
    fx.toast(err.message, { kind: "err", icon: "triangle-exclamation" });
  } finally {
    refreshing = false;
    btn?.classList.remove("spinning");
  }
}

function paintUpdated() {
  const n = $("adm-updated");
  if (n && loadedAt) n.textContent = `Updated ${ago(loadedAt)}`;
}

/* ---------------------------------------------------------- sections --- */

function renderKpis({ molecules, reviewers }) {
  const sum = (k) => molecules.reduce((a, m) => a + (m[k] || 0), 0);
  const reviews = sum("reviews");
  const covered = sum("covered");
  const atTarget = sum("at_target");
  const target = ctx.totalReactions * ctx.targetReviewers;
  const contributing = reviewers.filter((r) => r.complete > 0).length;
  const partial = reviewers.reduce((a, r) => a + r.partial, 0);
  const notes = reviewers.reduce((a, r) => a + r.notes, 0);
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "–");

  const tile = (ic, hue, value, label, sub) => {
    const t = el("div", { className: "kpi" }, [
      el("span", { className: "kpi-i" }, [icon(ic)]),
      el("b", { textContent: value }),
      el("span", { className: "kpi-l", textContent: label }),
      sub ? el("span", { className: "kpi-s", textContent: sub }) : null,
    ]);
    t.style.setProperty("--kh", String(hue));
    return t;
  };

  $("adm-kpis").replaceChildren(
    tile("circle-check", 145, String(reviews), "reviews complete", `of ${target} · ${pct(reviews, target)}`),
    tile("vials", 200, `${covered}/${ctx.totalReactions}`, "reactions reviewed", `≥ 1 review · ${pct(covered, ctx.totalReactions)}`),
    tile("bullseye", 270, `${atTarget}/${ctx.totalReactions}`, "reactions at goal", `≥ ${ctx.targetReviewers} reviews`),
    tile("users", 230, String(contributing), "active reviewers", `${reviewers.length} signed up`),
    tile("hourglass-half", 35, String(partial), "in progress", "partly scored reactions"),
    tile("pen-to-square", 330, String(notes), "notes", "free-text comments"),
  );

  $("adm-overall-frac").textContent = `${reviews} / ${target}`;
  $("adm-overall-bar").style.width = `${Math.min(100, target ? (reviews / target) * 100 : 0)}%`;
  $("adm-overall-note").textContent =
    `${pct(reviews, target)} of the goal. ${ctx.totalReactions - covered} reaction` +
    `${ctx.totalReactions - covered === 1 ? " has" : "s have"} no complete review yet.`;
}

function renderMolecules(rows) {
  $("adm-molecules").replaceChildren(table(
    [
      { label: "Molecule", render: (m) => el("b", { textContent: pretty(m.molecule) }) },
      { label: "Reactions", num: true, render: (m) => String(m.reactions) },
      { label: "Reviews", num: true, render: (m) => String(m.reviews) },
      {
        label: "Coverage", wide: true,
        render: (m) => meter(m.covered, m.reactions, `${m.covered}/${m.reactions}`),
      },
      { label: `At goal (≥${ctx.targetReviewers})`, num: true, render: (m) => `${m.at_target}/${m.reactions}` },
      {
        label: "Assignments",
        render: (m) => el("span", { className: "pills-inline" }, [
          chip("play", "active", m.active, "Active"),
          chip("check", "done", m.done, "Done"),
          chip("forward", "skipped", m.skipped, "Skipped"),
        ]),
      },
    ],
    rows,
    "No reactions in the database yet. Run tools/seed_reactions.py."
  ));
}

function renderReviewers(rows) {
  $("adm-reviewer-count").textContent = `${rows.length} reviewer${rows.length === 1 ? "" : "s"}`;
  $("adm-reviewers").replaceChildren(table(
    [
      {
        label: "Reviewer",
        render: (r) => {
          const av = el("span", { className: "avatar sm" });
          av.textContent = (r.reviewer[0] || "?").toUpperCase();
          av.style.setProperty("--h", String(hue(r.reviewer)));
          return el("span", { className: "who-cell" }, [av, `@${r.reviewer}`]);
        },
      },
      { label: "Complete", num: true, render: (r) => el("b", { textContent: String(r.complete) }) },
      { label: "In progress", num: true, render: (r) => String(r.partial) },
      { label: "Notes", num: true, render: (r) => String(r.notes) },
      { label: "Molecules done", num: true, render: (r) => String(r.molecules) },
      { label: "Working on", render: (r) => (r.active ? pretty(r.active) : el("span", { className: "dim", textContent: "–" })) },
      { label: "Last active", render: (r) => (r.last ? el("span", { title: fmtDate(r.last), textContent: ago(r.last) }) : "–") },
    ],
    rows,
    "No reviewers yet."
  ));
}

function renderRecent(rows) {
  const list = $("adm-recent");
  if (!rows.length) {
    list.replaceChildren(el("li", { className: "empty dim", textContent: "No scores saved yet." }));
    return;
  }
  list.replaceChildren(...rows.map((r) => {
    const complete = r.criteria >= ctx.criteria.length;
    return el("li", {}, [
      el("span", { className: `dot ${complete ? "ok" : "part"}`, title: complete ? "All criteria scored" : `${r.criteria}/${ctx.criteria.length} criteria` }),
      el("div", { className: "act-body" }, [
        el("span", {}, [el("b", { textContent: `@${r.reviewer}` }), ` · ${pretty(r.molecule)}`]),
        el("span", { className: "tiny dim", textContent: r.name || r.reaction_id }),
      ]),
      el("span", { className: "tiny dim when", title: fmtDate(r.at), textContent: ago(r.at) }),
    ]);
  }));
}

/* -------------------------------------------------------------- export --- */

function exportCard() {
  const all = el("button", { className: "btn primary big", type: "button", id: "adm-export-all" });
  setLabel(all, "Download all (.zip)", "file-zipper");
  all.addEventListener("click", () => exportAll(all));

  return el("section", { className: "card export" }, [
    el("div", { className: "card-h" }, [
      el("h2", {}, [icon("database"), " Export the database"]),
      el("span", { className: "tiny dim", textContent: "CSV, UTF-8" }),
    ]),
    el("p", {
      className: "muted tiny",
      textContent: "The zip has every review table as-is, plus expert_reaction_scores_wide.csv: one row per " +
        "reviewer × reaction with a column per criterion and the reviewer's note, ready for analysis.",
    }),
    all,
    el("div", { className: "table-btns", id: "adm-tables" }),
  ]);
}

function renderTables(sizes) {
  const box = $("adm-tables");
  const btn = (name, label, rows, fetcher) => {
    const b = el("button", { className: "btn ghost small", type: "button" }, [
      icon("file-csv"), ` ${label}`, rows != null ? el("span", { className: "count", textContent: String(rows) }) : null,
    ]);
    b.title = `Download ${name}.csv`;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const { columns, rows: data } = await fetcher();
        download(new Blob([toCSV(columns, data)], { type: "text/csv;charset=utf-8" }), `${name}.csv`);
        fx.toast(`${name}.csv · ${data.length} rows`, { icon: "download", kind: "ok" });
      } catch (err) {
        fx.toast(err.message, { kind: "err", icon: "triangle-exclamation" });
      } finally {
        b.disabled = false;
      }
    });
    return b;
  };
  box.replaceChildren(
    ...sizes.map((t) => btn(t.table, t.table, t.rows, () => db.dumpTable(t.table))),
    btn("expert_reaction_scores_wide", "reaction scores (wide)", null, () => db.reactionScoresWide(ctx.criteria)),
  );
}

async function exportAll(button) {
  button.disabled = true;
  const say = (text) => button.replaceChildren(icon("spinner", "fa-spin"), ` ${text}`);
  try {
    say("Loading zip library…");
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    const tables = await db.listTables();
    const jobs = [
      ...tables.map((t) => [t, () => db.dumpTable(t)]),
      ["expert_reaction_scores_wide", () => db.reactionScoresWide(ctx.criteria)],
    ];
    const counts = [];
    for (const [k, [name, fetcher]] of jobs.entries()) {
      say(`Exporting ${k + 1}/${jobs.length}…`);
      const { columns, rows } = await fetcher();
      zip.file(`${name}.csv`, toCSV(columns, rows));
      counts.push(`${name}.csv`.padEnd(36) + `${rows.length} rows`);
    }
    zip.file("README.txt", [
      "ASTRA expert review -- database export",
      `Exported: ${new Date().toISOString()} by @${ctx.username}`,
      `Networks: ${ctx.model} + ${ctx.config}, ${ctx.manifest.networks.length} molecules, ${ctx.totalReactions} reactions`,
      `Criteria (0-5): ${ctx.criteria.join(", ")}`,
      "",
      ...counts,
      "",
      "expert_scores rows with scope = 'network' are from the earlier network-level version.",
      "expert_reactions.payload is the reaction JSON as shown to reviewers.",
      "",
    ].join("\n"));
    say("Compressing…");
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const name = `astra_expert_review_${stamp()}.zip`;
    download(blob, name);
    fx.toast(`${name} downloaded`, { icon: "download", kind: "ok", ms: 4000 });
    fx.sound.success();
  } catch (err) {
    fx.toast(err.message, { kind: "err", icon: "triangle-exclamation" });
  } finally {
    button.disabled = false;
    setLabel(button, "Download all (.zip)", "file-zipper");
  }
}

let jszip = null;
/** JSZip from cdnjs, loaded only when an admin first exports. */
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  jszip ||= new Promise((resolve, reject) => {
    const s = el("script", { src: JSZIP_URL, crossOrigin: "anonymous", referrerPolicy: "no-referrer" });
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => { jszip = null; reject(new Error("Could not load the zip library. Check your connection.")); };
    document.head.append(s);
  });
  return jszip;
}

/* ------------------------------------------------------------- helpers --- */

/**
 * RFC 4180 CSV with a UTF-8 BOM, so Excel opens names like "α-ketoglutarate"
 * correctly. jsonb cells are written as JSON, timestamps as ISO 8601, null as empty.
 */
export function toCSV(columns, rows) {
  const cell = (v) => {
    if (v == null) return "";
    if (v instanceof Date) v = v.toISOString();
    else if (typeof v === "object") v = JSON.stringify(v);
    else v = String(v);
    return /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lines = [columns.map(cell).join(",")];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function table(cols, rows, emptyText) {
  if (!rows.length) return el("p", { className: "dim tiny empty", textContent: emptyText });
  return el("table", { className: "grid" }, [
    el("thead", {}, [el("tr", {}, cols.map((c) =>
      el("th", { className: [c.num && "num", c.wide && "wide"].filter(Boolean).join(" "), textContent: c.label })))]),
    el("tbody", {}, rows.map((r) => el("tr", {}, cols.map((c) =>
      el("td", { className: [c.num && "num", c.wide && "wide"].filter(Boolean).join(" ") }, [c.render(r)]))))),
  ]);
}

function meter(n, of, text) {
  const pct = of ? (n / of) * 100 : 0;
  const m = el("span", { className: "meter" }, [
    el("span", { className: "meter-bar" }, [el("i")]),
    el("span", { className: "meter-t", textContent: text }),
  ]);
  m.querySelector("i").style.width = `${pct}%`;
  m.classList.toggle("full", pct >= 100);
  return m;
}

function chip(ic, kind, n, title) {
  return el("span", { className: `mini ${kind}${n ? "" : " zero"}`, title: `${title}: ${n}` }, [icon(ic), ` ${n}`]);
}

function hue(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

const asDate = (v) => (v instanceof Date ? v : new Date(String(v).replace(" ", "T").replace(/\+00$/, "Z")));
function fmtDate(v) {
  const d = asDate(v);
  return Number.isNaN(+d) ? String(v) : d.toLocaleString();
}
function ago(v) {
  const d = typeof v === "number" ? v : +asDate(v);
  if (Number.isNaN(d)) return "–";
  const s = Math.max(0, (Date.now() - d) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
