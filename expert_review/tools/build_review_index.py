#!/usr/bin/env python3
"""Build the expert-review queue and emit expert_review/data/review_index.json.

One network per molecule, scored reaction by reaction:

    A = gpt6_xhigh_azure + deep_research_gpt6   (run 1, attempt 3, from file_index.csv)

Networks are not copied: the manifest stores paths relative to pathway_explorer/,
which is where explorer.html resolves them (it sets <base href="../pathway_explorer/">).
The reactions themselves are loaded into the database by seed_reactions.py.
Run from anywhere:

    python3 expert_review/tools/build_review_index.py
"""

import csv
import json
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                      # expert_review/
EXPLORER = ROOT.parent / "pathway_explorer"

MODEL = "gpt6_xhigh_azure"
CONFIG = "deep_research_gpt6"
RUN = "1"
ATTEMPT = "3"
# Keep the expert panel's ten amino acids fixed as the explorer gains networks.
MOLECULES = (
    "Arginine", "Glutamate", "Glycine", "Histidine", "L_Alanine", "L_Proline",
    "Serine", "Threonine", "Tryptophan", "Valine",
)

# Scored per reaction: the criteria from GeminiJudgePrompt.md that make sense for
# a single step, with Chemical Feasibility and Reaction Justification merged and
# each scored 0-5. (Pathway Coherence, Environmental Consistency and Network
# Completeness judge how steps fit together, so they stay network-level.)
# Their scoring anchors are shown to reviewers via CRITERION_GUIDE in js/app.js.
REACTION_CRITERIA = [
    "Reaction Detail Validity",
    "Geochemical Realism",
    "Reaction Novelty",
]


def net_key(model, molecule, config, run, attempt):
    return "|".join([model, molecule, config, str(run), attempt])


def network_rows():
    """Exactly one run-1, attempt-3 network for each amino acid under review."""
    with (EXPLORER / "file_index.csv").open(newline="") as fh:
        rows = list(csv.DictReader(fh))
    selected = {}
    for row in rows:
        if (row["model"] != MODEL or row["config"] != CONFIG
                or row["run"] != RUN or row["attempt"] != ATTEMPT
                or row["molecule"] not in MOLECULES):
            continue
        molecule = row["molecule"]
        if molecule in selected:
            raise ValueError(f"Duplicate attempt-{ATTEMPT} network for {molecule}")
        selected[molecule] = row
    missing = sorted(set(MOLECULES) - selected.keys())
    if missing:
        raise ValueError(f"Missing attempt-{ATTEMPT} networks: {', '.join(missing)}")
    return selected


def entry(row, label):
    src = EXPLORER / row["synthesis_network_path"]
    with src.open() as fh:
        reactions = json.load(fh).get("network", {}).get("reactions", [])
    return {
        "key": net_key(row["model"], row["molecule"], row["config"], row["run"], row["attempt"]),
        "model": row["model"],
        "molecule": row["molecule"],
        "config": row["config"],
        "run": int(row["run"]),
        "attempt": row["attempt"],
        "blind": label,
        "file": row["synthesis_network_path"],
        "validation": row["validation_path"],
        "n_reactions": len(reactions),
    }


def main():
    rows = network_rows()
    molecules = sorted(rows)
    networks = [entry(rows[m], "A") for m in molecules]

    # Networks used to be copied here; they are now read in place.
    stale = ROOT / "data" / "networks"
    if stale.exists():
        shutil.rmtree(stale)

    manifest = {
        "criteria": {"reaction": REACTION_CRITERIA},
        "molecules": molecules,
        "networks": networks,
    }
    out = ROOT / "data" / "review_index.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as fh:
        json.dump(manifest, fh, indent=1)
        fh.write("\n")

    print(f"molecules      : {len(molecules)}  {molecules}")
    print(f"networks       : {len(networks)}  ({MODEL} + {CONFIG}, run {RUN}, attempt {ATTEMPT})")
    print(f"reactions      : {sum(n['n_reactions'] for n in networks)}")
    print(f"manifest       : {out.relative_to(ROOT.parent)}")


if __name__ == "__main__":
    main()
