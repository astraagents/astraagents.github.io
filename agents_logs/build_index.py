"""Build a JSON manifest of per-run agent I/O logs for the Agents Logs viewer.

Scans logs/io/*.jsonl, EXCLUDES the ms_disc config and aborted (_KILLED) or
mixed-model (_MIXED3MODELS) runs, parses (model, molecule, config, run,
session-timestamp) from each filename, counts the agent-call records, and writes
agents_logs/logs_index.json.

Re-run this whenever new logs land:
    python3 agents_logs/build_index.py
"""

import json
import re
from pathlib import Path

BASE = Path(__file__).parent          # .../agents_logs
LOGS = BASE / "logs"                  # .../agents_logs/logs
OUTPUT = BASE / "logs_index.json"

# <Molecule>_<model>_<config>_run<N>_<TS>.jsonl
# Molecule may contain hyphens (Acetyl-CoA, L-Alanine); parse it non-greedily up to
# a known model token so hyphens are preserved.
FN_RE = re.compile(
    r"^(?P<mol>.+?)_"
    r"(?P<model>gpt41_direct_azure|gpt5\.4_xhigh_azure|gpt6_xhigh_azure)_"
    r"(?P<config>deep_research_[\w.]+|ms_disc|perfect_rag|no_research|Naive)_"
    r"run(?P<run>\d+)_(?P<ts>\d{8}_\d{6})\.jsonl$"
)

# Aborted and mixed-model runs; a clean run exists for each of these combos.
SKIP_SUFFIXES = ("_KILLED.jsonl", "_MIXED3MODELS.jsonl")


def count_records(path):
    """Number of agent-call records = non-comment, non-blank lines (files are ~7-9 lines)."""
    n = 0
    for i, line in enumerate(path.read_text(errors="replace").splitlines()):
        if i == 0 and line.startswith("#"):   # the "# IOLogger: ..." header
            continue
        if line.strip():
            n += 1
    return n


sessions = []
unmatched = []

for f in sorted((LOGS / "io").glob("*.jsonl")):
    if "_ms_disc_" in f.name:                   # HARD EXCLUDE ms_disc
        continue
    if f.name.endswith(SKIP_SUFFIXES):
        continue
    m = FN_RE.match(f.name)
    if not m:
        unmatched.append(f.name)
        continue
    if m.group("config") == "ms_disc":          # defensive: never index ms_disc
        continue
    sessions.append({
        "model": m.group("model"),
        "molecule": m.group("mol"),
        "config": m.group("config"),
        "run": int(m.group("run")),
        "session": m.group("ts"),               # YYYYMMDD_HHMMSS disambiguator
        "records": count_records(f),
        "path": f"logs/io/{f.name}",
    })

sessions.sort(key=lambda s: (s["molecule"], s["model"], s["config"], s["session"]))

OUTPUT.write_text(json.dumps({"count": len(sessions), "sessions": sessions}, indent=2))

print(f"Wrote {len(sessions)} sessions to {OUTPUT.relative_to(BASE.parent)}")
if unmatched:
    print(f"WARNING: {len(unmatched)} file(s) did not match the expected pattern:")
    for name in unmatched:
        print(f"  - {name}")
