/**
 * The only module in this app that talks to the database.
 *
 * Why WebSockets and not HTTP: PlanetScale's `/sql` endpoint (the Neon HTTP/fetch
 * transport) sends no CORS headers and answers OPTIONS with 405, so a browser
 * preflight for the `Neon-Connection-String` header always fails. The WebSocket
 * proxy at wss://<host>/v2 accepts cross-origin connections -- WebSockets are
 * exempt from CORS -- so that is the only transport that works from a static page.
 *
 * To move the credentials off the client later, replace the four exported
 * functions below with fetch() calls to a serverless proxy. Nothing else in the
 * app touches the database.
 */

import { Pool, neonConfig } from "./vendor/neon-serverless.js";

const HOST = "aws-us-east-1-5.pg.psdb.cloud";
const PORT = 5432;
const DATABASE = "postgres";

// Scores are 0-10. The table's CHECK is `between 0 and 100` from the original
// schema; 0-10 is a subset so it still passes, and the API role cannot ALTER the
// constraint (it is not the table owner). This is the authoritative bound.
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

/** Columns identifying one network, shared by all three tables. */
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

/** Mark a network as finished by this reviewer. */
export async function markSubmitted(meta) {
  await run(
    `insert into expert_submissions
       (reviewer_name, ${META_COLS.join(", ")})
     values ($6, $1, $2, $3, $4, $5)
     on conflict on constraint expert_submissions_key
     do update set submitted_at = now()`,
    [...metaValues(meta), meta.reviewerName]
  );
}

/**
 * Everything this reviewer has saved, so returning to a network restores their
 * sliders and notes. Shape:
 *   { scores:   { "<netKey>|<scope>|<reactionId>": { criterion: score } },
 *     comments: { "<netKey>|<scope>|<reactionId>": body },
 *     submitted: Set<netKey> }
 */
export async function loadProgress(reviewerName) {
  requirePool();
  const key = (r) => [
    [r.model, r.molecule, r.config, r.run, r.attempt].join("|"),
    r.scope,
    r.reaction_id,
  ].join("|");

  const [scoreRows, commentRows, submittedRows] = await Promise.all([
    run(
      `select ${META_COLS.join(", ")}, scope, reaction_id, criterion, score
         from expert_scores where reviewer_name = $1`,
      [reviewerName]
    ),
    run(
      `select ${META_COLS.join(", ")}, scope, reaction_id, body
         from expert_comments where reviewer_name = $1`,
      [reviewerName]
    ),
    run(
      `select ${META_COLS.join(", ")} from expert_submissions where reviewer_name = $1`,
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
  const submitted = new Set(
    submittedRows.rows.map((r) => [r.model, r.molecule, r.config, r.run, r.attempt].join("|"))
  );

  return { scores, comments, submitted };
}
