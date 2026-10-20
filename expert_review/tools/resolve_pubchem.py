#!/usr/bin/env python3
"""Resolve every molecule under review to a PubChem compound (CID).

Writes expert_review/data/pubchem.json, which seed_reactions.py folds into each
reaction's inputs/outputs so the review page can show 2D structures as
https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/<cid>/PNG -- by CID, not by
name, because name lookups at view time are slow, rate-limited (PubChem allows
~5 requests/s) and often 404 for the networks' descriptive names.

Lookup order per molecule: its InChI (the network's own structural claim), then
its IUPAC name, then its common name. Each hit is checked against the network's
stated formula on heavy atoms only (hydrogens and charge are ignored, so formate
vs formic acid still matches); the first candidate that matches wins. When none
match, the best hit is kept with "match": false and the page flags it, so a
reviewer is never shown an unmarked structure that disagrees with the formula.

Results are cached in the output file: re-running only looks up new molecules.
Pass --refresh to look everything up again.

    python3 expert_review/tools/resolve_pubchem.py [--refresh]
"""

import json
import re
import subprocess
import sys
import time
import urllib.parse
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
EXPLORER = ROOT.parent / "pathway_explorer"
OUT = ROOT / "data" / "pubchem.json"

PUG = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
PAUSE = 0.25                    # stay under PubChem's 5 requests/second

SUBSCRIPTS = str.maketrans("₀₁₂₃₄₅₆₇₈₉", "0123456789")


def molecule_key(mol):
    """Stable identity for a molecule across networks: its InChI, else its names."""
    if mol.get("inchi"):
        return mol["inchi"]
    return "name:" + (mol.get("common_name") or "") + "|" + (mol.get("iupac_name") or "")


def heavy_atoms(formula):
    """Element counts without hydrogen; None if the formula cannot be parsed."""
    f = (formula or "").translate(SUBSCRIPTS)
    # Charge comes last, as "-" / "2-" in the networks or "-2" in PubChem. Only a
    # digit *after* the sign belongs to the charge; "C2HO3-" keeps its O3.
    f = re.sub(r"[+\-−]\d*$", "", f.strip())
    f = re.sub(r"[+\-−·.]", "", f)
    if not f or "(" in f or "n" in re.sub(r"[A-Z][a-z]?", "", f):
        return None
    counts = Counter()
    for el, n in re.findall(r"([A-Z][a-z]?)(\d*)", f):
        counts[el] += int(n or 1)
    counts.pop("H", None)
    return counts or None


def formula_match(stated, pubchem_formula):
    """Heavy atoms agree; None when the stated formula cannot be parsed.

    A digit right before a trailing sign is read both ways, so the networks'
    "Fe2+" matches PubChem's "Fe+2" as well as "C2HO3-" its "C2HO3-".
    """
    stated = (stated or "").translate(SUBSCRIPTS).strip()
    wants = [heavy_atoms(stated)]
    if re.search(r"\d[+\-−]$", stated):
        wants.append(heavy_atoms(stated[:-2] + stated[-1]))
    wants = [w for w in wants if w]
    if not wants:
        return None
    got = heavy_atoms(pubchem_formula)
    return bool(got) and got in wants


def curl(args):
    # curl rather than urllib: some python.org builds ship without a CA bundle.
    time.sleep(PAUSE)
    res = subprocess.run(["curl", "-s", "--max-time", "20", *args], capture_output=True, text=True)
    try:
        return json.loads(res.stdout or "{}")
    except json.JSONDecodeError:
        return {}


def cids_by(kind, value):
    if kind == "inchi":
        data = curl(["-X", "POST", f"{PUG}/compound/inchi/cids/JSON",
                     "--data-urlencode", f"inchi={value}"])
    else:
        data = curl([f"{PUG}/compound/name/{urllib.parse.quote(value, safe='')}/cids/JSON"])
    return [c for c in data.get("IdentifierList", {}).get("CID", []) if c]


def formula_of(cid):
    data = curl([f"{PUG}/compound/cid/{cid}/property/MolecularFormula,Title/JSON"])
    props = (data.get("PropertyTable", {}).get("Properties") or [{}])[0]
    return props.get("MolecularFormula"), props.get("Title")


def resolve(mol):
    tries = [("inchi", mol.get("inchi")), ("iupac", mol.get("iupac_name")), ("name", mol.get("common_name"))]
    first = None
    seen = set()
    for kind, value in tries:
        if not value or value in seen:
            continue
        seen.add(value)
        cids = cids_by(kind, value)
        if not cids:
            continue
        formula, title = formula_of(cids[0])
        hit = {"cid": cids[0], "source": kind, "pubchem_formula": formula, "title": title}
        hit["match"] = formula_match(mol.get("formula"), formula)
        if hit["match"] or (hit["match"] is None and first is None):
            return hit
        first = first or hit
    return first or {"cid": None}


def main():
    refresh = "--refresh" in sys.argv
    cache = {} if refresh or not OUT.exists() else json.loads(OUT.read_text())

    manifest = json.loads((ROOT / "data" / "review_index.json").read_text())
    molecules = {}
    for net in manifest["networks"]:
        network = json.loads((EXPLORER / net["file"]).read_text())["network"]
        mols = {m["id"]: m for m in network.get("molecules", [])}
        for rxn in network.get("reactions", []):
            for mid in rxn.get("inputs", []) + rxn.get("outputs", []):
                if mid in mols:
                    molecules.setdefault(molecule_key(mols[mid]), mols[mid])

    todo = [k for k in molecules if k not in cache]
    print(f"{len(molecules)} molecules, {len(todo)} to look up")
    for i, key in enumerate(todo, 1):
        mol = molecules[key]
        cache[key] = resolve(mol)
        hit = cache[key]
        label = mol.get("common_name") or mol.get("iupac_name") or key
        mark = "--" if not hit.get("cid") else ("ok" if hit.get("match") is not False else "!!")
        print(f"[{i:>3}/{len(todo)}] {mark} {label[:44]:<44} cid={hit.get('cid')} via {hit.get('source')}")

    # The cache is keyed by structure, but the formula check belongs to the network
    # that states it, so redo it for the current networks rather than trust the cache.
    for key, mol in molecules.items():
        if cache[key].get("cid"):
            cache[key]["match"] = formula_match(mol.get("formula"), cache[key].get("pubchem_formula"))

    OUT.write_text(json.dumps(dict(sorted(cache.items())), indent=1, ensure_ascii=False) + "\n")
    found = [v for k, v in cache.items() if k in molecules and v.get("cid")]
    bad = [v for v in found if v.get("match") is False]
    print(f"resolved {len(found)}/{len(molecules)}; {len(bad)} with a formula mismatch -> {OUT.relative_to(ROOT.parent)}")


if __name__ == "__main__":
    main()
