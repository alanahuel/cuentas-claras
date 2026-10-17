import argparse, getpass, uuid
from .main import db, passwords

parser = argparse.ArgumentParser()
parser.add_argument("command", choices=["create-user", "reset-password"])
parser.add_argument("--email", required=True)
parser.add_argument("--name")
args = parser.parse_args()
password = getpass.getpass("Contraseña (mínimo 12 caracteres): ")
if len(password) < 12:
    raise SystemExit("Usa al menos 12 caracteres.")
if password != getpass.getpass("Repite la contraseña: "):
    raise SystemExit("Las contraseñas no coinciden.")
email = args.email.strip().lower()
if "@" not in email:
    raise SystemExit("Correo no válido.")
with db() as con:
    if args.command == "create-user":
        if not args.name:
            raise SystemExit("Indica --name.")
        con.execute(
            "INSERT INTO users(id,email,name,password) VALUES(?,?,?,?)",
            (str(uuid.uuid4()), email, args.name, passwords.hash(password)),
        )
    else:
        row = con.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
        if not row:
            raise SystemExit("Cuenta no encontrada.")
        con.execute(
            "UPDATE users SET password=? WHERE id=?",
            (passwords.hash(password), row["id"]),
        )
        con.execute("DELETE FROM sessions WHERE user_id=?", (row["id"],))
print("Cuenta actualizada.")
