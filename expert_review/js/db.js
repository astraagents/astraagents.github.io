/**
 * The only module in this app that talks to the database.
 *
 * Why WebSockets and not HTTP: PlanetScale's `/sql` endpoint (the Neon HTTP/fetch
 * transport) sends no CORS headers and answers OPTIONS with 405, so a browser
 * preflight for the `Neon-Connection-String` header always fails. The WebSocket
 * proxy at wss://<host>/v2 accepts cross-origin connections -- WebSockets are
 * exempt from CORS -- so that is the only transport that works from a static page.
 *
 * To move the credentials off the client later, replace the exported functions
 * below with fetch() calls to a serverless proxy. Nothing else in the app
 * touches the database.
 */

import { Pool, neonConfig } from "./vendor/neon-serverless.js";

const HOST = "aws-us-east-1-5.pg.psdb.cloud";
const PORT = 5432;
const DATABASE = "postgres";

// Scores are 0-10, matching the table's CHECK. Keep in step with js/app.js.
const SCORE_MAX = 10;

neonConfig.wsProxy = (host, port) => `${host}/v2?address=${host}:${port}`;
// Mandatory for PlanetScale: it authenticates with SCRAM-SHA-256, which cannot be
// pipelined with the connection startup.
neonConfig.pipelineConnect = false;
neonConfig.useSecureWebSocket = true;
// We already tell the reviewer their credentials stay in this tab; the driver's
// own console warning on top of that is just noise.
neonConfig.disableWarningInBrowsers = true;

/** @type {import('./vendor/neon-serverless.js').Pool | null} */
let pool = null;

/** Columns identifying one network, shared by every table. */
const META_COLS = ["model", "molecule", "config", "run", "attempt"];

function metaValues(meta) {
  return [meta.model, meta.molecule, meta.config, meta.run, meta.attempt ?? ""];
}

/**
 * Open the pool and prove the credentials work before the UI leaves the login
 * screen. Throws with a human-readable message if it cannot connect.
 */
export async function connect({ user, password }) {
  await disconnect();

  const connectionString =
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${HOST}:${PORT}/${DATABASE}`;

  pool = new Pool({ connectionString });
  pool.on("error", (err) => console.error("[db] idle client error:", err));

  try {
    await pool.query("select 1");
  } catch (err) {
    await disconnect();
    throw new Error(describe(err));
  }
}

export async function disconnect() {
  if (!pool) return;
  const old = pool;
  pool = null;
  try {
    await old.end();
  } catch {
    /* already gone */
  }
}

export function isConnected() {
  return pool !== null;
}

function requirePool() {
  if (!pool) throw new Error("Not connected to the database.");
  return pool;
}

/** Run a query, rewriting driver/Postgres errors into reviewer-readable ones. */
async function run(sql, params) {
  try {
    return await requirePool().query(sql, params);
  } catch (err) {
    throw new Error(describe(err));
  }
}

/** Turn driver/Postgres errors into something a reviewer can act on. */
function describe(err) {
  const msg = String(err?.message || err);
  if (/password authentication failed|SASL|SCRAM/i.test(msg)) {
    return "Database rejected those credentials. Check the username and password.";
  }
  if (/permission denied/i.test(msg)) {
    return (
      "Connected, but the role lacks permission on the review tables. " +
      "Has schema.sql been run, including its GRANT statements?"
    );
  }
  if (/relation .* does not exist/i.test(msg)) {
    return "The review tables do not exist yet. Run expert_review/schema.sql first.";
  }
  if (/WebSocket|ws:|network|failed to fetch/i.test(msg)) {
    return "Could not reach the database over WebSocket. Check your network connection.";
  }
  return msg;
}

/**
 * Upsert a batch of criterion scores for one network or one reaction.
 * `scores` maps criterion name -> integer 0-10. Criteria mapped to null or
 * undefined are deleted, so clearing a slider removes the row rather than
 * recording a zero.
 */
export async function saveScores(meta, scope, reactionId, scores) {
  requirePool();
  const rid = reactionId ?? "";

  const setEntries = [];
  const clearCriteria = [];
  for (const [criterion, score] of Object.entries(scores)) {
    if (score === null || score === undefined || score === "") {
      clearCriteria.push(criterion);
    } else {
      setEntries.push([criterion, Math.round(Number(score))]);
    }
  }

  for (const [, score] of setEntries) {
    if (!Number.isFinite(score) || score < 0 || score > SCORE_MAX) {
      throw new Error(`Score out of range: ${score}`);
    }
  }

  const base = metaValues(meta);

  if (setEntries.length) {
    // One multi-row INSERT .. ON CONFLICT so a whole card saves in a single round trip.
    const params = [...base, meta.reviewerName, scope, rid];
    const tuples = setEntries.map(([criterion, score]) => {
      params.push(criterion, score);
      return `($6, $1, $2, $3, $4, $5, $7, $8, $${params.length - 1}, $${params.length})`;
    });
    await run(
      `insert into expert_scores
         (reviewer_name, ${META_COLS.join(", ")}, scope, reaction_id, criterion, score)
       values ${tuples.join(", ")}
       on conflict on constraint expert_scores_key
       do update set score = excluded.score, updated_at = now()`,
      params
    );
  }

  if (clearCriteria.length) {
    await run(
      `delete from expert_scores
        where reviewer_name = $6 and model = $1 and molecule = $2 and config = $3
          and run = $4 and attempt = $5 and scope = $7 and reaction_id = $8
          and criterion = any($9)`,
      [...base, meta.reviewerName, scope, rid, clearCriteria]
    );
  }
}

/** Upsert free text; an empty body deletes the row. */
export async function saveComment(meta, scope, reactionId, body) {
  requirePool();
  const rid = reactionId ?? "";
  const params = [...metaValues(meta), meta.reviewerName, scope, rid];
  const text = (body ?? "").trim();

  if (!text) {
    await run(
      `delete from expert_comments
        where reviewer_name = $6 and model = $1 and molecule = $2 and config = $3
          and run = $4 and attempt = $5 and scope = $7 and reaction_id = $8`,
      params
    );
    return;
  }

  await run(
    `insert into expert_comments
       (reviewer_name, ${META_COLS.join(", ")}, scope, reaction_id, body)
     values ($6, $1, $2, $3, $4, $5, $7, $8, $9)
     on conflict on constraint expert_comments_key
     do update set body = excluded.body, updated_at = now()`,
    [...params, text]
  );
}

/**
 * Everything this reviewer has saved at reaction level, so returning restores
 * their scores and notes. Shape:
 *   { scores:   { "<netKey>|reaction|<reactionId>": { criterion: score } },
 *     comments: { "<netKey>|reaction|<reactionId>": body } }
 */
export async function loadProgress(reviewerName) {
  requirePool();
  const key = (r) => [
    [r.model, r.molecule, r.config, r.run, r.attempt].join("|"),
    r.scope,
    r.reaction_id,
  ].join("|");

  const [scoreRows, commentRows] = await Promise.all([
    run(
      `select ${META_COLS.join(", ")}, scope, reaction_id, criterion, score
         from expert_scores where reviewer_name = $1 and scope = 'reaction'`,
      [reviewerName]
    ),
    run(
      `select ${META_COLS.join(", ")}, scope, reaction_id, body
         from expert_comments where reviewer_name = $1 and scope = 'reaction'`,
      [reviewerName]
    ),
  ]);

  const scores = {};
  for (const r of scoreRows.rows) {
    (scores[key(r)] ||= {})[r.criterion] = r.score;
  }
  const comments = {};
  for (const r of commentRows.rows) {
    comments[key(r)] = r.body;
  }
  return { scores, comments };
}

/* ------------------------------------------------------------ reactions -- */

/** The reactions of one network, in network order, as seeded by seed_reactions.py. */
export async function loadReactions(meta) {
  const { rows } = await run(
    `select reaction_id, position, name, payload
       from expert_reactions
      where model = $1 and molecule = $2 and config = $3 and run = $4 and attempt = $5
      order by position`,
    metaValues(meta)
  );
  return rows.map((r) => ({
    id: r.reaction_id,
    position: r.position,
    name: r.name,
    ...(typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload),
  }));
}

/* ---------------------------------------------------------- assignments -- */

// An `active` assignment stops counting towards a molecule's coverage once the
// reviewer has not touched it for this long, so abandoned ones free it up again.
const STALE_ACTIVE = "14 days";

/** Every assignment row of this reviewer: [{ molecule, status, ... }]. */
export async function myAssignments(reviewerName) {
  const { rows } = await run(
    `select ${META_COLS.join(", ")}, status
       from expert_assignments where reviewer_name = $1
      order by updated_at desc`,
    [reviewerName]
  );
  return rows;
}

/**
 * Give the reviewer a network to review, spreading reviewers across molecules:
 * the candidate with the fewest *other* reviewers (done, or active recently)
 * wins, ties broken at random. Candidates are networks this reviewer has neither
 * finished nor skipped, falling back to skipped ones when nothing else is left.
 * Returns the chosen network from `networks`, or null when every one is done.
 */
export async function assignNetwork(reviewerName, networks, { exclude = null } = {}) {
  const [{ rows: coverRows }, mine] = await Promise.all([
    run(
      `select molecule, model, config, run, attempt, count(distinct reviewer_name)::int as n
         from expert_assignments
        where reviewer_name <> $1
          and (status = 'done' or (status = 'active' and updated_at > now() - $2::interval))
        group by molecule, model, config, run, attempt`,
      [reviewerName, STALE_ACTIVE]
    ),
    myAssignments(reviewerName),
  ]);

  const k = (r) => [r.model, r.molecule, r.config, r.run, r.attempt ?? ""].join("|");
  const cover = new Map(coverRows.map((r) => [k(r), r.n]));
  const status = new Map(mine.map((r) => [k(r), r.status]));

  const fresh = networks.filter((n) => !status.has(n.key) || status.get(n.key) === "active");
  const skipped = networks.filter((n) => status.get(n.key) === "skipped");
  let pool = fresh.filter((n) => n.key !== exclude);
  if (!pool.length) pool = skipped.filter((n) => n.key !== exclude);
  if (!pool.length) pool = fresh.concat(skipped);      // only the excluded one is left
  if (!pool.length) return null;

  const least = Math.min(...pool.map((n) => cover.get(n.key) || 0));
  const ties = pool.filter((n) => (cover.get(n.key) || 0) === least);
  const pick = ties[Math.floor(Math.random() * ties.length)];

  // One active assignment at a time: anything else still active was abandoned.
  await run(
    `update expert_assignments set status = 'skipped', updated_at = now()
      where reviewer_name = $1 and status = 'active'`,
    [reviewerName]
  );
  await setAssignmentStatus(reviewerName, pick, "active");
  return pick;
}

/** Record what the reviewer did with a network: active (also a touch), skipped, done. */
export async function setAssignmentStatus(reviewerName, meta, status) {
  await run(
    `insert into expert_assignments (reviewer_name, ${META_COLS.join(", ")}, status)
     values ($6, $1, $2, $3, $4, $5, $7)
     on conflict on constraint expert_assignments_key
     do update set status = excluded.status, updated_at = now()`,
    [...metaValues(meta), reviewerName, status]
  );
}

/* ---------------------------------------------------------- leaderboard -- */

/**
 * Reviewers ranked by reactions fully scored (every criterion in `criteria`),
 * for the networks of `model` + `config`. Ties go to whoever got there first.
 *   [{ reviewer, reactions, molecules, notes }]
 */
export async function leaderboard(model, config, criteria) {
  const { rows } = await run(
    `with full_rxn as (
       select reviewer_name, molecule, reaction_id, max(updated_at) as last
         from expert_scores
        where scope = 'reaction' and model = $1 and config = $2 and criterion = any($3)
        group by reviewer_name, molecule, reaction_id
       having count(distinct criterion) = $4
     )
     select f.reviewer_name as reviewer,
            count(*)::int   as reactions,
            max(f.last)     as last,
            (select count(*)::int from expert_assignments a
              where a.reviewer_name = f.reviewer_name and a.status = 'done') as molecules,
            (select count(*)::int from expert_comments c
              where c.reviewer_name = f.reviewer_name and c.scope = 'reaction') as notes
       from full_rxn f
      group by f.reviewer_name
      order by reactions desc, last asc`,
    [model, config, criteria, criteria.length]
  );
  return rows;
}

/**
 * Other reviewers' mean score per criterion on one network, shown only after
 * the reviewer has finished it so it cannot anchor their own scores.
 *   { criterion: { mean, reviewers } }
 */
export async function panelAverages(meta, reviewerName) {
  const { rows } = await run(
    `select criterion, avg(score)::float as mean, count(distinct reviewer_name)::int as reviewers
       from expert_scores
      where model = $1 and molecule = $2 and config = $3 and run = $4 and attempt = $5
        and scope = 'reaction' and reviewer_name <> $6
      group by criterion`,
    [...metaValues(meta), reviewerName]
  );
  return Object.fromEntries(rows.map((r) => [r.criterion, { mean: r.mean, reviewers: r.reviewers }]));
}

/* ---------------------------------------------------------------- admin -- */

/**
 * Everything the admin dashboard shows, for the networks of `model` + `config`.
 * A "complete review" is one reviewer x one reaction with every criterion scored,
 * the same definition the leaderboard uses.
 *   { molecules: [{ molecule, reactions, reviews, covered, at_target, active, done, skipped }],
 *     reviewers: [{ reviewer, complete, partial, notes, molecules, active, last }],
 *     recent:    [{ reviewer, molecule, reaction_id, name, criteria, at }] }
 * `exclude` (the admin's own username) is left out of the reviewer list.
 */
export async function adminOverview(model, config, criteria, targetReviewers, exclude) {
  const base = [model, config, criteria, criteria.length];
  const [molecules, reviewers, recent] = await Promise.all([
    run(
      `with full_rxn as (
         select reviewer_name, molecule, reaction_id
           from expert_scores
          where scope = 'reaction' and model = $1 and config = $2 and criterion = any($3)
          group by reviewer_name, molecule, reaction_id
         having count(distinct criterion) = $4
       ),
       per_rxn as (
         select molecule, reaction_id, count(*)::int as k from full_rxn group by molecule, reaction_id
       ),
       rx as (
         select molecule, count(*)::int as n from expert_reactions
          where model = $1 and config = $2 group by molecule
       ),
       asg as (
         select molecule,
                count(*) filter (where status = 'active')::int  as active,
                count(*) filter (where status = 'done')::int    as done,
                count(*) filter (where status = 'skipped')::int as skipped
           from expert_assignments where model = $1 and config = $2 group by molecule
       )
       select rx.molecule, rx.n as reactions,
              coalesce(sum(p.k), 0)::int                          as reviews,
              count(p.reaction_id)::int                           as covered,
              count(p.reaction_id) filter (where p.k >= $5)::int  as at_target,
              coalesce(a.active, 0) as active, coalesce(a.done, 0) as done,
              coalesce(a.skipped, 0) as skipped
         from rx
         left join per_rxn p on p.molecule = rx.molecule
         left join asg a on a.molecule = rx.molecule
        group by rx.molecule, rx.n, a.active, a.done, a.skipped
        order by rx.molecule`,
      [...base, targetReviewers]
    ),
    run(
      `with s as (
         select reviewer_name, molecule, reaction_id,
                count(distinct criterion) as c, max(updated_at) as last
           from expert_scores
          where scope = 'reaction' and model = $1 and config = $2 and criterion = any($3)
          group by reviewer_name, molecule, reaction_id
       ),
       r as (
         select reviewer_name,
                count(*) filter (where c = $4)::int as complete,
                count(*) filter (where c < $4)::int as partial,
                max(last) as last
           from s group by reviewer_name
       ),
       n as (
         select reviewer_name, count(*)::int as notes, max(updated_at) as last
           from expert_comments
          where scope = 'reaction' and model = $1 and config = $2 group by reviewer_name
       ),
       a as (
         select reviewer_name,
                count(*) filter (where status = 'done')::int  as done,
                max(molecule) filter (where status = 'active') as active,
                max(updated_at) as last
           from expert_assignments where model = $1 and config = $2 group by reviewer_name
       ),
       names as (
         select reviewer_name from r union select reviewer_name from n
         union select reviewer_name from a
       )
       select x.reviewer_name as reviewer,
              coalesce(r.complete, 0) as complete, coalesce(r.partial, 0) as partial,
              coalesce(n.notes, 0) as notes, coalesce(a.done, 0) as molecules, a.active,
              greatest(r.last, n.last, a.last) as last
         from names x
         left join r using (reviewer_name)
         left join n using (reviewer_name)
         left join a using (reviewer_name)
        where x.reviewer_name <> $5
        order by complete desc, last desc nulls last`,
      [...base, exclude ?? ""]
    ),
    run(
      `select s.reviewer_name as reviewer, s.molecule, s.reaction_id, r.name,
              count(distinct s.criterion)::int as criteria, max(s.updated_at) as at
         from expert_scores s
         left join expert_reactions r
           on r.model = s.model and r.molecule = s.molecule and r.config = s.config
          and r.run = s.run and r.attempt = s.attempt and r.reaction_id = s.reaction_id
        where s.scope = 'reaction' and s.model = $1 and s.config = $2
        group by s.reviewer_name, s.molecule, s.reaction_id, r.name
        order by at desc
        limit 15`,
      [model, config]
    ),
  ]);
  return { molecules: molecules.rows, reviewers: reviewers.rows, recent: recent.rows };
}

/** The review tables (`expert_*`) in the public schema, for a whole-database export. */
export async function listTables() {
  const { rows } = await run(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
        and table_name like 'expert\\_%'
      order by table_name`
  );
  return rows.map((r) => r.table_name);
}

/** Row count of every review table: [{ table, rows }]. */
export async function tableSizes() {
  const tables = await listTables();
  if (!tables.length) return [];
  // Names come from listTables() and are checked again before use as identifiers.
  const sql = tables
    .filter((t) => /^expert_[a-z_]+$/.test(t))
    .map((t) => `select '${t}' as table, count(*)::int as rows from "${t}"`)
    .join(" union all ");
  const { rows } = await run(`${sql} order by 1`);
  return rows;
}

/** Every row of one review table: { columns, rows }. */
export async function dumpTable(name) {
  // The name ends up in SQL as an identifier, so it must be one we listed.
  if (!/^expert_[a-z_]+$/.test(name) || !(await listTables()).includes(name)) {
    throw new Error(`Unknown table: ${name}`);
  }
  const res = await run(`select * from "${name}" order by 1`);
  return { columns: res.fields.map((f) => f.name), rows: res.rows };
}

/**
 * One row per reviewer x reaction, one column per criterion, plus the reaction
 * name and the reviewer's note -- the same shape as tools/export_reviews.py's
 * expert_reaction_scores.csv.
 */
export async function reactionScoresWide(criteria) {
  const params = [];
  const cols = criteria.map((c) => {
    params.push(c);
    return `max(s.score) filter (where s.criterion = $${params.length}) as "${c.replace(/"/g, '""')}"`;
  }).join(", ");
  const res = await run(
    `select s.reviewer_name, s.model, s.molecule, s.run, s.config, s.reaction_id,
            r.name as reaction_name, ${cols},
            c.body as note, max(s.updated_at) as updated_at
       from expert_scores s
       left join expert_reactions r
         on r.model = s.model and r.molecule = s.molecule and r.config = s.config
        and r.run = s.run and r.attempt = s.attempt and r.reaction_id = s.reaction_id
       left join expert_comments c
         on c.reviewer_name = s.reviewer_name and c.model = s.model
        and c.molecule = s.molecule and c.config = s.config and c.run = s.run
        and c.attempt = s.attempt and c.scope = 'reaction' and c.reaction_id = s.reaction_id
      where s.scope = 'reaction'
      group by s.reviewer_name, s.model, s.molecule, s.run, s.config, s.reaction_id,
               r.name, r.position, c.body
      order by s.reviewer_name, s.molecule, r.position`,
    params
  );
  return { columns: res.fields.map((f) => f.name), rows: res.rows };
}
