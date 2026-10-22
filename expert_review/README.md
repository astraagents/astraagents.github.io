# ASTRA Expert Review Platform

A static, mobile-first review platform where domain experts score ASTRA's prebiotic
synthesis networks **one reaction at a time**: three questions, each scored 0–5, plus an
optional note. Each reviewer is assigned a molecule, works through its reactions as
cards, and climbs a shared leaderboard. It runs as plain JavaScript on GitHub Pages
with no backend. The reactions live in PlanetScale Postgres and submissions go
straight there.

## What is under review

| | |
|---|---|
| Network | `gpt6_xhigh_azure` + `deep_research_gpt6` (`network_<Mol>_<timestamp>_deep_research_gpt6_run1.json`) |
| Molecules | Arginine, Glutamate, Glycine, Histidine, L-Alanine, L-Proline, Serine, Threonine, Valine |
| Queue | **9 networks, 166 reactions**, stored in `expert_reactions` |

Criteria per reaction (3), each asked as a question:

| Criterion (stored as) | Question shown |
|---|---|
| Reaction Detail Validity | Are the reaction details chemically valid and justified? |
| Geochemical Realism | Are the conditions realistic for the stated early-Earth environment? |
| Reaction Novelty | How novel is this reaction? |

They are adapted from the reaction-level LLM-judge criteria in `GeminiJudgePrompt.md`,
with Chemical Feasibility and Reaction Justification merged into Reaction Detail
Validity (Pathway Coherence, Environmental Consistency and Network Completeness stay
network-level). Each question shows a one-line description, and its **(?)** button
expands an anchor for every score 0–5 (`CRITERION_GUIDE` in `js/app.js`). The judges
score 1–10; humans score 0–5, so compare them after rescaling.

Scores saved under earlier criteria stay in the database and are ignored: the v3
set (Environmental Consistency, Mechanistic Detail, Prebiotic Plausibility, Novelty of
Reactions) and the 0–10 set that preceded this one (Chemical Feasibility, Reaction
Justification, Geochemical Condition Realism, Novelty of Reaction). The new names are
deliberately different so no 0–10 score is read on the 0–5 scale.

Scores are entered with **6 tap pills (0–5)**. Tapping the selected pill again
clears it, which *deletes* the row rather than storing a 0. Changing the scale means
changing `SCORE_MAX` in both `js/app.js` and `js/db.js`, and the CHECK in `schema.sql`
(which still allows 0–10 for the older rows).

Network-level scoring and the Naive network (formerly "Network B") were removed in v3.
Their rows (`scope = 'network'`) stay in the database and are ignored.

## How reviewers experience it

1. **Invite link → username + password.** The link carries the database credentials
   (see below), which the device keeps, so the link is only needed once per device.
   The reviewer picks a username and password; on the same device they go straight
   back in until they sign out, and after that only need their password.
2. **Assignment.** They are given one molecule (see *Assignment* below), with an intro
   card showing its size and the time it will take. *"Not my area? Swap molecule"* draws another.
3. **Reaction cards.** Each card shows the equation as 2D structures from PubChem
   (with names and formulae; see *Molecular structures*), then the setting,
   conditions, agents, mechanism and reasoning, and a *View in network* button that opens
   the Pathway Explorer focused on that reaction. Scores autosave ~0.6 s after a tap.
   *Save & next* unlocks once all three are set and moves to the next unscored reaction.
   *Skip for now* moves on without saving. The progress segments jump to any reaction.
4. **Finishing a molecule** marks it done, celebrates, and shows the reviewer's mean
   per criterion **next to the other reviewers' mean**. That comparison only appears
   after they finish, so it cannot anchor their own scores. Then the next molecule is assigned.

Keyboard on desktop: `Enter` = Save & next, `←`/`→` = previous/next reaction, and arrow
keys move within a row of pills.

### Engagement design

The page is built to keep busy experts coming back without rewarding speed over care:

| Mechanism | Where |
|---|---|
| Small, finite goal ("Glycine · 20 reactions · ~15 min") and a progress ring | intro card |
| Unfinished-task pull ("You're 65% through, just 7 left") | intro on return; a *"So close!"* prompt on sign-out with ≤ 5 left |
| Immediate feedback: score-pitched tick, chime, confetti burst, `+1` | every tap / save |
| Leaderboard ranked by *completed* reactions, with "N more to pass @x" | left rail (desktop), trophy-button drawer (phone) |
| "You passed @bob" / "You're on the board" moments | toast after a save |
| Badges at 1, 5, 10, 25, 50, 100 reactions, 1/3/9 molecules, 5 notes | rail |
| Session streak (flame + n) | top bar |
| Shared mission: panel progress toward 3 reviews × 166 reactions | rail |
| Curiosity reward: your scores vs the panel's, unlocked on finishing | finish card |

Sound is synthesised with WebAudio (no audio files) and can be muted with the speaker button (saved
per device). Phones that support it get a light haptic tick. `prefers-reduced-motion`
turns off slides and confetti. Light and dark themes follow the OS. Icons are
Font Awesome 6.5.2 (free, solid), loaded from cdnjs; there are no emoji in the UI.

## Molecular structures

Each molecule in a reaction card is drawn from PubChem's 2D depiction. Two parts make it work:

- **Offline, by CID.** `tools/resolve_pubchem.py` resolves each molecule once, trying
  its **InChI** first (the network's own structural claim), then its IUPAC name, then its
  common name. It checks the hit against the network's stated formula on heavy atoms only,
  so protonation and charge differences (formate vs formic acid) don't count. Results go to
  `data/pubchem.json` and reach the page through `expert_reactions.payload`. The page
  never looks molecules up by name: those lookups are rate-limited and often 404 on the
  networks' descriptive names. Current state: **96 of 115 resolved**. The other 19 are
  intermediates and adducts that PubChem does not have (e.g. *Arginine alpha-aminonitrile*,
  *Glycolaldehyde bisulfite adduct*), and they show a formula tile instead.
- **Cropped in the browser.** PubChem pads every drawing to the full canvas on a grey
  background with 1px bonds, which leaves small molecules as a faint speck. The page fetches
  the 500×500 PNG by CID (PubChem sends `Access-Control-Allow-Origin: *`), crops it to the
  drawn pixels, whitens the background and deepens the ink, and caps the zoom so NH₃ still looks
  small next to arginine. Compounds PubChem draws as an empty canvas (H₂, whose hydrogens are
  implicit) fall back to the formula. At most 4 requests are in flight at once (PubChem allows ~5/s),
  and the next reaction's structures are preloaded.

Tapping a structure opens the compound on PubChem. When the PubChem structure's formula
disagrees with the network's stated formula, the card shows a warning, **PubChem: <formula>**.
That flags a genuine inconsistency in the network's own data. No molecule in the current
queue triggers it. The check is redone against the current networks on every run, because
`pubchem.json` caches lookups by structure and the same InChI can carry a different stated
formula in another network.

## Assignment

`db.assignNetwork` gives a reviewer the network with the **fewest other reviewers**
(status `done`, or `active` and touched in the last 14 days), breaking ties at random.
Candidates are networks the reviewer has not finished or skipped. When none are left,
skipped ones come back. A reviewer has at most one `active` assignment. Swapping marks
the current one `skipped` (their scores are kept and still count). Finishing marks it `done`.
Assignments live in `expert_assignments`, so the spread is visible in the data:

```sql
select molecule, status, count(*) from expert_assignments group by 1, 2 order by 1, 2;
```

## Admin dashboard

Sign in with the username **`admin_123`** and its password (the first sign-in sets it; constant `ADMIN_USERNAME` in `js/app.js`) to open
the admin view (`js/admin.js`) instead of the review flow. The admin is never assigned a molecule,
never scores, and doesn't appear on the leaderboard. The view refreshes every 30 s and has a
Refresh button. It shows:

- **KPIs:** complete reviews out of the goal (166 × 3), reactions with ≥ 1 complete review,
  reactions at the goal, active reviewers, partly scored reactions, and notes.
- **Molecules:** reactions, complete reviews, a coverage bar, reactions at goal, and assignments
  active/done/skipped. This shows whether the assignment is spreading work evenly.
- **Reviewers:** complete and in-progress reactions, notes, molecules done, the current molecule,
  and last activity.
- **Recent activity:** the last 15 reactions saved.
- **Export:** *Download all (.zip)* builds `astra_expert_review_<date>_<time>.zip` in the browser,
  containing every `expert_*` table as CSV (except `expert_accounts`, which holds password hashes), `expert_reaction_scores_wide.csv` (one row per reviewer ×
  reaction, one column per criterion, plus the note) and a `README.txt` with row counts. There are
  also per-table buttons for single CSVs. Tables are discovered from `information_schema`, so new
  `expert_*` tables are exported automatically. The CSVs are RFC 4180 with a UTF-8 BOM (Excel-safe);
  `jsonb` is written as JSON and timestamps as ISO 8601. JSZip 3.10.1 loads from cdnjs only on the
  first zip export.

**This is a convenience switch, not access control.** The username is visible in the public JS, and
every reviewer already holds the database credentials, so they can read everything the dashboard
shows anyway. To make admin access real, use the proxy described in *Hardening further*.

## Setup

### 1. Create the tables (one-time, needs an elevated credential)

The API credential in `planetscale.txt` holds `pg_write_all_data` but **cannot create
tables**. Verified:

```
select has_schema_privilege('public','CREATE');   -->  false
create table t (id int);                          -->  42501 permission denied for schema public
```

So run `schema.sql` once from the **PlanetScale console SQL editor**. It is safe to
re-run: every statement is `if not exists`. v3 adds `expert_reactions` and
`expert_assignments`. It also `GRANT`s `select, insert, update, delete` on all five
tables to the API role. `SELECT` is required: `pg_write_all_data` does not include it,
and the app reads rows back for progress and the leaderboard.

```sql
select has_table_privilege('pscale_api_y1qbjsmef33x','expert_reactions','INSERT'),
       has_table_privilege('pscale_api_y1qbjsmef33x','expert_assignments','SELECT');
-- both must be true
```

### 2. Build the queue and load the reactions

```bash
python3 expert_review/tools/build_review_index.py   # writes data/review_index.json
python3 expert_review/tools/resolve_pubchem.py      # writes data/pubchem.json (cached; --refresh to redo)
python3 expert_review/tools/seed_reactions.py       # upserts 166 rows into expert_reactions
```

`seed_reactions.py` stores each reaction's raw JSON as `payload`, with `inputs` and
`outputs` resolved to `{id, formula, name, role, cid, cid_match, pubchem_formula}`. It is
idempotent, so re-run it whenever the source networks or `pubchem.json` change. It uses the
API credential (inserts are allowed).

### 3. Invite reviewers

```bash
python3 expert_review/tools/make_invite.py                     # GitHub Pages URL
python3 expert_review/tools/make_invite.py http://localhost:8000/expert_review/
```

This prints `…/expert_review/#k=<base64url(user:password)>`. The credentials sit in the
URL **fragment**, which browsers never send to a server, so they never reach GitHub
Pages' logs or this repo. The page moves them into `localStorage` and strips the
fragment from the address bar. **Send the link privately; it is a password.**
*Sign out* forgets the reviewer's password on that device but keeps the database
credentials, so signing back in needs no invite link.

Without a link, the login form has an *"I have database credentials"* fallback. For
local testing, `js/local-creds.js` (gitignored) prefills those two fields.

### 4. Run locally

```bash
cd /path/to/astraagents.github.io
python3 -m http.server 8000
# open the link from make_invite.py with http://localhost:8000/expert_review/
```

It must be served over HTTP: `file://` will not load the ES modules.

## Signing in

Reviewers identify themselves with a **username** (2–32 of `a-z 0-9 _ . -`), shown on
the leaderboard. It is normalised with `trim().toLowerCase()`, so `Jane_Doe` and
`jane_doe` are the same reviewer. Scores are keyed on this string. It lives in the
`reviewer_name` column; the column was not renamed because the API role cannot `ALTER TABLE`.

Each username is protected by a **password** (at least 6 characters), stored in
`expert_accounts`. The first sign-in under a username sets it, including for reviewers
who scored before passwords existed. The browser hashes it with PBKDF2-SHA256 (200,000
iterations, random 16-byte salt) and only the salt and hash reach the database. The
device remembers the hash so a returning reviewer signs in on their own; *Sign out*
forgets it. To reset a forgotten password, delete the row
(`delete from expert_accounts where reviewer_name = 'jane_doe'`); the next sign-in sets
a new one.

This stops reviewers signing in as each other through the page. It is not real access
control: everyone holds the same database credentials, so anyone determined could read
or change rows directly (see *Hardening further*).

## Architecture

```
index.html             login, top bar, left rail (leaderboard, stats, badges), stage, sheets
explorer.html          pathway_explorer/index.html markup + <base href="../pathway_explorer/">
css/review.css         mobile-first styles; light + dark tokens
css/explorer-embed.css hides the explorer's toolbar, settings and eval panel
js/app.js              sign-in, assignment flow, reaction cards, scoring, leaderboard, badges
js/admin.js            admin dashboard (admin_123): status, CSV / zip export
js/dom.js              small DOM helpers shared by app.js and admin.js
js/db.js               THE ONLY DATABASE SEAM
js/fx.js               WebAudio sounds, confetti, toasts, haptics
js/explorer-shim.js    serves explorer.html a one-row file_index.csv
js/explorer-sidebar.js reaction sidebar from raw JSON; ?focus= / postMessage focusing
js/local-creds.js      local testing only, gitignored
js/vendor/
  neon-serverless.js   @neondatabase/serverless 1.2.0, vendored ESM bundle
data/review_index.json the 9 networks + the 3 criteria
data/pubchem.json      molecule (InChI or names) -> PubChem CID, formula check
tools/
  build_review_index.py  manifest
  resolve_pubchem.py     molecules -> PubChem CIDs
  seed_reactions.py      reactions (+ CIDs) -> expert_reactions
  make_invite.py         invite links
  export_reviews.py      CSV export
  pscale.py              shared credentials + HTTP /sql helper for the tools
schema.sql, schema_reset.sql
```

### Tables

| Table | One row per | Written by |
|---|---|---|
| `expert_reactions` | reaction under review | `seed_reactions.py` |
| `expert_scores` | reviewer × reaction × criterion (`scope='reaction'`) | the page |
| `expert_comments` | reviewer × reaction note | the page |
| `expert_assignments` | reviewer × network, `active`/`skipped`/`done` | the page |
| `expert_accounts` | reviewer username: password salt + hash | the page |
| `expert_submissions` | *(v2 network submissions, unused since v3)* | n/a |

The leaderboard counts, per reviewer, the reactions with **all three** criteria scored:

```sql
select reviewer_name, count(*) from (
  select reviewer_name, molecule, reaction_id from expert_scores
   where scope = 'reaction' and criterion = any(array['Reaction Detail Validity',
                                'Geochemical Realism', 'Reaction Novelty'])
   group by 1, 2, 3 having count(distinct criterion) = 3) t
 group by 1 order by 2 desc;
```

### Why WebSockets and not HTTP

PlanetScale's Neon-compatible HTTP endpoint works from a server but **not from a
browser**: `POST https://<host>/sql` returns no `Access-Control-Allow-*` headers and
answers `OPTIONS` with `405 {"message":"/sql requires POST"}`. Since the driver sends
a custom `Neon-Connection-String` header, the preflight is mandatory and always fails.
(The Python tools use that HTTP endpoint, which is fine outside a browser.)

The WebSocket proxy does work: `wss://<host>/v2?address=<host>:5432` returns
`101 Switching Protocols` even with a cross-origin `Origin`, because WebSockets are
exempt from CORS. So `js/db.js` uses `Pool` in WebSocket mode:

```js
neonConfig.wsProxy = (host, port) => `${host}/v2?address=${host}:${port}`;
neonConfig.pipelineConnect = false;   // mandatory: PlanetScale uses SCRAM-SHA-256
```

Writes are `INSERT … ON CONFLICT ON CONSTRAINT … DO UPDATE`, so a reviewer can revise
any score without creating duplicate rows.

## The embedded explorer

Nothing in `pathway_explorer/` is modified or copied. *View in network* opens a sheet
with `explorer.html?f=<network>&v=<validation>&m=<molecule>&focus=<reaction id>`:

- `explorer.html` is the explorer's own markup with `<base href="../pathway_explorer/">`,
  so every relative URL in its unmodified JS and CSS resolves exactly as it does there.
- `js/explorer-shim.js` answers the explorer's `file_index.csv` request with a single
  row built from the query string, so `main.js` auto-loads that one network.
- `js/explorer-sidebar.js` rewrites the reaction sidebar from the raw JSON fields, and
  focuses the requested reaction: it opens its details, centres on it and dims all but
  its inputs/outputs. While the sheet stays loaded, later reactions are focused via
  `postMessage({type: "astra-focus", id})` with no reload.
- If `pathway_explorer/index.html` gains new markup, re-copy it into `explorer.html`
  and keep the four added lines (base, embed CSS, shim, sidebar).

## Before publishing

1. **Never commit credentials.** The two database inputs in `index.html` ship with
   `placeholder` only. Check with:
   ```bash
   grep -rnE 'pscale_pw_[A-Za-z0-9]{8}' expert_review --exclude=planetscale.txt --exclude=local-creds.js   # must return nothing
   ```
2. `planetscale.txt` and `js/local-creds.js` are in `.gitignore`. Confirm with
   `git check-ignore -v expert_review/planetscale.txt expert_review/js/local-creds.js`.
3. Credentials from an invite link are kept in the reviewer's `localStorage`, also after
   they sign out. Clearing the site's data removes them.

### Hardening further

Every reviewer holds `pg_write_all_data` on the whole database. For a small, trusted
panel that may be acceptable. To remove it, put a serverless proxy (e.g. a Cloudflare
Worker) in front: keep the credentials in the Worker's secrets, give it CORS headers
and a per-reviewer token, and rewrite the exported functions in `js/db.js` as
`fetch()` calls. Nothing else in the app changes, because `db.js` is the only file
that touches the database.

## Exporting results

```bash
python3 expert_review/tools/export_reviews.py
```

This writes `exports/` (gitignored): `expert_scores.csv` (long format),
`expert_reaction_scores.csv` (one row per reviewer × reaction, one column per criterion,
plus the note), `expert_comments.csv` and `expert_assignments.csv`.
