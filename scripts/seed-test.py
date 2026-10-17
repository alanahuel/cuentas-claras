"""Synthetic browser-test data only. Refuses to touch a non-test database."""
import os,sys,uuid
sys.path.insert(0,str(__import__('pathlib').Path(__file__).resolve().parents[1]/'backend'))
if not os.getenv('DATA_DIR','').endswith('cuentas-e2e'): raise SystemExit('Use an isolated cuentas-e2e directory.')
from app.main import db,passwords,store_invoice,Invoice
with db() as con:
    for uid,name in [('demo','Demostración'),('test','Pruebas')]:
        con.execute('INSERT OR IGNORE INTO users(id,email,name,password,profile) VALUES(?,?,?,?,?)',(uid,uid+'@example.test',name,passwords.hash('solo-pruebas-locales'),'{"regime":"direct_normal","vat_regime":"general","irpf_required":"yes","previous_net":1800000}'))
for n,(party,kind,base,status,category) in enumerate([('Estudio de ejemplo','income',145000,'confirmed','Servicios profesionales'),('Papelería de ejemplo','expense',8750,'confirmed','Material'),('Cliente de ejemplo','income',98000,'confirmed','Servicios profesionales'),('Software de ejemplo','expense',4900,'confirmed','Software'),('Proveedor de ejemplo','expense',16200,'draft','Suministros')]):
    store_invoice(Invoice(kind=kind,status=status,date=f'2026-09-{22-n*3:02d}',number=f'DEMO-{n+1:03d}',party=party,nif=f'B1234567{n}',category=category,lines=[{'base':base,'vat_rate':21}],request_id=f'demo-record-{n}'),{'id':'demo'})
