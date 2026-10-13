#!/usr/bin/env python3
"""Export expert review submissions from PlanetScale to CSV.

Credentials are read from expert_review/planetscale.txt (gitignored), so nothing
secret lives in this script. Writes three files into expert_review/exports/:

  expert_scores.csv      every score, long format, both scopes
  expert_network.csv     network-level scores only, in all_scores.csv column order
  expert_comments.csv    free-text opinions and reaction notes

Usage:
    python3 expert_review/tools/export_reviews.py
"""

import csv
import json
import re
import ssl
import subprocess
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

QUERIES = {
    "expert_scores.csv": """
        select reviewer_name, model, molecule, run, config, scope,
               reaction_id, criterion, score, updated_at
          from expert_scores
         order by reviewer_name, molecule, config, scope, reaction_id, criterion
    """,
    # Same columns, same order as pathway_explorer/meta_evaluations/all_scores.csv
    # (scores here are 0-10; the LLM-judge scores there are 1-10).
    "expert_network.csv": """
        select model as "Model", molecule as "Molecule", run as "Run",
               config as "Config", criterion as "Criterion", score as "Score",
               reviewer_name as "Reviewer"
          from expert_scores
         where scope = 'network'
         order by model, molecule, run, config, criterion
    """,
    "expert_comments.csv": """
        select reviewer_name, model, molecule, run, config, scope,
               reaction_id, body, updated_at
          from expert_comments
         order by reviewer_name, molecule, config, scope, reaction_id
    """,
}


def credentials():
    """Pull the connection URI out of planetscale.txt."""
    path = ROOT / "planetscale.txt"
    if not path.exists():
        raise SystemExit(f"missing {path} -- it holds the database credentials")
    text = path.read_text()
    m = re.search(r"postgresql://([^:]+):([^@]+)@([^:]+):(\d+)/(\w+)", text)
    if not m:
        raise SystemExit(f"could not find a connection URI in {path}")
    user, password, host, port, database = m.groups()
    return user, password, host, port, database


def query(sql):
    user, password, host, port, database = credentials()
    req = urllib.request.Request(
        f"https://{host}/sql",
        data=json.dumps({"query": " ".join(sql.split()), "params": []}).encode(),
        headers={
            "Content-Type": "application/json",
            "Neon-Connection-String":
                f"postgresql://{user}:{password}@{host}:{port}/{database}?sslmode=require",
        },
    )
    # Some python.org builds ship without a CA bundle, which makes urllib fail
    # certificate verification; fall back to curl, which uses the system store.
    try:
        body = urllib.request.urlopen(req, context=ssl.create_default_context()).read()
    except (urllib.error.URLError, ssl.SSLError):
        body = subprocess.run(
            ["curl", "-s", "-X", "POST", f"https://{host}/sql",
             "-H", "Content-Type: application/json",
             "-H", f"Neon-Connection-String: postgresql://{user}:{password}"
                   f"@{host}:{port}/{database}?sslmode=require",
             "--data-binary", json.dumps({"query": " ".join(sql.split()), "params": []})],
            capture_output=True, check=True).stdout

    payload = json.loads(body)
    if "rows" not in payload:
        raise SystemExit(f"query failed: {payload.get('message', payload)}")
    return payload["fields"], payload["rows"]


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
