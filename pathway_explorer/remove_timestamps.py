"""Copy files from results/synthesis_nets_inchi_corrected/ to
synt_net_vis/synthesis_networks/ with YYYYMMDD_HHMMSS timestamps stripped."""

import re
import shutil
from pathlib import Path

SRC_DIR = "results/synthesis_nets_inchi_corrected"
DST_DIR = "synt_net_vis/synthesis_networks"
TIMESTAMP_RE = re.compile(r"_\d{8}_\d{6}")

base = Path(__file__).parent.parent
src_base = base / SRC_DIR
dst_base = base / DST_DIR

if not src_base.is_dir():
    print(f"Source not found: {SRC_DIR}/")
    exit(1)

for model_dir in sorted(src_base.iterdir()):
    if not model_dir.is_dir():
        continue
    dst_model_dir = dst_base / model_dir.name
    dst_model_dir.mkdir(parents=True, exist_ok=True)
    for f in sorted(model_dir.iterdir()):
        if not f.is_file():
            continue
        new_name = TIMESTAMP_RE.sub("", f.name)
        dst_path = dst_model_dir / new_name
        if dst_path.exists():
            print(f"SKIP (exists): [{model_dir.name}] {new_name}")
            continue
        shutil.copy2(f, dst_path)
        print(f"[{model_dir.name}] {f.name} -> {new_name}")

print("\nDone.")
