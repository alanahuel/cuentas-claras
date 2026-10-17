"""Seed only an empty, disposable demo directory; never accepts a real database."""
import os
import sys
from datetime import date
from pathlib import Path

root = Path(__file__).resolve().parents[1]
data = Path(os.environ.get("DATA_DIR", "")).resolve()
if data.name != "cuentas-demo" or (data.exists() and any(data.iterdir())):
    raise SystemExit("Use a new, empty DATA_DIR ending in cuentas-demo.")
sys.path.insert(0, str(root / "backend"))
from app.main import db, passwords, store_invoice, Invoice

with db() as con:
    con.execute(
        "INSERT INTO users(id,email,name,password,profile) VALUES(?,?,?,?,?)",
        ("demo", "demo@example.test", "Demostración", passwords.hash("synthetic-demo-only"),
         '{"regime":"direct_normal","vat_regime":"general","irpf_required":"yes"}'),
    )
rows = [
    ("Estudio de ejemplo", "income", 145000, "confirmed", "Servicios profesionales"),
    ("Papelería de ejemplo", "expense", 8750, "confirmed", "Material"),
    ("Cliente de ejemplo", "income", 98000, "confirmed", "Servicios profesionales"),
    ("Software de ejemplo", "expense", 4900, "confirmed", "Software"),
    ("Proveedor de ejemplo", "expense", 16200, "draft", "Suministros"),
]
for index, (party, kind, base, status, category) in enumerate(rows):
    store_invoice(Invoice(
        kind=kind, status=status, date=date.today().replace(day=1).isoformat(),
        number=f"DEMO-{index + 1:03d}", party=party, nif=f"B1234567{index}", category=category,
        lines=[{"base": base, "vat_rate": 21}], request_id=f"synthetic-demo-{index}",
    ), {"id": "demo"})
