-- ASTRA expert review -- DESTRUCTIVE RESET
--
-- Drops the three review tables and everything in them. There is no undo.
-- Export anything you care about first:
--     python3 expert_review/tools/export_reviews.py
--
-- Run this in the PlanetScale console with an ELEVATED credential, the same one
-- used for schema.sql. The API role in planetscale.txt cannot drop these tables:
-- it has pg_write_all_data (rows) but does not own them, so DROP and ALTER are
-- both denied. That is also why the 0-10 CHECK has to be rebuilt here rather
-- than altered in place.
--
-- THEN run schema.sql to recreate the tables, indexes and grants.

drop table if exists expert_scores;
drop table if exists expert_comments;
drop table if exists expert_submissions;
