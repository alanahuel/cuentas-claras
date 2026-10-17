"""Restore a snapshot into an EMPTY data directory, with the service stopped."""

import argparse, hashlib, json, os, shutil, sqlite3
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("snapshot", type=Path)
parser.add_argument("destination", type=Path)
args = parser.parse_args()
source = args.snapshot.resolve()
target = args.destination.resolve()
if target.exists() and any(target.iterdir()):
    raise SystemExit(
        "El destino debe estar vacío; detén el servicio antes de restaurar."
    )
manifest = json.loads((source / "manifest.json").read_text())
if manifest["format"] != 1:
    raise SystemExit("Formato no compatible.")
with sqlite3.connect(source / "accounts.sqlite") as con:
    if con.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise SystemExit("Copia de base de datos dañada.")
    docs = con.execute("SELECT id,digest FROM documents").fetchall()
    for identifier, digest in docs:
        if (
            hashlib.sha256((source / "documents" / identifier).read_bytes()).hexdigest()
            != digest
        ):
            raise SystemExit("Documento dañado: " + identifier)
shutil.copytree(source, target, dirs_exist_ok=True)
os.chmod(target, 0o700)
with sqlite3.connect(target / "accounts.sqlite") as con:
    con.execute("DELETE FROM sessions")
    for identifier, _ in docs:
        con.execute(
            "UPDATE documents SET path=? WHERE id=?",
            (str(target / "documents" / identifier), identifier),
        )
print(
    "Copia restaurada; sesiones revocadas. Arranca el servicio apuntando a este directorio."
)
