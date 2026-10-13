# ASTRA Expert Review Platform

A static review platform where domain experts score ASTRA's prebiotic synthesis
networks: five criteria per reaction, seven for the network overall, each 0–10,
plus optional free text. Reactions are presented one at a time as a slide deck,
with a popup showing the whole network as a graph. Runs as plain JavaScript on
GitHub Pages with no backend; submissions go straight to PlanetScale Postgres.

## What is under review

| | |
|---|---|
| Models | `claude_opus4.6`, `gpt5.4` |
| Configs | `deep_research_claude`, `deep_research_gpt5.4` |
| Molecules | the 9 covered by all four model×config cells |
| Queue | **36 networks, 615 reactions** (4 cells × 9 molecules, final networks only) |

Per reaction (5 criteria): Chemical Feasibility, Environmental Consistency,
Mechanistic Detail, Prebiotic Plausibility, Novelty of Reactions.
Per network (7 criteria): the above plus Pathway Coherence and Network Completeness —
the canonical set from `pathway_explorer/meta_evaluations/all_scores.csv`, so expert
scores sit alongside the LLM-judge scores on a near-identical scale: those are
integers 1–10, these are 0–10 (0 is available to a human reviewer as an explicit
"not plausible at all", which the judges' 1–10 scale cannot express).

The slider is `step=1` with 11 tick dots, one per selectable value. Changing the
scale means changing `SCORE_MAX` in both `js/app.js` and `js/db.js`; the dot count
follows automatically. The table's `CHECK (score between 0 and 100)` is inherited
from the original schema and still passes — 0–10 is a subset — and cannot be
tightened without an owner-level `ALTER TABLE`.

Reviewers see networks as **Network A–D** with the model and config hidden. The
label→cell permutation is derived per molecule from a SHA-256 of the molecule name,
so the mapping differs for every molecule and cannot be learned. Copied data files
are named `<Molecule>_<Label>.json` so the filename gives nothing away either.

**Blinding is UI-level only.** The page must send the true model/config to the
database, so `data/review_index.json` necessarily contains the mapping. It stops a
reviewer *seeing* provenance while scoring; it is not secrecy from someone reading
the source.

## Signing in

Reviewers identify themselves with a **username** (lowercase, no spaces, e.g.
`jane_doe`), not a display name. It is normalised with `trim().toLowerCase()` at
sign-in, so `Jane_Doe` and `jane_doe` are the same reviewer. This matters: scores
are keyed on this string, and before the normalisation a reviewer who capitalised
differently silently started over with an empty slate and split their data across
two identities.

Signing in restores every score, note and submission, then jumps to the first
network still unsubmitted and the first reaction in it still missing a score.

The username lives in the `reviewer_name` column — the column was not renamed
because the API role is not the table owner and cannot `ALTER TABLE`. If you have
rows from before this change, migrate them (`UPDATE` is allowed by
`pg_write_all_data`, so no console trip is needed):

```sql
update expert_scores      set reviewer_name = '<username>' where reviewer_name = '<Old Name>';
update expert_comments    set reviewer_name = '<username>' where reviewer_name = '<Old Name>';
update expert_submissions set reviewer_name = '<username>' where reviewer_name = '<Old Name>';
```

## Navigating

- **Chips** above the slide jump to any reaction; green = fully scored, amber = partial.
- **Prev/Next** and the **left/right arrow keys** page the deck. Arrows are ignored
  while a slider or note has focus, so they still nudge the value and move the caret.
- Completing all five criteria on a reaction **auto-advances** after ~0.9 s to the next
  unscored one. It is skipped if you are typing in a note or have the graph open —
  checked when the timer fires, not only when it is set, because the save round-trips
  to the database and the timer is often created after you have already clicked away.
- The last slide is the seven-criteria overall assessment and the submit button.
- **View network graph** opens the whole network. The current reaction is outlined;
  *Focus this reaction* dims everything outside its neighbourhood. Click any reaction
  node to jump to its slide. Esc or a backdrop click closes it.

## Setup

### 1. Create the tables (one-time, needs an elevated credential)

The API credential in `planetscale.txt` holds `pg_write_all_data` but **cannot create
tables** — verified:

```
select has_schema_privilege('public','CREATE');   -->  false
create table t (id int);                          -->  42501 permission denied for schema public
create schema astra_review;                       -->  42501 permission denied for database postgres
```

So run `schema.sql` once from the **PlanetScale console SQL editor**, or with a
password for the `postgres` role. It creates `expert_scores`, `expert_comments`,
`expert_submissions` and — importantly — `GRANT`s `select, insert, update, delete`
to the API role. The grant of `SELECT` is required: `pg_write_all_data` does not
include it, and the app reads its own rows back to restore a reviewer's progress.

Verify afterwards:

```sql
select has_table_privilege('pscale_api_y1qbjsmef33x','expert_scores','INSERT'),
       has_table_privilege('pscale_api_y1qbjsmef33x','expert_scores','SELECT');
-- both must be true
```

### 2. Rebuild the queue (only if the source networks change)

```bash
python3 expert_review/tools/build_review_index.py
```

Reads `../pathway_explorer/file_index.csv`, copies the 36 networks into
`data/networks/`, and writes `data/review_index.json`.

### 3. Run locally

```bash
cd /path/to/astraagents.github.io
python3 -m http.server 8000
# open http://localhost:8000/expert_review/
```

Must be served over HTTP — `file://` will not load the ES modules.

## Architecture

```
index.html          login + app shell
css/review.css      light palette, token values from pathway_explorer/css/theme.css
js/app.js           slide deck, resume position, form state, debounced autosave
js/db.js            THE ONLY DATABASE SEAM
js/graph.js         glue to the graph renderer (~110 lines)
js/vendor/
  neon-serverless.js  @neondatabase/serverless 1.2.0, vendored ESM bundle
js/vendor-graph/    utils.js, data-loader.js, graph-layout.js, cytoscape-bridge.js
                    copied VERBATIM from pathway_explorer/js/ -- do not edit here;
                    re-copy from the explorer if it changes
data/review_index.json, data/networks/*.json
tools/build_review_index.py
schema.sql
```

### Why WebSockets and not HTTP

PlanetScale's Neon-compatible HTTP endpoint works from a server but **not from a
browser**: `POST https://<host>/sql` returns no `Access-Control-Allow-*` headers and
answers `OPTIONS` with `405 {"message":"/sql requires POST"}`. Since the driver sends
a custom `Neon-Connection-String` header, the preflight is mandatory and always fails.

The WebSocket proxy does work — `wss://<host>/v2?address=<host>:5432` returns
`101 Switching Protocols` even with a cross-origin `Origin`, because WebSockets are
exempt from CORS. So `js/db.js` uses `Pool` in WebSocket mode:

```js
neonConfig.wsProxy = (host, port) => `${host}/v2?address=${host}:${port}`;
neonConfig.pipelineConnect = false;   // mandatory: PlanetScale uses SCRAM-SHA-256
```

Writes are `INSERT … ON CONFLICT ON CONSTRAINT … DO UPDATE`, so a reviewer can revise
any score without creating duplicate rows. Clearing a slider **deletes** the row
rather than storing a 0, and sliders start in an explicit unset state (`--`) so an
untouched criterion is never recorded as a real score.

## The network graph

`js/vendor-graph/` holds four files copied unmodified from `pathway_explorer/js/`.
They are classic scripts on `window.SynthVis`, so they load in dependency order
before `app.js`, and need only cytoscape 3.30.4 from the CDN — `dagre`,
`cytoscape-dagre` and `cytoscape-svg` are used solely by the explorer's
`figure-mode.js` / `export.js`, which are not copied.

`js/graph.js` drives them with the explorer's own render sequence
(`computeLayout` → `buildCytoscapeElements` → `cy.json` → `fit`), using
`SV.loadFromPaths(file, null, null)` to convert the raw network JSON into the
normalized model the renderer expects. Two things to know if you touch it:

- **Cytoscape measures its container on init** and silently renders 0×0 if it is
  hidden, so the modal is revealed before the graph is built, and `cy.resize()`
  runs on every open.
- **`main.js` is deliberately NOT copied.** It holds `MODEL_LABELS` /
  `CONFIG_LABELS` (`'claude_opus4.6': 'Claude Opus 4.6 Extended Thinking'`) and
  would reveal the authorship this tool hides. The four copied files contain no
  model or config strings — node labels come only from the network JSON.

PubChem structure images (`pubchem.js`) are not copied either: they fire one
external request per molecule. `loadPubChemImages` is null-guarded, so omitting it
just gives plain nodes.

## Before publishing

1. **Never commit credentials in `index.html`.** The two database inputs ship with
   `placeholder` only; reviewers paste their own. If you temporarily add `value="…"`
   for local testing, strip it before committing. Check with:
   ```bash
   grep -n 'value="pscale_' index.html    # must return nothing
   ```
2. `planetscale.txt` is in `.gitignore` — confirm with
   `git check-ignore -v expert_review/planetscale.txt`. **Never commit it.**
3. Credentials entered by a reviewer are kept in memory and their name in
   `sessionStorage`; nothing is persisted to disk.

### Hardening further

Every reviewer who signs in holds `pg_write_all_data` on the whole database. For a
small trusted panel that may be acceptable; to remove it, put a serverless proxy
(e.g. a Cloudflare Worker) in front: keep the credentials in the Worker's secrets,
give it CORS headers and a per-reviewer token, and rewrite the four exported
functions in `js/db.js` as `fetch()` calls. Nothing else in the app changes —
`db.js` is the only file that touches the database.

## Exporting results

```sql
select reviewer_name, model, molecule, run, config, scope, reaction_id, criterion, score
  from expert_scores
 order by reviewer_name, molecule, config, scope, reaction_id, criterion;
```

The `network`-scope rows line up column-for-column with `all_scores.csv`
(`Model,Molecule,Run,Config,Criterion,Score`) once `scope`/`reaction_id` are dropped.
