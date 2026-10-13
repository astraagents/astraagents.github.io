-- ASTRA expert review platform -- schema
--
-- RUN THIS ONCE with an ELEVATED credential (PlanetScale console SQL editor, or a
-- password for the `postgres` role). The API role in planetscale.txt holds
-- pg_write_all_data but CANNOT create tables:
--   select has_schema_privilege('public','CREATE');  -->  false
--   create table t (id int);                         -->  42501 permission denied for schema public
--
-- The grants at the bottom name the API username WITHOUT the branch suffix,
-- i.e. `pscale_api_y1qbjsmef33x` (not `pscale_api_y1qbjsmef33x.m2jxvl4mo2vv`).
--
-- Re-running this file is safe: every statement is `if not exists`, so it will
-- NOT alter tables that already exist. To rebuild them from scratch, run
-- schema_reset.sql first (it drops them), then this file.

-- One row per (reviewer, network, scope, reaction, criterion).
-- Long format mirrors pathway_explorer/meta_evaluations/all_scores.csv
-- (Model,Molecule,Run,Config,Criterion,Score) so expert scores drop straight
-- into the existing analysis.
create table if not exists expert_scores (
    id              bigserial primary key,
    reviewer_name   text        not null,
    model           text        not null,
    molecule        text        not null,
    config          text        not null,
    run             int         not null default 1,
    attempt         text        not null default '',
    scope           text        not null check (scope in ('network', 'reaction')),
    reaction_id     text        not null default '',          -- '' when scope = 'network'
    criterion       text        not null,
    -- Scores are 0-10. Keep this in step with SCORE_MAX in js/app.js + js/db.js.
    score           int         not null check (score between 0 and 10),
    updated_at      timestamptz not null default now(),
    constraint expert_scores_key unique
        (reviewer_name, model, molecule, config, run, attempt, scope, reaction_id, criterion)
);

-- Optional free text: the reviewer's opinion on a network, or a note on a reaction.
create table if not exists expert_comments (
    id              bigserial primary key,
    reviewer_name   text        not null,
    model           text        not null,
    molecule        text        not null,
    config          text        not null,
    run             int         not null default 1,
    attempt         text        not null default '',
    scope           text        not null check (scope in ('network', 'reaction')),
    reaction_id     text        not null default '',
    body            text        not null,
    updated_at      timestamptz not null default now(),
    constraint expert_comments_key unique
        (reviewer_name, model, molecule, config, run, attempt, scope, reaction_id)
);

-- Marks a network as finished, so a reviewer can tell at a glance what is left.
create table if not exists expert_submissions (
    id              bigserial primary key,
    reviewer_name   text        not null,
    model           text        not null,
    molecule        text        not null,
    config          text        not null,
    run             int         not null default 1,
    attempt         text        not null default '',
    submitted_at    timestamptz not null default now(),
    constraint expert_submissions_key unique
        (reviewer_name, model, molecule, config, run, attempt)
);

create index if not exists expert_scores_lookup   on expert_scores   (reviewer_name, molecule);
create index if not exists expert_comments_lookup on expert_comments (reviewer_name, molecule);

-- The app reads its own rows back to restore a reviewer's progress, so SELECT is
-- required too; pg_write_all_data alone does not grant it.
grant select, insert, update, delete on expert_scores, expert_comments, expert_submissions
    to pscale_api_y1qbjsmef33x;
grant usage, select on sequence expert_scores_id_seq       to pscale_api_y1qbjsmef33x;
grant usage, select on sequence expert_comments_id_seq     to pscale_api_y1qbjsmef33x;
grant usage, select on sequence expert_submissions_id_seq  to pscale_api_y1qbjsmef33x;
