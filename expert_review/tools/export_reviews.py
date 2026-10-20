#!/usr/bin/env python3
"""Export expert review submissions from PlanetScale to CSV.

Credentials are read from expert_review/planetscale.txt (gitignored), so nothing
secret lives in this script. Writes into expert_review/exports/ (also gitignored):

  expert_scores.csv            every score, long format
  expert_reaction_scores.csv   one row per reviewer x reaction, one column per
                               criterion, plus the reviewer's note
  expert_comments.csv          free-text notes
  expert_assignments.csv       who was given which molecule, and what they did with it

Usage:
    python3 expert_review/tools/export_reviews.py
"""

import csv
import json
from pathlib import Path

from pscale import query

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

CRITERIA = json.loads((ROOT / "data" / "review_index.json").read_text())["criteria"]["reaction"]


def wide_reaction_scores():
    # One pivot column per criterion, named after it; criteria come from the
    # manifest (trusted), and are quoted as identifiers and literals.
    cols = ", ".join(
        "max(s.score) filter (where s.criterion = '{0}') as \"{0}\"".format(c.replace("'", "''"))
        for c in CRITERIA
    )
    return f"""
        select s.reviewer_name, s.model, s.molecule, s.run, s.config, s.reaction_id,
               r.name as reaction_name, {cols},
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
         order by s.reviewer_name, s.molecule, r.position
    """


QUERIES = {
    "expert_scores.csv": """
        select reviewer_name, model, molecule, run, config, scope,
               reaction_id, criterion, score, updated_at
          from expert_scores
         order by reviewer_name, molecule, config, scope, reaction_id, criterion
    """,
    "expert_reaction_scores.csv": wide_reaction_scores(),
    "expert_comments.csv": """
        select reviewer_name, model, molecule, run, config, scope,
               reaction_id, body, updated_at
          from expert_comments
         order by reviewer_name, molecule, config, scope, reaction_id
    """,
    "expert_assignments.csv": """
        select reviewer_name, model, molecule, run, config, status, assigned_at, updated_at
          from expert_assignments
         order by molecule, assigned_at
    """,
}


def main():
    out_dir = ROOT / "exports"
    out_dir.mkdir(exist_ok=True)

    for filename, sql in QUERIES.items():
        fields, rows = query(sql)
        names = [f["name"] for f in fields]
        dest = out_dir / filename
        with dest.open("w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=names)
            w.writeheader()
            w.writerows(rows)
        print(f"{dest.relative_to(ROOT.parent)}  --  {len(rows)} rows")


if __name__ == "__main__":
    main()
