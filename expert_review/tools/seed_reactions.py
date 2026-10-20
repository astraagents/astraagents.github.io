#!/usr/bin/env python3
"""Load every reaction under review into the expert_reactions table.

Reads data/review_index.json (build_review_index.py), opens each network JSON in
pathway_explorer/, and upserts one row per reaction. Each row's payload is the raw
reaction with `inputs` / `outputs` resolved from molecule ids to
{id, formula, name, role, cid, cid_match, pubchem_formula}, so the review page
needs nothing but this row to show it, 2D structures included. The PubChem CIDs
come from data/pubchem.json (resolve_pubchem.py); run that first.

Idempotent: re-running updates rows in place. Needs schema.sql to have been run.

    python3 expert_review/tools/seed_reactions.py
"""

import json
from pathlib import Path

from pscale import query
from resolve_pubchem import molecule_key

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
EXPLORER = ROOT.parent / "pathway_explorer"

UPSERT = """
    insert into expert_reactions
        (model, molecule, config, run, attempt, reaction_id, position, name, payload)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    on conflict on constraint expert_reactions_key
    do update set position = excluded.position, name = excluded.name,
                  payload = excluded.payload, updated_at = now()
"""


def molecule_ref(mol_id, mols, pubchem):
    m = mols.get(mol_id, {})
    hit = pubchem.get(molecule_key(m), {}) if m else {}
    return {
        "id": mol_id,
        "formula": m.get("formula") or "",
        "name": m.get("common_name") or m.get("iupac_name") or mol_id,
        "role": m.get("role") or "",
        "cid": hit.get("cid"),
        "cid_match": hit.get("match"),
        "pubchem_formula": hit.get("pubchem_formula"),
    }


def main():
    manifest = json.loads((ROOT / "data" / "review_index.json").read_text())
    pubchem_file = ROOT / "data" / "pubchem.json"
    if not pubchem_file.exists():
        raise SystemExit("missing data/pubchem.json -- run tools/resolve_pubchem.py first")
    pubchem = json.loads(pubchem_file.read_text())
    total = 0
    for net in manifest["networks"]:
        data = json.loads((EXPLORER / net["file"]).read_text())
        network = data.get("network", {})
        mols = {m["id"]: m for m in network.get("molecules", [])}
        reactions = network.get("reactions", [])

        for pos, rxn in enumerate(reactions):
            payload = dict(rxn)
            payload["inputs"] = [molecule_ref(i, mols, pubchem) for i in rxn.get("inputs", [])]
            payload["outputs"] = [molecule_ref(o, mols, pubchem) for o in rxn.get("outputs", [])]
            query(UPSERT, [
                net["model"], net["molecule"], net["config"], net["run"], net["attempt"],
                rxn["id"], pos, rxn.get("name") or rxn["id"], json.dumps(payload),
            ])
        total += len(reactions)
        print(f"{net['molecule']:<12} {len(reactions):>3} reactions")

    _, rows = query("select count(*) as n from expert_reactions")
    print(f"seeded {total}; expert_reactions now holds {rows[0]['n']} rows")


if __name__ == "__main__":
    main()
