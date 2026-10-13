#!/usr/bin/env python3
"""Build the expert-review queue: copy the networks under review into
expert_review/data/networks/ and emit data/review_index.json.

The queue is the cross product of the two models and two configs under review,
restricted to the molecules that all four cells have in common so every molecule
can be compared across all four. Run from anywhere:

    python3 expert_review/tools/build_review_index.py
"""

import csv
import hashlib
import json
import shutil
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                      # expert_review/
EXPLORER = ROOT.parent / "pathway_explorer"

MODELS = ["claude_opus4.6", "gpt5.4"]
CONFIGS = ["deep_research_claude", "deep_research_gpt5.4"]

# Scored per reaction: only the criteria that are meaningful for a single step.
REACTION_CRITERIA = [
    "Chemical Feasibility",
    "Environmental Consistency",
    "Mechanistic Detail",
    "Prebiotic Plausibility",
    "Novelty of Reactions",
]
# Scored once for the network as a whole: the canonical 7, in the same order they
# appear in pathway_explorer/meta_evaluations/all_scores.csv.
NETWORK_CRITERIA = [
    "Chemical Feasibility",
    "Pathway Coherence",
    "Environmental Consistency",
    "Mechanistic Detail",
    "Network Completeness",
    "Prebiotic Plausibility",
    "Novelty of Reactions",
]

LABELS = ["A", "B", "C", "D"]


def net_key(row):
    return "|".join([row["model"], row["molecule"], row["config"], row["run"], row["attempt"]])


def blind_labels(molecule, cells):
    """Assign A-D to the four (model, config) cells, permuted per molecule so the
    label -> cell mapping differs between molecules and cannot be learned."""
    digest = hashlib.sha256(molecule.encode()).digest()
    # Fisher-Yates driven by the digest, so it is stable across runs and languages.
    order = list(cells)
    for i in range(len(order) - 1, 0, -1):
        j = digest[i] % (i + 1)
        order[i], order[j] = order[j], order[i]
    return {cell: LABELS[i] for i, cell in enumerate(order)}


def main():
    index_csv = EXPLORER / "file_index.csv"
    with index_csv.open(newline="") as fh:
        rows = list(csv.DictReader(fh))

    # Final networks only (attempt blank), restricted to the models/configs under review.
    rows = [
        r for r in rows
        if r["model"] in MODELS and r["config"] in CONFIGS and not r["attempt"]
    ]

    by_cell = defaultdict(set)
    for r in rows:
        by_cell[(r["model"], r["config"])].add(r["molecule"])

    expected_cells = [(m, c) for m in MODELS for c in CONFIGS]
    missing = [c for c in expected_cells if c not in by_cell]
    if missing:
        raise SystemExit(f"file_index.csv has no rows for cells: {missing}")

    molecules = sorted(set.intersection(*(by_cell[c] for c in expected_cells)))
    label_for = {m: blind_labels(m, expected_cells) for m in molecules}

    out_dir = ROOT / "data" / "networks"
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("*.json"):
        stale.unlink()

    networks = []
    for r in sorted(rows, key=lambda r: (r["molecule"], r["model"], r["config"])):
        if r["molecule"] not in molecules:
            continue
        src = EXPLORER / r["synthesis_network_path"]
        if not src.exists():
            raise SystemExit(f"missing network file: {src}")

        with src.open() as fh:
            data = json.load(fh)
        reactions = data.get("network", {}).get("reactions", [])

        # Named by molecule + blind label, never by model/config: the two models
        # share basenames upstream (they are disambiguated only by directory), and
        # a filename carrying the config would leak it to anyone with devtools open.
        label = label_for[r["molecule"]][(r["model"], r["config"])]
        name = f"{r['molecule']}_{label}.json"
        shutil.copyfile(src, out_dir / name)

        networks.append({
            "key": net_key(r),
            "model": r["model"],
            "molecule": r["molecule"],
            "config": r["config"],
            "run": int(r["run"]),
            "attempt": r["attempt"],
            "blind": label,
            "file": f"data/networks/{name}",
            "n_reactions": len(reactions),
        })

    manifest = {
        "criteria": {"reaction": REACTION_CRITERIA, "network": NETWORK_CRITERIA},
        "molecules": molecules,
        "networks": networks,
    }
    out = ROOT / "data" / "review_index.json"
    with out.open("w") as fh:
        json.dump(manifest, fh, indent=1)
        fh.write("\n")

    total_rx = sum(n["n_reactions"] for n in networks)
    print(f"molecules      : {len(molecules)}  {molecules}")
    print(f"networks       : {len(networks)}  ({len(expected_cells)} cells x {len(molecules)} molecules)")
    print(f"reactions      : {total_rx}")
    print(f"copied to      : {out_dir.relative_to(ROOT.parent)}")
    print(f"manifest       : {out.relative_to(ROOT.parent)}")


if __name__ == "__main__":
    main()
