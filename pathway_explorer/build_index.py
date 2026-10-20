"""Build a CSV index of synthesis networks and their validation reports."""

import csv
import re
from pathlib import Path

BASE = Path(__file__).parent
SYNTH_DIR = BASE / "synthesis_networks"
VALID_DIR = BASE / "validation_report"
OUTPUT = BASE / "file_index.csv"

# Only index these models; others are kept on disk but excluded from the app.
KEEP_MODELS = {"gpt41_direct_azure", "gpt5.4_xhigh_azure", "gpt6_xhigh_azure"}

# Matches: network_{molecule}[_{YYYYMMDD_HHMMSS}]_{config}_run{N}[_attempt{N}].json
# config is e.g. deep_research_claudeopus5.5, deep_research_gpt6, perfect_rag, no_research, Naive
# (Naive files carry no timestamp: network_{molecule}_Naive_run1_attempt1.json)
SYNTH_RE = re.compile(
    r"^network_(.+?)(?:_\d{8}_\d{6})?_((?:deep_research_[\w.]+|perfect_rag|no_research|Naive))_run(\d+)(?:_attempt(\d+))?\.json$"
)

rows = []

for model_dir in sorted(SYNTH_DIR.iterdir()):
    if not model_dir.is_dir():
        continue
    model = model_dir.name
    if model not in KEEP_MODELS:
        continue

    for f in sorted(model_dir.glob("*.json")):
        m = SYNTH_RE.match(f.name)
        if not m:
            continue

        molecule = m.group(1)
        config = m.group(2)
        run = m.group(3)
        attempt = m.group(4) if m.group(4) else ""

        # Build the validation report filename
        stem = f.stem  # filename without .json
        validation_path = VALID_DIR / model / f"{stem}_validation.json"

        rows.append({
            "model": model,
            "molecule": molecule,
            "config": config,
            "run": run,
            "attempt": attempt,
            "synthesis_network_path": f"synthesis_networks/{model}/{f.name}",
            "validation_path": f"validation_report/{model}/{stem}_validation.json" if validation_path.exists() else "",
        })

fields = ["model", "molecule", "config", "run", "attempt",
          "synthesis_network_path", "validation_path"]

with open(OUTPUT, "w", newline="") as fh:
    writer = csv.DictWriter(fh, fieldnames=fields)
    writer.writeheader()
    writer.writerows(rows)

print(f"Wrote {len(rows)} rows to {OUTPUT}")
