"""Shared PlanetScale access for the expert-review tools.

Credentials are read from expert_review/planetscale.txt (gitignored), so nothing
secret lives in any script. Queries go over the Neon-compatible HTTP endpoint,
which works from a server (it only fails from a browser, for lack of CORS).
"""

import json
import re
import ssl
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent      # expert_review/


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


def query(sql, params=None):
    """Run one statement; returns (fields, rows) with rows as dicts."""
    user, password, host, port, database = credentials()
    conn = f"postgresql://{user}:{password}@{host}:{port}/{database}?sslmode=require"
    body = json.dumps({"query": " ".join(sql.split()), "params": params or []})
    req = urllib.request.Request(
        f"https://{host}/sql",
        data=body.encode(),
        headers={"Content-Type": "application/json", "Neon-Connection-String": conn},
    )
    # Some python.org builds ship without a CA bundle, which makes urllib fail
    # certificate verification; fall back to curl, which uses the system store.
    try:
        raw = urllib.request.urlopen(req, context=ssl.create_default_context()).read()
    except urllib.error.HTTPError as err:
        raw = err.read()
    except (urllib.error.URLError, ssl.SSLError):
        raw = subprocess.run(
            ["curl", "-s", "-X", "POST", f"https://{host}/sql",
             "-H", "Content-Type: application/json",
             "-H", f"Neon-Connection-String: {conn}",
             "--data-binary", body],
            capture_output=True, check=True).stdout

    payload = json.loads(raw)
    if "rows" not in payload:
        raise SystemExit(f"query failed: {payload.get('message', payload)}")
    return payload["fields"], payload["rows"]
