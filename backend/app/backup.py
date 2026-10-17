"""Consistent local snapshot; pipe/archive it into an encrypted backup repository."""

import argparse, json, os, shutil, sqlite3
from pathlib import Path
from .main import DATA, DB, db

parser = argparse.ArgumentParser()
parser.add_argument("destination", type=Path)
args = parser.parse_args()
target = args.destination.resolve()
if target.exists():
    raise SystemExit("El destino debe ser una carpeta nueva.")
if target == DATA or DATA in target.parents:
    raise SystemExit("Guarda la copia fuera del directorio de datos.")
target.mkdir(parents=True, mode=0o700)
# Lock writers while DB and referenced immutable originals are snapshotted.
with db() as con:
    con.execute("BEGIN IMMEDIATE")
    with (
        sqlite3.connect(DB) as source,
        sqlite3.connect(target / "accounts.sqlite") as dest,
    ):
        source.backup(dest)
    (target / "documents").mkdir(mode=0o700)
    rows = con.execute("SELECT id,path FROM documents").fetchall()
    for row in rows:
        shutil.copyfile(row["path"], target / "documents" / row["id"])
    # Restore in any directory: relocate absolute document paths during restoration.
    (target / "manifest.json").write_text(
        json.dumps(
            {"format": 1, "documents": len(rows), "original_data_dir": str(DATA)}
        )
    )
for file in target.rglob("*"):
    if file.is_file():
        os.chmod(file, 0o600)
print(f"Copia consistente creada: {target}. Debe cifrarse antes de transferirla.")
