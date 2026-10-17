import shutil, tempfile
from starlette.background import BackgroundTask
import csv, hashlib, io, json, os, re, secrets, sqlite3, time, uuid
from contextlib import contextmanager, nullcontext
from datetime import date
from pathlib import Path
from typing import Literal
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, InvalidHashError
from fastapi import FastAPI, Request, Response, HTTPException, UploadFile, Depends
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ConfigDict, field_validator
from .tax import percentage, summarize

DATA = Path(os.getenv("DATA_DIR", "./data")).resolve()
DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
(DATA / "documents").mkdir(exist_ok=True, mode=0o700)
DB = DATA / "accounts.sqlite"
SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"
ORIGIN = os.getenv("APP_ORIGIN", "http://localhost:8000").rstrip("/")
passwords = PasswordHasher()
DUMMY_HASH = passwords.hash(secrets.token_urlsafe(24))
app = FastAPI(title="Cuentas", docs_url=None, redoc_url=None)


@contextmanager
def db():
    con = sqlite3.connect(DB, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


with db() as con:
    con.executescript("""
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,profile TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,mime TEXT NOT NULL,digest TEXT NOT NULL,path TEXT NOT NULL,UNIQUE(user_id,digest));
    CREATE TABLE IF NOT EXISTS invoices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),document_id TEXT REFERENCES documents(id),kind TEXT NOT NULL,status TEXT NOT NULL,date TEXT NOT NULL,number TEXT NOT NULL,party TEXT NOT NULL,nif TEXT NOT NULL,category TEXT NOT NULL,lines TEXT NOT NULL,withholding INTEGER NOT NULL,base INTEGER NOT NULL,vat INTEGER NOT NULL,deductible_base INTEGER NOT NULL,deductible_vat INTEGER NOT NULL,total INTEGER NOT NULL,note TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,request_id TEXT NOT NULL,UNIQUE(user_id,request_id));
    CREATE UNIQUE INDEX IF NOT EXISTS invoice_number ON invoices(user_id,kind,nif,number) WHERE status='confirmed' AND number<>'';
    CREATE TABLE IF NOT EXISTS adjustments(user_id TEXT NOT NULL REFERENCES users(id),year INTEGER NOT NULL,quarter INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(user_id,year,quarter));
    CREATE TABLE IF NOT EXISTS agencies(user_id TEXT PRIMARY KEY REFERENCES users(id),name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS client_access(manager_id TEXT NOT NULL REFERENCES users(id),client_id TEXT NOT NULL REFERENCES users(id),managed INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(manager_id,client_id));
    CREATE TABLE IF NOT EXISTS agency_invites(token TEXT PRIMARY KEY,manager_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,label TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS savings(user_id TEXT NOT NULL REFERENCES users(id),year INTEGER NOT NULL,quarter INTEGER NOT NULL,amount INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,year,quarter));
    CREATE TABLE IF NOT EXISTS tax_payments(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,year INTEGER NOT NULL,month INTEGER NOT NULL,vat INTEGER NOT NULL,irpf INTEGER NOT NULL,other INTEGER NOT NULL,PRIMARY KEY(user_id,year,month));
    CREATE TABLE IF NOT EXISTS document_analyses(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,state TEXT NOT NULL,result TEXT,started INTEGER NOT NULL,request_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invoice_checks(invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,document_id TEXT NOT NULL,digest TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,reading TEXT,started INTEGER NOT NULL,request_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pending_file_deletions(path TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,action TEXT NOT NULL,entity TEXT,at INTEGER NOT NULL);
    """)
with db() as con:
    if "actor_id" not in {r[1] for r in con.execute("PRAGMA table_info(audit)")}:
        con.execute("ALTER TABLE audit ADD COLUMN actor_id TEXT")
with db() as con:
    if "enabled" not in {r[1] for r in con.execute("PRAGMA table_info(agencies)")}:
        con.execute("ALTER TABLE agencies ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1")
    invoice_columns = {r[1] for r in con.execute("PRAGMA table_info(invoices)")}
    for column, default in (("review_state", "draft"), ("review_note", "")):
        if column not in invoice_columns:
            con.execute(f"ALTER TABLE invoices ADD COLUMN {column} TEXT NOT NULL DEFAULT '{default}'")
    con.execute("""CREATE TABLE IF NOT EXISTS invoice_reviews(
        id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, invoice_id TEXT NOT NULL
        REFERENCES invoices(id) ON DELETE CASCADE, action TEXT NOT NULL,
        actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, at INTEGER NOT NULL,
        version INTEGER NOT NULL, comment TEXT NOT NULL DEFAULT '')""")
with db() as con:
    con.executescript("""
    CREATE TABLE IF NOT EXISTS team_members(
        manager_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined INTEGER NOT NULL, PRIMARY KEY(manager_id,member_id));
    CREATE TABLE IF NOT EXISTS team_assignments(
        manager_id TEXT NOT NULL, member_id TEXT NOT NULL, client_id TEXT NOT NULL,
        PRIMARY KEY(manager_id,member_id,client_id),
        FOREIGN KEY(manager_id,member_id) REFERENCES team_members(manager_id,member_id) ON DELETE CASCADE,
        FOREIGN KEY(manager_id,client_id) REFERENCES client_access(manager_id,client_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS team_invites(
        id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL,
        manager_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email TEXT NOT NULL, expires INTEGER NOT NULL, UNIQUE(manager_id,email));
    """)
with db() as con:
    con.executescript("""
    CREATE TABLE IF NOT EXISTS service_requests(
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        created INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS service_messages(
        id INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, role TEXT NOT NULL,
        body TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS service_requests_client ON service_requests(user_id,status);
    """)
with db() as con:
    if "account_scope" not in {r[1] for r in con.execute("PRAGMA table_info(users)")}:
        con.execute("ALTER TABLE users ADD COLUMN account_scope TEXT NOT NULL DEFAULT 'personal'")
        con.execute("UPDATE users SET account_scope='agency_client' WHERE password='!no-login'")
    con.execute("""CREATE TABLE IF NOT EXISTS client_activation(
        client_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        manager_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,email TEXT NOT NULL,expires INTEGER NOT NULL)""")
with db() as con:
    con.execute("""CREATE TABLE IF NOT EXISTS report_shares(
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
        year INTEGER NOT NULL, quarter INTEGER NOT NULL, snapshot TEXT NOT NULL)""")
os.chmod(DB, 0o600)


@app.middleware("http")
async def headers(request, call_next):
    response = await call_next(request)
    response.headers.update(
        {
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "same-origin",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; media-src 'self' blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
        }
    )
    if (
        request.url.path.startswith("/api")
        or request.url.path in ("/", "/index.html", "/sw.js")
        or response.headers.get("content-type", "").startswith("text/html")
    ):
        response.headers["Cache-Control"] = "no-store"
    if request.url.path.startswith(("/api/reports", "/api/shared-reports", "/api/report-assets")):
        response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive, nosnippet"
        response.headers["Referrer-Policy"] = "no-referrer"
    if SECURE:
        response.headers["Strict-Transport-Security"] = "max-age=31536000"
    return response


def audit(con, uid, action, entity="", actor=None):
    con.execute(
        "INSERT INTO audit(user_id,action,entity,at,actor_id) VALUES(?,?,?,?,?)",
        (uid, action, entity, int(time.time()), actor or uid),
    )


def origin_check(request):
    if request.headers.get("origin") != ORIGIN:
        raise HTTPException(403, "Origen de la solicitud no permitido.")


def client_access_active(con, user):
    return user["account_scope"] != "agency_client" or bool(con.execute(
        "SELECT 1 FROM client_access c JOIN agencies a ON a.user_id=c.manager_id WHERE c.client_id=? AND c.archived=0 AND a.enabled=1", (user["id"],)
    ).fetchone())


def suspend_client_sessions(con):
    con.execute("""DELETE FROM sessions WHERE user_id IN (
        SELECT u.id FROM users u WHERE u.account_scope='agency_client'
        AND NOT EXISTS(SELECT 1 FROM client_access c JOIN agencies a ON a.user_id=c.manager_id
        WHERE c.client_id=u.id AND c.archived=0 AND a.enabled=1))""")


def current_user(request: Request):
    token = hashlib.sha256(request.cookies.get("session", "").encode()).hexdigest()
    with db() as con:
        row = con.execute(
            "SELECT users.*,sessions.csrf FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>?",
            (token, int(time.time())),
        ).fetchone()
    if not row:
        raise HTTPException(401, "Inicia sesión para continuar.")
    with db() as con:
        if not client_access_active(con, row):
            raise HTTPException(401, "El acceso de cliente está desactivado. Contacta con tu gestoría.")
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin_check(request)
        if not secrets.compare_digest(
            request.headers.get("x-csrf-token", ""), row["csrf"]
        ):
            raise HTTPException(403, "La sesión ha cambiado. Recarga la página.")
    return dict(row)


from .chat import install_chat
install_chat(app, db, current_user)
from .assistant import install_assistant
install_assistant(app, db, current_user)

def workspace_user(request: Request, actor=Depends(current_user)):
    target = (
        request.headers.get("x-workspace-id")
        or request.query_params.get("workspace")
        or actor["id"]
    )
    if target == actor["id"]:
        return {**actor, "actor_id": actor["id"]}
    with db() as con:
        access = con.execute(
            "SELECT client_access.managed FROM client_access JOIN agencies ON agencies.user_id=client_access.manager_id WHERE manager_id=? AND client_id=? AND archived=0 AND agencies.enabled=1",
            (actor["id"], target),
        ).fetchone()
        if not access:
            access = con.execute(
                "SELECT c.managed FROM team_assignments t "
                "JOIN team_members m ON m.manager_id=t.manager_id AND m.member_id=t.member_id "
                "JOIN client_access c ON c.manager_id=t.manager_id AND c.client_id=t.client_id "
                "JOIN agencies a ON a.user_id=t.manager_id "
                "WHERE t.member_id=? AND t.client_id=? AND c.archived=0 AND a.enabled=1 LIMIT 1",
                (actor["id"], target),
            ).fetchone()
        row = (
            con.execute("SELECT * FROM users WHERE id=?", (target,)).fetchone()
            if access
            else None
        )
    if not row:
        raise HTTPException(
            403,
            "No tienes acceso a este cliente. Vuelve a tu espacio o revisa la autorización.",
        )
    # Never delegate credentials, sessions or account deletion.
    return {
        "id": row["id"],
        "name": row["name"],
        "email": "" if access["managed"] else row["email"],
        "profile": row["profile"],
        "account_scope": row["account_scope"],
        "csrf": actor["csrf"],
        "actor_id": actor["id"],
        "delegated": True,
    }


def require_agency(user):
    with db() as con:
        if not con.execute(
            "SELECT 1 FROM agencies WHERE user_id=? AND enabled=1", (user["id"],)
        ).fetchone():
            raise HTTPException(403, "Activa primero tu espacio de gestoría.")


class AgencyName(BaseModel):
    name: str = Field(min_length=2, max_length=100)


@app.put("/api/agency")
def activate_agency(body: AgencyName, user=Depends(current_user)):
    if user["account_scope"] == "agency_client":
        raise HTTPException(403, "Una cuenta de cliente no puede administrar una gestoría.")
    with db() as con:
        con.execute(
            "INSERT INTO agencies(user_id,name) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,enabled=1",
            (user["id"], body.name.strip()),
        )
    return {"ok": True}


@app.post("/api/agency/deactivate")
def deactivate_agency(user=Depends(current_user)):
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        con.execute("UPDATE agencies SET enabled=0 WHERE user_id=?", (user["id"],))
        con.execute("DELETE FROM agency_invites WHERE manager_id=?", (user["id"],))
        con.execute("DELETE FROM team_invites WHERE manager_id=?", (user["id"],))
        con.execute("DELETE FROM client_activation WHERE manager_id=?", (user["id"],))
        suspend_client_sessions(con)
        audit(con, user["id"], "agency.deactivate")
    return {"ok": True}


@app.get("/api/workspaces")
def workspaces(user=Depends(current_user)):
    with db() as con:
        agency = con.execute(
            "SELECT name,enabled FROM agencies WHERE user_id=?", (user["id"],)
        ).fetchone()
        clients = [dict(r) for r in con.execute(
            "SELECT u.id,u.name,u.account_scope,(u.password<>'!no-login') AS has_login,c.managed,c.archived,1 AS can_manage,a.name AS agency_name,"
            "(SELECT COUNT(*) FROM invoices i WHERE i.user_id=u.id AND status='draft') AS pending,"
            "(SELECT COUNT(*) FROM documents d WHERE d.user_id=u.id AND NOT EXISTS(SELECT 1 FROM invoices i WHERE i.document_id=d.id)) AS unattached "
            "FROM client_access c JOIN users u ON u.id=c.client_id JOIN agencies a ON a.user_id=c.manager_id "
            "WHERE c.manager_id=? AND a.enabled=1", (user["id"],)
        )]
        assigned = [dict(r) for r in con.execute(
            "SELECT u.id,u.name,u.account_scope,(u.password<>'!no-login') AS has_login,c.managed,c.archived,0 AS can_manage,a.name AS agency_name,"
            "(SELECT COUNT(*) FROM invoices i WHERE i.user_id=u.id AND status='draft') AS pending,"
            "(SELECT COUNT(*) FROM documents d WHERE d.user_id=u.id AND NOT EXISTS(SELECT 1 FROM invoices i WHERE i.document_id=d.id)) AS unattached "
            "FROM team_assignments t JOIN team_members m ON m.manager_id=t.manager_id AND m.member_id=t.member_id "
            "JOIN client_access c ON c.manager_id=t.manager_id AND c.client_id=t.client_id "
            "JOIN agencies a ON a.user_id=t.manager_id JOIN users u ON u.id=t.client_id "
            "WHERE t.member_id=? AND a.enabled=1 AND c.archived=0", (user["id"],)
        )]
        owned_clients = list(clients)
        # A client can be shared by several agencies; show each workspace once.
        combined = sorted(clients + assigned, key=lambda c: (c["archived"], -c["can_manage"], c["name"], c["agency_name"]))
        clients = list({c["id"]: c for c in reversed(combined)}.values())
        clients.sort(key=lambda c: (c["archived"], c["name"]))
        memberships = [dict(r) for r in con.execute(
            "SELECT a.user_id AS id,a.name,a.enabled,m.joined FROM team_members m JOIN agencies a ON a.user_id=m.manager_id WHERE m.member_id=? ORDER BY a.name",
            (user["id"],),
        )]
        managers = [
            dict(r)
            for r in con.execute(
                "SELECT a.manager_id AS id,g.name,g.enabled,a.archived FROM client_access a JOIN agencies g ON g.user_id=a.manager_id WHERE a.client_id=?",
                (user["id"],),
            )
        ]
    return {
        "agency": agency["name"] if agency and agency["enabled"] else None,
        "inactive_agency": agency["name"] if agency and not agency["enabled"] else None,
        "account_scope": user["account_scope"],
        "clients": clients,
        "memberships": memberships,
        "owned_clients": owned_clients,
        "managers": managers,
    }


@app.get("/api/advisor/workbench")
def advisor_workbench(user=Depends(current_user)):
    spaces = workspaces(user)
    clients = [c for c in spaces["clients"] if not c["archived"] and c["id"] != user["id"]]
    items = []
    with db() as con:
        for c in clients:
            rows = con.execute("SELECT id,date,number,party,review_state FROM invoices WHERE user_id=? AND status='draft' ORDER BY date,id", (c["id"],)).fetchall()
            c["submitted"] = sum(r["review_state"] == "submitted" for r in rows)
            c["changes_requested"] = sum(r["review_state"] == "changes_requested" for r in rows)
            c["requests_open"] = con.execute("SELECT COUNT(*) FROM service_requests WHERE user_id=? AND status='open'", (c["id"],)).fetchone()[0]
            c["requests_answered"] = con.execute("SELECT COUNT(*) FROM service_requests WHERE user_id=? AND status='answered'", (c["id"],)).fetchone()[0]
            for r in rows:
                if r["review_state"] == "submitted":
                    items.append({**dict(r), "client_id": c["id"], "client_name": c["name"]})
    items.sort(key=lambda r: (r["date"], r["client_name"], r["id"]))
    return {"clients": clients, "reviews": items}


class ServiceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=160)
    body: str = Field(min_length=1, max_length=3000)

    @field_validator("title", "body")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("Escribe el contenido de la solicitud.")
        return value.strip()


class ServiceReply(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)
    action: Literal["reply", "resolve", "reopen"] = "reply"
    body: str = Field(default="", max_length=3000)


def service_rows(con, uid):
    rows = [dict(r) for r in con.execute("SELECT * FROM service_requests WHERE user_id=? ORDER BY created DESC,id", (uid,))]
    for row in rows:
        row["messages"] = [dict(m) for m in con.execute("SELECT actor_name,role,body,at FROM service_messages WHERE request_id=? ORDER BY id", (row["id"],))]
    return rows


def service_message(con, rid, user, body):
    actor = user.get("actor_id", user["id"])
    name = con.execute("SELECT name FROM users WHERE id=?", (actor,)).fetchone()[0]
    con.execute("INSERT INTO service_messages(request_id,actor_id,actor_name,role,body,at) VALUES(?,?,?,?,?,?)", (rid, actor, name, "advisor" if user.get("delegated") else "client", body, int(time.time())))


@app.get("/api/service-requests")
def service_requests(user=Depends(workspace_user)):
    with db() as con:
        return service_rows(con, user["id"])


@app.post("/api/service-requests")
def create_service_request(body: ServiceRequest, user=Depends(workspace_user)):
    if not user.get("delegated"):
        raise HTTPException(403, "Las solicitudes las inicia la gestoría desde el expediente del cliente.")
    rid = str(uuid.uuid4())
    with db() as con:
        con.execute("INSERT INTO service_requests(id,user_id,title,created) VALUES(?,?,?,?)", (rid,user["id"],body.title,int(time.time())))
        service_message(con, rid, user, body.body)
        audit(con,user["id"],"request.create",rid,actor=user["actor_id"])
    return {"id": rid}


@app.post("/api/service-requests/{rid}")
def update_service_request(rid: str, body: ServiceReply, user=Depends(workspace_user)):
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute("SELECT * FROM service_requests WHERE id=? AND user_id=?", (rid,user["id"])).fetchone()
        if not row:
            raise HTTPException(404,"No se encuentra esta solicitud.")
        if row["version"] != body.version:
            raise HTTPException(409,"Hay una respuesta nueva. Actualiza las solicitudes antes de continuar.")
        if body.action != "reply" and not user.get("delegated"):
            raise HTTPException(403,"La gestoría debe comprobar y resolver la solicitud.")
        if body.action == "reply" and (not body.body.strip() or row["status"] == "resolved"):
            raise HTTPException(400,"Escribe una respuesta en una solicitud abierta.")
        status = ("open" if user.get("delegated") else "answered") if body.action == "reply" else ("resolved" if body.action == "resolve" else "open")
        message = body.body.strip() if body.action == "reply" else ("Solicitud resuelta." if body.action == "resolve" else "Solicitud reabierta.")
        con.execute("UPDATE service_requests SET status=?,version=version+1 WHERE id=?", (status,rid))
        service_message(con,rid,user,message)
        audit(con,user["id"],"request."+body.action,rid,actor=user.get("actor_id"))
    return {"ok": True}


def active_team_owner(con, uid):
    if not con.execute("SELECT 1 FROM agencies WHERE user_id=? AND enabled=1", (uid,)).fetchone():
        raise HTTPException(403, "Solo la persona titular de una gestoría activa puede administrar su equipo.")


@app.get("/api/team")
def team(user=Depends(current_user)):
    with db() as con:
        active_team_owner(con, user["id"])
        members = [dict(r) for r in con.execute(
            "SELECT u.id,u.name,u.email,m.joined FROM team_members m JOIN users u ON u.id=m.member_id WHERE m.manager_id=? ORDER BY u.name",
            (user["id"],),
        )]
        for member in members:
            member["client_ids"] = [r[0] for r in con.execute(
                "SELECT client_id FROM team_assignments WHERE manager_id=? AND member_id=? ORDER BY client_id",
                (user["id"], member["id"]),
            )]
        invitations = [dict(r) for r in con.execute(
            "SELECT id,email,expires FROM team_invites WHERE manager_id=? AND expires>? ORDER BY email",
            (user["id"], int(time.time())),
        )]
    return {"members": members, "invitations": invitations}


class TeamInvite(BaseModel):
    email: str = Field(min_length=3, max_length=254)

    @field_validator("email")
    @classmethod
    def email_address(cls, value):
        value = value.strip().lower()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("Indica un correo válido.")
        return value


@app.post("/api/team/invitations")
def invite_team_member(body: TeamInvite, user=Depends(current_user)):
    token, invite_id = secrets.token_urlsafe(32), str(uuid.uuid4())
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        active_team_owner(con, user["id"])
        if body.email == user["email"].lower():
            raise HTTPException(422, "Ya administras esta gestoría.")
        if con.execute("SELECT 1 FROM team_members m JOIN users u ON u.id=m.member_id WHERE m.manager_id=? AND u.email=?", (user["id"], body.email)).fetchone():
            raise HTTPException(409, "Esta persona ya pertenece al equipo.")
        con.execute("DELETE FROM team_invites WHERE (manager_id=? AND email=?) OR expires<?", (user["id"], body.email, int(time.time())))
        con.execute("INSERT INTO team_invites VALUES(?,?,?,?,?)", (invite_id, hashlib.sha256(token.encode()).hexdigest(), user["id"], body.email, int(time.time()) + 86400))
        audit(con, user["id"], "team.invite", invite_id)
    return {"id": invite_id, "code": token, "email": body.email}


@app.delete("/api/team/invitations/{invite_id}")
def cancel_team_invite(invite_id: str, user=Depends(current_user)):
    with db() as con:
        active_team_owner(con, user["id"])
        if not con.execute("DELETE FROM team_invites WHERE id=? AND manager_id=?", (invite_id, user["id"])).rowcount:
            raise HTTPException(404, "Invitación no encontrada.")
        audit(con, user["id"], "team.invite_cancel", invite_id)
    return {"ok": True}


class TeamCode(BaseModel):
    code: str = Field(min_length=20, max_length=100)
    accept: bool = False


@app.post("/api/team/join")
def join_team(body: TeamCode, user=Depends(current_user)):
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute(
            "SELECT i.id,i.manager_id,a.name FROM team_invites i JOIN agencies a ON a.user_id=i.manager_id "
            "WHERE i.token=? AND i.email=? AND i.expires>? AND a.enabled=1",
            (hashlib.sha256(body.code.strip().encode()).hexdigest(), user["email"].lower(), int(time.time())),
        ).fetchone()
        if not row or row["manager_id"] == user["id"]:
            raise HTTPException(404, "Código inválido, caducado o destinado a otra cuenta. Inicia sesión con el correo de la invitación.")
        if body.accept:
            con.execute("INSERT OR IGNORE INTO team_members VALUES(?,?,?)", (row["manager_id"], user["id"], int(time.time())))
            con.execute("DELETE FROM team_invites WHERE id=?", (row["id"],))
            audit(con, row["manager_id"], "team.join", user["id"], actor=user["id"])
    return {"name": row["name"], "accepted": body.accept}


class AssignClients(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_ids: list[str] = Field(max_length=1000)


@app.put("/api/team/members/{member_id}/clients")
def assign_team_clients(member_id: str, body: AssignClients, user=Depends(current_user)):
    requested = set(body.client_ids)
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        active_team_owner(con, user["id"])
        if not con.execute("SELECT 1 FROM team_members WHERE manager_id=? AND member_id=?", (user["id"], member_id)).fetchone():
            raise HTTPException(404, "Colaborador no encontrado.")
        owned = {r[0] for r in con.execute("SELECT client_id FROM client_access WHERE manager_id=?", (user["id"],))}
        if not requested.issubset(owned) or member_id in requested:
            raise HTTPException(422, "Asigna únicamente clientes de tu gestoría distintos de la propia cuenta del colaborador.")
        previous = {r[0] for r in con.execute("SELECT client_id FROM team_assignments WHERE manager_id=? AND member_id=?", (user["id"], member_id))}
        con.execute("DELETE FROM team_assignments WHERE manager_id=? AND member_id=?", (user["id"], member_id))
        con.executemany("INSERT INTO team_assignments VALUES(?,?,?)", [(user["id"], member_id, cid) for cid in sorted(requested)])
        audit(con, user["id"], "team.assign", member_id)
        for cid in previous ^ requested:
            audit(con, cid, "team.assigned" if cid in requested else "team.unassigned", member_id, actor=user["id"])
    return {"ok": True}


@app.delete("/api/team/members/{member_id}")
def remove_team_member(member_id: str, user=Depends(current_user)):
    with db() as con:
        active_team_owner(con, user["id"])
        if not con.execute("DELETE FROM team_members WHERE manager_id=? AND member_id=?", (user["id"], member_id)).rowcount:
            raise HTTPException(404, "Colaborador no encontrado.")
        audit(con, user["id"], "team.remove", member_id)
    return {"ok": True}


@app.delete("/api/team/memberships/{manager_id}")
def leave_team(manager_id: str, user=Depends(current_user)):
    with db() as con:
        con.execute("DELETE FROM team_members WHERE manager_id=? AND member_id=?", (manager_id, user["id"]))
        audit(con, manager_id, "team.leave", user["id"], actor=user["id"])
    return {"ok": True}


@app.get("/api/workspace")
def workspace(user=Depends(workspace_user)):
    return {
        **{k: user[k] for k in ("id", "name", "email", "csrf", "account_scope")},
        "profile": json.loads(user["profile"]),
        "delegated": user.get("delegated", False),
    }


class ClientCreation(AgencyName):
    email: str = Field(default="", max_length=254)


class ClientEmail(BaseModel):
    email: str = Field(min_length=3, max_length=254)


def make_client_activation(con, uid, manager_id, raw_email):
    email = raw_email.strip().lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+",email) or email.endswith("@managed.invalid"):
        raise HTTPException(422,"Introduce el correo real del cliente.")
    row = con.execute("SELECT password FROM users WHERE id=?", (uid,)).fetchone()
    if not row or row["password"] != "!no-login":
        raise HTTPException(409,"Este cliente ya tiene acceso propio. No se puede sustituir su contraseña mediante una invitación.")
    if con.execute("SELECT 1 FROM users WHERE email=? AND id<>?", (email,uid)).fetchone():
        raise HTTPException(409,"Este correo ya tiene cuenta. Vincúlala desde Invitaciones y accesos; no crees otra cuenta para la misma persona.")
    token = secrets.token_urlsafe(32)
    con.execute("INSERT INTO client_activation VALUES(?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET manager_id=excluded.manager_id,token=excluded.token,email=excluded.email,expires=excluded.expires",
        (uid,manager_id,hashlib.sha256(token.encode()).hexdigest(),email,int(time.time())+86400))
    return {"code":token,"email":email}


@app.post("/api/agency/clients")
def create_managed_client(body: ClientCreation, user=Depends(current_user)):
    require_agency(user)
    uid = str(uuid.uuid4())
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        con.execute("INSERT INTO users(id,email,name,password,account_scope) VALUES(?,?,?,?,?)",
            (uid,uid+"@managed.invalid",body.name.strip(),"!no-login","agency_client"))
        con.execute("INSERT INTO client_access(manager_id,client_id,managed) VALUES(?,?,1)",(user["id"],uid))
        activation=make_client_activation(con,uid,user["id"],body.email) if body.email else {}
        audit(con,uid,"client.create",actor=user["id"])
    return {"id":uid,**activation}


@app.post("/api/agency/clients/{client_id}/activation")
def invite_client_access(client_id: str, body: ClientEmail, user=Depends(current_user)):
    require_agency(user)
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        if not con.execute("SELECT 1 FROM client_access WHERE manager_id=? AND client_id=? AND managed=1 AND archived=0", (user["id"],client_id)).fetchone():
            raise HTTPException(403,"No puedes activar el acceso de este expediente.")
        result=make_client_activation(con,client_id,user["id"],body.email)
        audit(con,client_id,"client.invite",actor=user["id"])
        return result


class ClientActivation(BaseModel):
    code: str = Field(min_length=20,max_length=100)
    password: str | None = Field(default=None,min_length=12,max_length=256)


@app.post("/api/client-access")
def activate_client_access(body: ClientActivation, request: Request, response: Response):
    origin_check(request)
    # The one-use code is a credential; only its digest is stored.
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        row=con.execute("""SELECT i.*,u.name,a.name AS agency FROM client_activation i
          JOIN users u ON u.id=i.client_id JOIN agencies a ON a.user_id=i.manager_id
          JOIN client_access c ON c.manager_id=i.manager_id AND c.client_id=i.client_id
          WHERE i.token=? AND i.expires>? AND a.enabled=1 AND c.archived=0 AND u.password='!no-login'""",
          (hashlib.sha256(body.code.strip().encode()).hexdigest(),int(time.time()))).fetchone()
        if not row:
            raise HTTPException(404,"Invitación inválida o caducada. Pide una nueva a tu gestoría.")
        if body.password is None:
            return {"name":row["name"],"email":row["email"],"agency":row["agency"]}
        if con.execute("SELECT 1 FROM users WHERE email=? AND id<>?",(row["email"],row["client_id"])).fetchone():
            raise HTTPException(409,"Este correo ya tiene cuenta. Pide a tu gestoría que vincule tu cuenta existente.")
        con.execute("UPDATE users SET email=?,password=? WHERE id=?",(row["email"],passwords.hash(body.password),row["client_id"]))
        con.execute("DELETE FROM client_activation WHERE client_id=?",(row["client_id"],))
        audit(con,row["client_id"],"client.activate")
        activated=con.execute("SELECT * FROM users WHERE id=?",(row["client_id"],)).fetchone()
    return start_session(activated,request,response)


@app.post("/api/agency/invite")
def create_invite(user=Depends(current_user)):
    require_agency(user)
    token = secrets.token_urlsafe(32)
    with db() as con:
        con.execute(
            "DELETE FROM agency_invites WHERE manager_id=? OR expires<?",
            (user["id"], int(time.time())),
        )
        con.execute(
            "INSERT INTO agency_invites VALUES(?,?,?)",
            (
                hashlib.sha256(token.encode()).hexdigest(),
                user["id"],
                int(time.time()) + 86400,
            ),
        )
    return {"code": token}


@app.delete("/api/agency/invite")
def cancel_invite(user=Depends(current_user)):
    with db() as con:
        con.execute("DELETE FROM agency_invites WHERE manager_id=?", (user["id"],))
    return {"ok": True}


class InviteCode(BaseModel):
    code: str = Field(min_length=20, max_length=100)
    accept: bool = False


@app.post("/api/agency/connection")
def accept_invite(body: InviteCode, user=Depends(current_user)):
    digest = hashlib.sha256(body.code.strip().encode()).hexdigest()
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute(
            "SELECT i.manager_id,a.name FROM agency_invites i JOIN agencies a ON a.user_id=i.manager_id WHERE i.token=? AND i.expires>? AND a.enabled=1",
            (digest, int(time.time())),
        ).fetchone()
        if not row or row["manager_id"] == user["id"]:
            raise HTTPException(404, "Código inválido o caducado.")
        if body.accept:
            con.execute(
                "INSERT INTO client_access(manager_id,client_id) VALUES(?,?) ON CONFLICT(manager_id,client_id) DO UPDATE SET archived=0",
                (row["manager_id"], user["id"]),
            )
            con.execute("DELETE FROM agency_invites WHERE token=?", (digest,))
            audit(con, user["id"], "access.granted", row["manager_id"])
    return {"name": row["name"], "accepted": body.accept}


@app.delete("/api/agency/connections/{manager_id}")
def revoke_manager(manager_id: str, user=Depends(current_user)):
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        if user["account_scope"] == "agency_client":
            con.execute("UPDATE client_access SET archived=1 WHERE manager_id=? AND client_id=?",(manager_id,user["id"]))
            con.execute("DELETE FROM team_assignments WHERE manager_id=? AND client_id=?",(manager_id,user["id"]))
        else:
            con.execute("DELETE FROM client_access WHERE manager_id=? AND client_id=? AND managed=0",(manager_id,user["id"]))
        con.execute("DELETE FROM client_activation WHERE manager_id=? AND client_id=?",(manager_id,user["id"]))
        suspend_client_sessions(con)
        audit(con,user["id"],"access.revoked",manager_id)
        disabled=not client_access_active(con,user)
    return {"ok":True,"access_disabled":disabled}


class ClientState(BaseModel):
    archived: bool
    name: str | None = Field(default=None, min_length=2, max_length=100)


@app.put("/api/agency/clients/{client_id}")
def archive_client(client_id: str, body: ClientState, user=Depends(current_user)):
    require_agency(user)
    with db() as con:
        if body.name is not None:
            if not con.execute(
                "SELECT 1 FROM client_access WHERE manager_id=? AND client_id=? AND managed=1",
                (user["id"], client_id),
            ).fetchone():
                raise HTTPException(
                    403, "Solo puedes renombrar clientes creados por tu gestoría."
                )
            con.execute(
                "UPDATE users SET name=? WHERE id=?", (body.name.strip(), client_id)
            )
        if not con.execute(
            "UPDATE client_access SET archived=? WHERE manager_id=? AND client_id=?",
            (int(body.archived), user["id"], client_id),
        ).rowcount:
            raise HTTPException(404, "Cliente no encontrado.")
        if body.archived:
            con.execute("DELETE FROM client_activation WHERE client_id=? AND manager_id=?",(client_id,user["id"]))
        suspend_client_sessions(con)
        audit(con, client_id, "client.update", actor=user["id"])
    return {"ok": True}


@app.get("/api/activity")
def activity(user=Depends(workspace_user)):
    with db() as con:
        return [
            dict(r)
            for r in con.execute(
                "SELECT a.action,a.entity,a.at,COALESCE(u.name,'Cuenta eliminada') AS actor FROM audit a LEFT JOIN users u ON u.id=COALESCE(a.actor_id,a.user_id) WHERE a.user_id=? ORDER BY a.id DESC LIMIT 100",
                (user["id"],),
            )
        ]


class Credentials(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=256)


@app.post("/api/login")
def login(body: Credentials, request: Request, response: Response):
    origin_check(request)
    email = body.email.strip().lower()
    key = hashlib.sha256(
        (email + ":" + (request.client.host if request.client else "unknown")).encode()
    ).hexdigest()
    now = int(time.time())
    with db() as con:
        con.execute("DELETE FROM attempts WHERE reset<?", (now,))
        attempt = con.execute("SELECT * FROM attempts WHERE key=?", (key,)).fetchone()
        if attempt and attempt["count"] >= 8:
            raise HTTPException(429, "Demasiados intentos. Espera 15 minutos.")
        con.execute(
            "INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
            (key, now + 900),
        )
        row = con.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    try:
        passwords.verify(row["password"] if row else DUMMY_HASH, body.password)
        valid = row is not None
    except (VerifyMismatchError, InvalidHashError):
        valid = False
    if not valid:
        raise HTTPException(401, "El correo o la contraseña no son correctos.")
    with db() as con:
        con.execute("DELETE FROM attempts WHERE key=?", (key,))
    return start_session(row, request, response)


def start_session(row, request, response):
    with db() as con:
        if not client_access_active(con,row):
            raise HTTPException(403,"Tu acceso de cliente está desactivado porque no tienes una gestoría activa. Contacta con tu gestoría.")
    now = int(time.time())
    token, csrf = secrets.token_urlsafe(48), secrets.token_urlsafe(32)
    with db() as con:
        con.execute(
            "DELETE FROM sessions WHERE expires<? OR token=?",
            (
                now,
                hashlib.sha256(request.cookies.get("session", "").encode()).hexdigest(),
            ),
        )
        con.execute(
            "INSERT INTO sessions VALUES(?,?,?,?)",
            (hashlib.sha256(token.encode()).hexdigest(), row["id"], csrf, now + 43200),
        )
        audit(con, row["id"], "login")
    response.set_cookie(
        "session",
        token,
        httponly=True,
        secure=SECURE,
        samesite="strict",
        max_age=43200,
        path="/",
    )
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "csrf": csrf,
        "account_scope": row["account_scope"],
        "profile": json.loads(row["profile"]),
    }


class Registration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_type: Literal["personal", "agency"] = "personal"
    name: str = Field(min_length=2, max_length=100)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=12, max_length=256)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if len(value) < 2 or any(ord(c) < 32 for c in value):
            raise ValueError("Indica tu nombre.")
        return value

    @field_validator("email")
    @classmethod
    def clean_email(cls, value):
        value = value.strip().lower()
        if not re.fullmatch(
            r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+",
            value,
        ):
            raise ValueError("Introduce un correo válido.")
        return value

    @field_validator("password")
    @classmethod
    def password_not_blank(cls, value):
        if len(value.strip()) < 12:
            raise ValueError("Usa al menos 12 caracteres no vacíos.")
        return value


@app.post("/api/register", status_code=201)
def register(body: Registration, request: Request, response: Response):
    origin_check(request)
    now = int(time.time())
    address = request.client.host if request.client else "unknown"
    key = hashlib.sha256(("registration:" + address).encode()).hexdigest()
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        con.execute("DELETE FROM attempts WHERE reset<?", (now,))
        attempt = con.execute(
            "SELECT count FROM attempts WHERE key=?", (key,)
        ).fetchone()
        if attempt and attempt["count"] >= 10:
            raise HTTPException(
                429,
                "Se ha alcanzado el límite de registros. Inténtalo dentro de una hora.",
            )
        con.execute(
            "INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
            (key, now + 3600),
        )
    password_hash = passwords.hash(body.password)
    try:
        with db() as con:
            uid = str(uuid.uuid4())
            con.execute(
                "INSERT INTO users(id,email,name,password) VALUES(?,?,?,?)",
                (uid, body.email, body.name, password_hash),
            )
            if body.account_type == "agency":
                con.execute("INSERT INTO agencies(user_id,name) VALUES(?,?)", (uid, body.name))
            audit(con, uid, "account.register")
            row = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    except sqlite3.IntegrityError:
        raise HTTPException(
            409,
            "Ya existe una cuenta con ese correo. Inicia sesión o contacta con el administrador para recuperar el acceso.",
        )
    return start_session(row, request, response)


@app.get("/api/me")
def me(user=Depends(current_user)):
    return {
        **{k: user[k] for k in ("id", "name", "email", "csrf", "account_scope")},
        "profile": json.loads(user["profile"]),
    }


@app.post("/api/logout")
def logout(request: Request, response: Response, user=Depends(current_user)):
    with db() as con:
        con.execute(
            "DELETE FROM sessions WHERE token=?",
            (hashlib.sha256(request.cookies.get("session", "").encode()).hexdigest(),),
        )
        audit(con, user["id"], "logout")
    response.delete_cookie("session", path="/")
    return {"ok": True}


def purge_deleted_documents():
    """Keep failed file removals durable; retry on startup and account deletion."""
    with db() as con:
        for row in con.execute("SELECT path FROM pending_file_deletions").fetchall():
            path = Path(row["path"])
            if path.parent != DATA / "documents":
                continue
            try:
                path.unlink(missing_ok=True)
            except OSError:
                continue
            con.execute("DELETE FROM pending_file_deletions WHERE path=?", (str(path),))


purge_deleted_documents()


class AccountDeletion(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    confirmation: Literal["ELIMINAR"]


@app.delete("/api/account")
def delete_account(
    body: AccountDeletion, response: Response, user=Depends(current_user)
):
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        # Read again under the write lock so concurrent password changes take effect.
        row = con.execute(
            "SELECT password FROM users WHERE id=?", (user["id"],)
        ).fetchone()
        if not row:
            raise HTTPException(401, "La cuenta ya no existe.")
        try:
            passwords.verify(row["password"], body.current_password)
        except (VerifyMismatchError, InvalidHashError):
            raise HTTPException(400, "La contraseña actual no es correcta.")
        if con.execute(
            "SELECT 1 FROM client_access WHERE manager_id=? AND managed=1",
            (user["id"],),
        ).fetchone():
            raise HTTPException(
                409,
                "Esta gestoría conserva clientes gestionados. Solicita al administrador su transferencia antes de eliminar la cuenta.",
            )
        con.execute(
            "DELETE FROM client_access WHERE manager_id=? OR client_id=?",
            (user["id"], user["id"]),
        )
        con.execute("DELETE FROM agency_invites WHERE manager_id=?", (user["id"],))
        con.execute("DELETE FROM agencies WHERE user_id=?", (user["id"],))
        paths = [
            row["path"]
            for row in con.execute(
                "SELECT path FROM documents WHERE user_id=?", (user["id"],)
            )
        ]
        con.executemany(
            "INSERT OR IGNORE INTO pending_file_deletions(path) VALUES(?)",
            [(path,) for path in paths],
        )
        for table in (
            "sessions",
            "templates",
            "invoices",
            "documents",
            "adjustments",
            "savings",
            "audit",
        ):
            con.execute(f"DELETE FROM {table} WHERE user_id=?", (user["id"],))
        con.execute("DELETE FROM users WHERE id=?", (user["id"],))
    purge_deleted_documents()
    with db() as con:
        pending = any(
            con.execute(
                "SELECT 1 FROM pending_file_deletions WHERE path=?", (path,)
            ).fetchone()
            for path in paths
        )
    response.delete_cookie("session", path="/")
    return {"ok": True, "documents_pending": pending}


class PasswordChange(BaseModel):
    current_password: str = Field(max_length=256)
    new_password: str = Field(min_length=12, max_length=256)


@app.put("/api/password")
def change_password(body: PasswordChange, request: Request, user=Depends(current_user)):
    try:
        passwords.verify(user["password"], body.current_password)
    except (VerifyMismatchError, InvalidHashError):
        raise HTTPException(400, "La contraseña actual no es correcta.")
    current_token = hashlib.sha256(
        request.cookies.get("session", "").encode()
    ).hexdigest()
    with db() as con:
        con.execute(
            "UPDATE users SET password=? WHERE id=?",
            (passwords.hash(body.new_password), user["id"]),
        )
        con.execute(
            "DELETE FROM sessions WHERE user_id=? AND token<>?",
            (user["id"], current_token),
        )
        audit(con, user["id"], "password.change")
    return {"ok": True}


class Profile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    regime: Literal["unknown", "direct_normal", "direct_simplified", "modules"] = (
        "unknown"
    )
    vat_regime: Literal["unknown", "general", "special"] = "unknown"
    irpf_required: Literal["unknown", "yes", "no"] = "unknown"
    previous_net: int | None = Field(default=None, ge=-1000000000, le=1000000000)
    previous_net_year: int = Field(default=date.today().year - 1, ge=1999, le=2099)


@app.put("/api/profile")
def profile(body: Profile, user=Depends(workspace_user)):
    with db() as con:
        con.execute(
            "UPDATE users SET profile=? WHERE id=?",
            (body.model_dump_json(), user["id"]),
        )
        audit(con, user["id"], "profile.update", actor=user.get("actor_id"))
    return body.model_dump()


class Line(BaseModel):
    description: str = Field(default="", max_length=300)
    base: int = Field(ge=0, le=1000000000)
    vat_rate: Literal[0, 4, 10, 21] = 21
    irpf_deduct: int = Field(default=100, ge=0, le=100)
    vat_deduct: int = Field(default=100, ge=0, le=100)


class Invoice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["income", "expense"]
    status: Literal["draft", "confirmed"] = "draft"
    date: date
    number: str = Field(default="", max_length=100)
    party: str = Field(default="", max_length=200)
    nif: str = Field(default="", max_length=30)
    category: str = Field(default="Otros", max_length=80)
    lines: list[Line] = Field(min_length=1, max_length=100)
    withholding: int = Field(default=0, ge=0, le=1000000000)
    note: str = Field(default="", max_length=2000)
    document_id: str | None = None
    request_id: str = Field(min_length=8, max_length=100)
    version: int = Field(default=1, ge=1)
    review_action: Literal["save", "submit"] = "save"


class Template(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["client", "expense"]
    label: str = Field(min_length=1, max_length=100)
    party: str = Field(min_length=1, max_length=200)
    nif: str = Field(default="", max_length=30)
    category: str = Field(default="Otros", max_length=80)
    lines: list[Line] = Field(default_factory=list, max_length=100)
    withholding: int = Field(default=0, ge=0, le=1000000000)
    note: str = Field(default="", max_length=2000)


@app.get("/api/templates")
def templates(user=Depends(workspace_user)):
    with db() as con:
        return [
            {"id": r["id"], **json.loads(r["data"])}
            for r in con.execute(
                "SELECT * FROM templates WHERE user_id=? ORDER BY label", (user["id"],)
            )
        ]


@app.post("/api/templates")
def save_template(body: Template, user=Depends(workspace_user)):
    tid = str(uuid.uuid4())
    with db() as con:
        con.execute(
            "INSERT INTO templates VALUES(?,?,?,?,?)",
            (tid, user["id"], body.kind, body.label, body.model_dump_json()),
        )
        audit(con, user["id"], "template.save", tid, actor=user.get("actor_id"))
    return {"id": tid, **body.model_dump()}


@app.put("/api/templates/{tid}")
def update_template(tid: str, body: Template, user=Depends(workspace_user)):
    with db() as con:
        if not con.execute(
            "UPDATE templates SET kind=?,label=?,data=? WHERE id=? AND user_id=?",
            (body.kind, body.label, body.model_dump_json(), tid, user["id"]),
        ).rowcount:
            raise HTTPException(404, "Plantilla no encontrada.")
        audit(con, user["id"], "template.save", tid, actor=user.get("actor_id"))
    return {"id": tid, **body.model_dump()}


@app.delete("/api/templates/{tid}")
def delete_template(tid: str, user=Depends(workspace_user)):
    with db() as con:
        if not con.execute(
            "DELETE FROM templates WHERE id=? AND user_id=?", (tid, user["id"])
        ).rowcount:
            raise HTTPException(404, "Plantilla no encontrada.")
        audit(con, user["id"], "template.delete", tid, actor=user.get("actor_id"))
    return {"ok": True}


def serialize(row):
    data = dict(row)
    data["lines"] = json.loads(data["lines"])
    return data


@app.get("/api/invoices")
def invoices(user=Depends(workspace_user)):
    with db() as con:
        return [
            serialize(r)
            for r in con.execute(
                "SELECT * FROM invoices WHERE user_id=? ORDER BY date DESC,id DESC",
                (user["id"],),
            )
        ]


def review_required(con, uid):
    return bool(con.execute(
        "SELECT 1 FROM client_access c JOIN agencies a ON a.user_id=c.manager_id "
        "WHERE c.client_id=? AND c.archived=0 AND a.enabled=1 LIMIT 1", (uid,)
    ).fetchone())


def record_review(con, user, invoice_id, action, version, comment=""):
    actor = user.get("actor_id", user["id"])
    name = con.execute("SELECT name FROM users WHERE id=?", (actor,)).fetchone()
    con.execute(
        "INSERT INTO invoice_reviews(user_id,invoice_id,action,actor_id,actor_name,at,version,comment) VALUES(?,?,?,?,?,?,?,?)",
        (user["id"], invoice_id, action, actor, name["name"] if name else "Cuenta eliminada", int(time.time()), version, comment),
    )
    audit(con, user["id"], "review." + action, invoice_id, actor=actor)


@app.get("/api/review-policy")
def review_policy(user=Depends(workspace_user)):
    with db() as con:
        return {"required": review_required(con, user["id"]), "can_approve": bool(user.get("delegated"))}


@app.get("/api/invoices/{invoice_id}/reviews")
def invoice_reviews(invoice_id: str, user=Depends(workspace_user)):
    with db() as con:
        if not con.execute("SELECT 1 FROM invoices WHERE id=? AND user_id=?", (invoice_id, user["id"])).fetchone():
            raise HTTPException(404, "Registro no encontrado.")
        return [dict(r) for r in con.execute(
            "SELECT action,actor_name,at,version,comment FROM invoice_reviews WHERE invoice_id=? AND user_id=? ORDER BY id DESC",
            (invoice_id, user["id"]),
        )]


class ReviewReturn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)
    comment: str = Field(min_length=1, max_length=2000)

    @field_validator("comment")
    @classmethod
    def nonempty_comment(cls, value):
        if not value.strip():
            raise ValueError("Explica qué debe corregir el cliente.")
        return value.strip()


@app.post("/api/invoices/{invoice_id}/request-changes")
def request_changes(invoice_id: str, body: ReviewReturn, user=Depends(workspace_user)):
    if not user.get("delegated"):
        raise HTTPException(403, "Solo la gestoría puede pedir cambios al cliente.")
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute("SELECT * FROM invoices WHERE id=? AND user_id=?", (invoice_id, user["id"])).fetchone()
        if not row:
            raise HTTPException(404, "Registro no encontrado.")
        if row["version"] != body.version:
            raise HTTPException(409, "Otra sesión ha modificado esta factura. Cierra y vuelve a abrir la revisión.")
        if row["status"] != "draft" or row["review_state"] != "submitted":
            raise HTTPException(409, "Solo puedes devolver documentos enviados a revisión.")
        version = row["version"] + 1
        con.execute("UPDATE invoices SET review_state='changes_requested',review_note=?,version=? WHERE id=?", (body.comment, version, invoice_id))
        record_review(con, user, invoice_id, "changes_requested", version, body.comment)
        return serialize(con.execute("SELECT * FROM invoices WHERE id=?", (invoice_id,)).fetchone())


def store_invoice(body, user, invoice_id=None, connection=None):
    base = sum(l.base for l in body.lines)
    vat = sum(percentage(l.base, l.vat_rate) for l in body.lines)
    if body.withholding > base:
        raise HTTPException(422, "La retención no puede superar la base.")
    if body.status == "confirmed" and not all(
        [body.number.strip(), body.party.strip(), body.nif.strip()]
    ):
        raise HTTPException(422, "Para confirmar, indica número, tercero y NIF.")
    values = dict(
        document_id=body.document_id,
        kind=body.kind,
        status=body.status,
        date=body.date.isoformat(),
        number=body.number.strip(),
        party=body.party.strip(),
        nif=body.nif.strip().upper(),
        category=body.category,
        lines=json.dumps([l.model_dump() for l in body.lines]),
        withholding=body.withholding,
        base=base,
        vat=vat,
        deductible_base=sum(percentage(l.base, l.irpf_deduct) for l in body.lines),
        deductible_vat=sum(
            percentage(percentage(l.base, l.vat_rate), l.vat_deduct) for l in body.lines
        ),
        total=base + vat - body.withholding,
        note=body.note,
    )
    try:
        with (nullcontext(connection) if connection is not None else db()) as con:
            if connection is None:
                con.execute("BEGIN IMMEDIATE")
            old = con.execute("SELECT * FROM invoices WHERE id=? AND user_id=?", (invoice_id, user["id"])).fetchone() if invoice_id else None
            if invoice_id and not old:
                raise HTTPException(404, "Registro no encontrado.")
            if not invoice_id:
                existing = con.execute("SELECT * FROM invoices WHERE user_id=? AND request_id=?", (user["id"], body.request_id)).fetchone()
                if existing:
                    return serialize(existing)
            requires_review = review_required(con, user["id"])
            delegated = bool(user.get("delegated"))
            if requires_review and not delegated and body.status == "confirmed":
                raise HTTPException(403, "Envía el documento a tu gestoría para que lo apruebe antes de contabilizarlo.")
            if body.review_action == "submit" and (not requires_review or delegated or body.status != "draft"):
                raise HTTPException(409, "El envío requiere una gestoría activa y un documento en borrador de tu propia cuenta.")
            if body.review_action == "submit" and not all([body.number.strip(), body.party.strip(), body.nif.strip()]):
                raise HTTPException(422, "Antes de enviar, completa número, tercero y NIF.")
            review_state = "submitted" if body.review_action == "submit" else "approved" if body.status == "confirmed" and delegated else "changes_requested" if old and old["review_state"] == "changes_requested" and body.status == "draft" else "draft"
            values["review_state"] = review_state
            values["review_note"] = old["review_note"] if old and review_state == "changes_requested" else ""
            if (
                body.document_id
                and not con.execute(
                    "SELECT id FROM documents WHERE id=? AND user_id=?",
                    (body.document_id, user["id"]),
                ).fetchone()
            ):
                raise HTTPException(404, "Documento no encontrado.")
            if invoice_id:
                if not con.execute(
                    "SELECT id FROM invoices WHERE id=? AND user_id=?",
                    (invoice_id, user["id"]),
                ).fetchone():
                    raise HTTPException(404, "Registro no encontrado.")
                cursor = con.execute(
                    "UPDATE invoices SET "
                    + ",".join(k + "=?" for k in values)
                    + ",version=version+1 WHERE id=? AND user_id=? AND version=?",
                    (*values.values(), invoice_id, user["id"], body.version),
                )
                if not cursor.rowcount:
                    raise HTTPException(
                        409,
                        "Otra sesión ha modificado esta factura. Recarga antes de guardar.",
                    )
            else:
                existing = con.execute(
                    "SELECT * FROM invoices WHERE user_id=? AND request_id=?",
                    (user["id"], body.request_id),
                ).fetchone()
                if existing:
                    return serialize(existing)
                invoice_id = str(uuid.uuid4())
                values = dict(
                    id=invoice_id,
                    user_id=user["id"],
                    **values,
                    request_id=body.request_id,
                )
                con.execute(
                    "INSERT INTO invoices("
                    + ",".join(values)
                    + ") VALUES("
                    + ",".join("?" for _ in values)
                    + ")",
                    tuple(values.values()),
                )
            audit(
                con, user["id"], "invoice.save", invoice_id, actor=user.get("actor_id")
            )
            saved = con.execute("SELECT * FROM invoices WHERE id=?", (invoice_id,)).fetchone()
            review_event = "submitted" if body.review_action == "submit" else "approved" if body.status == "confirmed" and delegated else "edited" if old and old["review_state"] != "draft" else None
            if review_event:
                record_review(con, user, invoice_id, review_event, saved["version"])
            return serialize(saved)
    except sqlite3.IntegrityError:
        raise HTTPException(
            409, "Ya existe una factura confirmada con ese tipo, NIF y número."
        )


@app.post("/api/invoices")
def create_invoice(body: Invoice, user=Depends(workspace_user)):
    return store_invoice(body, user)


@app.put("/api/invoices/{invoice_id}")
def update_invoice(invoice_id: str, body: Invoice, user=Depends(workspace_user)):
    return store_invoice(body, user, invoice_id)


@app.delete("/api/invoices/{invoice_id}")
def delete_invoice(invoice_id: str, version: int | None = None, user=Depends(workspace_user)):
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute("SELECT * FROM invoices WHERE id=? AND user_id=?", (invoice_id, user["id"])).fetchone()
        if not row:
            raise HTTPException(404, "Registro no encontrado.")
        if (version is not None and version != row["version"]) or (row["status"] == "confirmed" and version is None):
            raise HTTPException(409, "El registro ha cambiado o falta su versión. Cierra y vuelve a abrirlo antes de eliminar.")
        if row["status"] == "confirmed" and review_required(con, user["id"]) and not user.get("delegated"):
            raise HTTPException(403, "Tu gestoría debe eliminar los registros ya contabilizados. Pídele que revise el posible duplicado.")
        con.execute("DELETE FROM invoices WHERE id=? AND user_id=?", (invoice_id, user["id"]))
        audit(con, user["id"], "invoice.delete" if row["status"] == "confirmed" else "draft.delete", invoice_id, actor=user.get("actor_id"))
    return {"ok": True}


class Adjustments(BaseModel):
    box05: int = Field(default=0, ge=0, le=1000000000)
    negative_prior: int = Field(default=0, ge=0, le=1000000000)
    extra_expenses: int = Field(default=0, ge=0, le=1000000000)
    vat_credit: int = Field(default=0, ge=0, le=1000000000)


def period_check(year, quarter):
    if not 2000 <= year <= 2100 or not 1 <= quarter <= 4:
        raise HTTPException(422, "Periodo no válido.")


@app.put("/api/adjustments/{year}/{quarter}")
def adjustments(
    year: int, quarter: int, body: Adjustments, user=Depends(workspace_user)
):
    period_check(year, quarter)
    with db() as con:
        con.execute(
            "INSERT INTO adjustments VALUES(?,?,?,?) ON CONFLICT(user_id,year,quarter) DO UPDATE SET data=excluded.data",
            (user["id"], year, quarter, body.model_dump_json()),
        )
        audit(
            con,
            user["id"],
            "adjustments.update",
            f"{year}-{quarter}",
            actor=user.get("actor_id"),
        )
    return body.model_dump()


class Savings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    amount: int = Field(ge=0, le=1000000000)


class TaxPayments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    vat: int = Field(ge=0, le=1000000000, strict=True)
    irpf: int = Field(ge=0, le=1000000000, strict=True)
    other: int = Field(ge=0, le=1000000000, strict=True)


@app.put("/api/tax-payments/{year}/{month}")
def tax_payments(year: int, month: int, body: TaxPayments, user=Depends(workspace_user)):
    if not 2000 <= year <= 2100 or not 1 <= month <= 12:
        raise HTTPException(422, "Mes no válido.")
    with db() as con:
        con.execute(
            "INSERT INTO tax_payments VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,year,month) DO UPDATE SET vat=excluded.vat,irpf=excluded.irpf,other=excluded.other",
            (user["id"], year, month, body.vat, body.irpf, body.other),
        )
        audit(con, user["id"], "tax_payments.update", f"{year}-{month:02d}", actor=user.get("actor_id"))
    return body.model_dump()


@app.put("/api/savings/{year}/{quarter}")
def savings(year: int, quarter: int, body: Savings, user=Depends(workspace_user)):
    if user.get("delegated"):
        raise HTTPException(403, "La reserva personal solo puede cambiarla el titular de la cuenta.")
    period_check(year, quarter)
    with db() as con:
        con.execute(
            "INSERT INTO savings VALUES(?,?,?,?) ON CONFLICT(user_id,year,quarter) DO UPDATE SET amount=excluded.amount",
            (user["id"], year, quarter, body.amount),
        )
        audit(
            con,
            user["id"],
            "savings.update",
            f"{year}-{quarter}",
            actor=user.get("actor_id"),
        )
    return body.model_dump()


@app.get("/api/summary")
def summary(year: int, quarter: int, user=Depends(workspace_user)):
    period_check(year, quarter)
    with db() as con:
        return summary_in_transaction(year, quarter, user, con)


def summary_in_transaction(year, quarter, user, con):
    rows = [
        dict(r)
        for r in con.execute(
            "SELECT * FROM invoices WHERE user_id=?", (user["id"],)
        )
    ]
    adjustment = con.execute(
        "SELECT data FROM adjustments WHERE user_id=? AND year=? AND quarter=?",
        (user["id"], year, quarter),
    ).fetchone()
    saved = con.execute(
        "SELECT amount FROM savings WHERE user_id=? AND year=? AND quarter=?",
        (user["id"], year, quarter),
    ).fetchone()
    payments = {
        r["month"]: dict(r)
        for r in con.execute(
            "SELECT month,vat,irpf,other FROM tax_payments WHERE user_id=? AND year=?",
            (user["id"], year),
        )
    }
    months = []
    for month in range(1, 13):
        records = [r for r in rows if r["status"] == "confirmed" and r["date"].startswith(f"{year}-{month:02d}-")]
        income = sum(r["base"] for r in records if r["kind"] == "income")
        expenses = sum(r["base"] for r in records if r["kind"] == "expense")
        paid = payments.get(month, {"vat": 0, "irpf": 0, "other": 0})
        months.append({
            "month": month, "income": income, "expenses": expenses,
            "profit": income - expenses, "count": len(records),
            "vat_paid": paid["vat"], "irpf_paid": paid["irpf"], "other_paid": paid["other"],
            "tax_paid": paid["vat"] + paid["irpf"] + paid["other"],
            "payments_recorded": month in payments,
        })
    params = (
        json.loads(adjustment["data"]) if adjustment else Adjustments().model_dump()
    )
    totals = summarize(rows, year, quarter, json.loads(user["profile"]), params)
    saved_amount = saved["amount"] if saved else 0
    return {
        **totals,
        "year": year,
        "quarter": quarter,
        "months": months,
        "saved_amount": saved_amount,
        "remaining_to_save": None
        if totals["tax_reserve"] is None
        else max(0, totals["tax_reserve"] - saved_amount),
        "adjustments": params,
        "adjustments_reviewed": adjustment is not None,
    }


@app.get("/api/export")
def export(year: int, quarter: int, user=Depends(workspace_user)):
    period_check(year, quarter)
    with db() as con:
        rows = con.execute(
            "SELECT * FROM invoices WHERE user_id=? AND status=? AND date>=? AND date<=? ORDER BY date",
            (
                user["id"],
                "confirmed",
                f"{year}-{(quarter - 1) * 3 + 1:02d}-01",
                f"{year}-{quarter * 3:02d}-31",
            ),
        ).fetchall()
        audit(
            con, user["id"], "export", f"{year}-{quarter}", actor=user.get("actor_id")
        )
    out = io.StringIO()
    writer = csv.writer(out, delimiter=";")
    writer.writerow(
        [
            "Fecha",
            "Tipo",
            "Número",
            "Tercero",
            "NIF",
            "Base",
            "IVA",
            "Retención",
            "Total",
            "Base deducible IRPF",
            "IVA deducible",
        ]
    )

    def safe(value):
        text = str(value)
        return (
            "'" + text
            if text.lstrip().startswith(("=", "+", "-", "@", "\t", "\r"))
            else text
        )

    for r in rows:
        writer.writerow(
            [safe(r[k]) for k in ("date", "kind", "number", "party", "nif")]
            + [
                f"{r[k] / 100:.2f}".replace(".", ",")
                for k in (
                    "base",
                    "vat",
                    "withholding",
                    "total",
                    "deductible_base",
                    "deductible_vat",
                )
            ]
        )
    return Response(
        "\ufeff" + out.getvalue(),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="registro-{year}-T{quarter}.csv"'
        },
    )


def report_snapshot(year, quarter, user):
    period_check(year, quarter)
    with db() as con:
        con.execute("BEGIN")
        owner = dict(con.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone())
        records = [serialize(r) for r in con.execute(
            "SELECT * FROM invoices WHERE user_id=? AND date>=? AND date<=? ORDER BY date,kind,number,id",
            (user["id"], f"{year}-01-01", f"{year}-{quarter * 3:02d}-31"))]
        if len(records) > 1000:
            raise HTTPException(413, "El informe supera 1000 registros acumulados. Usa la carpeta trimestral.")
        document_ids = {r["document_id"] for r in records}
        documents = {r["id"]: dict(r) for r in con.execute(
            "SELECT id,name,mime,digest FROM documents WHERE user_id=?", (user["id"],)) if r["id"] in document_ids}
        record_ids = {r["id"] for r in records}
        reviews = [dict(r) for r in con.execute(
            "SELECT invoice_id,action,actor_name,at,version,comment FROM invoice_reviews WHERE user_id=? ORDER BY at,id",
            (user["id"],)) if r["invoice_id"] in record_ids]
        unattached = con.execute("SELECT count(*) FROM documents d WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM invoices i WHERE i.document_id=d.id)", (user["id"],)).fetchone()[0]
        return dict(name=owner["name"], profile=json.loads(owner["profile"]), records=records,
                    documents=documents, reviews=reviews, unattached=unattached,
                    summary=summary_in_transaction(year, quarter, owner, con),
                    year=year, quarter=quarter, created=int(time.time()), reference=uuid.uuid4().hex[:12])


class ReportShare(BaseModel):
    year: int
    quarter: int
    hours: Literal[1, 24, 72, 168, 720] = 72


@app.get("/api/reports/preview", response_class=HTMLResponse)
def report_preview(year: int, quarter: int, user=Depends(workspace_user)):
    from .reports import render_report
    snapshot = report_snapshot(year, quarter, user)
    return render_report(snapshot, lambda did: f"/api/documents/{did}?workspace={user['id']}")


@app.get("/api/reports/shares")
def report_shares(year: int, quarter: int, user=Depends(workspace_user)):
    period_check(year, quarter)
    with db() as con:
        return [dict(r) for r in con.execute(
            "SELECT id,created,expires,year,quarter FROM report_shares WHERE user_id=? AND year=? AND quarter=? AND expires>? ORDER BY created DESC",
            (user["id"], year, quarter, int(time.time())))]


@app.post("/api/reports/shares", status_code=201)
def create_report_share(body: ReportShare, user=Depends(workspace_user)):
    snapshot = report_snapshot(body.year, body.quarter, user)
    token, sid = secrets.token_urlsafe(32), str(uuid.uuid4())
    created = int(time.time())
    expires = created + body.hours * 3600
    with db() as con:
        con.execute("DELETE FROM report_shares WHERE expires<=?", (created,))
        if con.execute("SELECT count(*) FROM report_shares WHERE user_id=?", (user["id"],)).fetchone()[0] >= 20:
            raise HTTPException(409, "Ya hay 20 enlaces activos. Revoca uno antes de crear otro.")
        con.execute("INSERT INTO report_shares VALUES(?,?,?,?,?,?,?,?)", (
            sid, user["id"], hashlib.sha256(token.encode()).hexdigest(), created, expires,
            body.year, body.quarter, json.dumps(snapshot, ensure_ascii=False)))
        audit(con, user["id"], "report.share", sid, actor=user.get("actor_id"))
    return dict(id=sid, created=created, expires=expires, url=f"/api/shared-reports/{token}")


@app.delete("/api/reports/shares/{sid}")
def revoke_report_share(sid: str, user=Depends(workspace_user)):
    with db() as con:
        if not con.execute("DELETE FROM report_shares WHERE id=? AND user_id=?", (sid, user["id"])).rowcount:
            raise HTTPException(404, "Enlace no disponible.")
        audit(con, user["id"], "report.revoke", sid, actor=user.get("actor_id"))
    return {"ok": True}


def shared_report(token):
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        raise HTTPException(404, "Informe no disponible. Solicita un enlace nuevo al titular.")
    with db() as con:
        row = con.execute("SELECT * FROM report_shares WHERE token_hash=? AND expires>?", (
            hashlib.sha256(token.encode()).hexdigest(), int(time.time()))).fetchone()
    if not row:
        raise HTTPException(404, "Informe no disponible. Puede haber caducado o haberse revocado. Solicita un enlace nuevo al titular.")
    return dict(row)


@app.get("/api/shared-reports/{token}", response_class=HTMLResponse)
def public_report(token: str):
    from .reports import render_report
    try:
        share = shared_report(token)
    except HTTPException:
        return HTMLResponse('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/api/report-assets/report.css"><title>Informe no disponible</title><main><h1>Informe no disponible</h1><p>El enlace puede haber caducado o haberse revocado. Solicita un enlace nuevo al titular.</p></main></html>', status_code=404)
    return render_report(json.loads(share["snapshot"]), lambda did: f"/api/shared-reports/{token}/documents/{did}", share["expires"])


@app.get("/api/shared-reports/{token}/status")
def report_share_status(token: str):
    share = shared_report(token)
    return {"expires": share["expires"], "now": int(time.time())}


@app.get("/api/shared-reports/{token}/documents/{did}")
def shared_report_document(token: str, did: str):
    share = shared_report(token)
    snapshot = json.loads(share["snapshot"])
    expected = snapshot["documents"].get(did)
    with db() as con:
        doc = con.execute("SELECT * FROM documents WHERE id=? AND user_id=?", (did, share["user_id"])).fetchone()
    if not expected or not doc or doc["digest"] != expected["digest"] or not Path(doc["path"]).is_file():
        raise HTTPException(404, "Justificante no disponible en este informe.")
    return FileResponse(doc["path"], media_type=doc["mime"], filename=doc["name"])


@app.get("/api/report-assets/{name}")
def report_asset(name: Literal["report.css", "report.js", "report-regular.woff2", "report-semibold.woff2"]):
    return FileResponse(Path(__file__).parent / name, media_type="text/css" if name.endswith("css") else "font/woff2" if name.endswith("woff2") else "text/javascript")


@app.get("/api/quarter-packet")
def quarter_packet(
    year: int,
    quarter: int,
    format: Literal["pdf", "zip"] = "pdf",
    user=Depends(workspace_user),
):
    from .packet import build_packet

    period_check(year, quarter)
    with db() as con:
        rows = [
            serialize(r)
            for r in con.execute(
                "SELECT * FROM invoices WHERE user_id=? AND date>=? AND date<=? ORDER BY date,kind,number,id",
                (
                    user["id"],
                    f"{year}-{(quarter - 1) * 3 + 1:02d}-01",
                    f"{year}-{quarter * 3:02d}-31",
                ),
            )
        ]
        docs = {
            r["id"]: dict(r)
            for r in con.execute(
                "SELECT * FROM documents WHERE user_id=? AND id IN (SELECT document_id FROM invoices WHERE user_id=? AND date>=? AND date<=?)",
                (
                    user["id"],
                    user["id"],
                    f"{year}-{(quarter - 1) * 3 + 1:02d}-01",
                    f"{year}-{quarter * 3:02d}-31",
                ),
            )
        }
    if not rows:
        raise HTTPException(422, "No hay registros en este trimestre.")
    try:
        if (
            sum(Path(d["path"]).stat().st_size for d in docs.values())
            > 250 * 1024 * 1024
            or len(rows) > 1000
        ):
            raise HTTPException(
                413,
                "El trimestre supera el límite de exportación (250 MB o 1000 registros). Contacta con el administrador para preparar el archivo.",
            )
    except OSError:
        raise HTTPException(
            409,
            "Falta un original en el servidor. Revisa los documentos antes de imprimir.",
        )
    folder = tempfile.mkdtemp(prefix="cuentas-packet-")
    try:
        pdf, archive = build_packet(
            folder, rows, docs, user, year, quarter, summary(year, quarter, user)
        )
        return FileResponse(
            pdf if format == "pdf" else archive,
            media_type="application/pdf" if format == "pdf" else "application/zip",
            filename=f"cuentas-{year}-T{quarter}.{format}",
            background=BackgroundTask(shutil.rmtree, folder, ignore_errors=True),
        )
    except Exception as exc:
        shutil.rmtree(folder, ignore_errors=True)
        raise HTTPException(
            409,
            "No se pudo preparar el trimestre completo. Revisa que los originales puedan abrirse.",
        ) from exc


@app.post("/api/documents")
def upload(file: UploadFile, kind: Literal["expense", "income"] = "expense", user=Depends(workspace_user)):
    from .ocr import extract

    content = file.file.read(12 * 1024 * 1024 + 1)
    if len(content) > 12 * 1024 * 1024:
        raise HTTPException(413, "El documento supera 12 MB.")
    digest = hashlib.sha256(content).hexdigest()
    with db() as con:
        if con.execute(
            "SELECT id FROM documents WHERE user_id=? AND digest=?",
            (user["id"], digest),
        ).fetchone():
            raise HTTPException(409, "Este documento ya está cargado en tu cuenta.")
    try:
        result = extract(content, kind)
    except ValueError as error:
        raise HTTPException(422, str(error))
    document_id = str(uuid.uuid4())
    path = DATA / "documents" / document_id
    try:
        with db() as con:
            path.write_bytes(content)
            os.chmod(path, 0o600)
            con.execute(
                "INSERT INTO documents VALUES(?,?,?,?,?,?)",
                (
                    document_id,
                    user["id"],
                    Path(file.filename or "documento").name[:200],
                    result["mime"],
                    digest,
                    str(path),
                ),
            )
            audit(
                con,
                user["id"],
                "document.upload",
                document_id,
                actor=user.get("actor_id"),
            )
    except sqlite3.IntegrityError:
        path.unlink(missing_ok=True)
        raise HTTPException(409, "Este documento ya está cargado en tu cuenta.")
    local = {**result, "id": document_id, "name": Path(file.filename or "documento").name[:200]}
    return prepare_reading(document_id, kind, user, local)



@app.get("/api/documents")
def unattached_documents(user=Depends(workspace_user)):
    with db() as con:
        return [
            dict(r)
            for r in con.execute(
                "SELECT id,name,mime FROM documents WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM invoices WHERE invoices.document_id=documents.id)",
                (user["id"],),
            )
        ]


@app.get("/api/documents/{document_id}/extraction")
def reextract(document_id: str, kind: Literal["expense", "income"] = "expense", user=Depends(workspace_user)):
    from .ocr import extract

    with db() as con:
        row = con.execute(
            "SELECT * FROM documents WHERE id=? AND user_id=?",
            (document_id, user["id"]),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Documento no encontrado.")
    try:
        return {
            **extract(Path(row["path"]).read_bytes(), kind),
            "id": row["id"],
            "name": row["name"],
        }
    except ValueError as error:
        raise HTTPException(422, str(error))


@app.get("/api/invoice-checks")
def invoice_checks(user=Depends(workspace_user)):
    from .invoice_check import compare
    with db() as con:
        rows = con.execute("SELECT i.*, c.state AS check_state,c.version AS check_version,c.document_id AS check_document,c.reading,c.started,c.request_id AS check_id FROM invoices i LEFT JOIN invoice_checks c ON c.invoice_id=i.id WHERE i.user_id=? ORDER BY i.date DESC,i.id", (user["id"],)).fetchall()
    results = []
    for row in rows:
        item = dict(row)
        result = {"invoice_id": item["id"], "version": item["version"], "checked_at": item["started"], "check_id": item["check_id"]}
        if not item["document_id"]:
            result["status"] = "no_document"
        elif item["check_state"] == "completed" and item["check_version"] == item["version"] and item["check_document"] == item["document_id"]:
            item["lines"] = json.loads(item["lines"])
            result.update(compare(item, json.loads(item["reading"])))
        else:
            result["status"] = "outdated" if item["check_state"] == "completed" else "unchecked"
        results.append(result)
    return results


@app.post("/api/invoices/{invoice_id}/check")
def check_invoice(invoice_id: str, reread: bool = False, user=Depends(workspace_user)):
    from .document_ai import analyze, configuration, AIUnavailable
    from .invoice_check import compare
    request_id, now = str(uuid.uuid4()), int(time.time())
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute("SELECT * FROM invoices WHERE id=? AND user_id=?", (invoice_id, user["id"])).fetchone()
        if not row:
            raise HTTPException(404, "Registro no encontrado.")
        original = dict(row)
        if not original["document_id"]:
            return {"invoice_id": invoice_id, "version": original["version"], "status": "no_document"}
        document = con.execute("SELECT * FROM documents WHERE id=? AND user_id=?", (original["document_id"], user["id"])).fetchone()
        if not document:
            raise HTTPException(404, "No se encuentra el original asociado.")
        cached = con.execute("SELECT * FROM invoice_checks WHERE invoice_id=?", (invoice_id,)).fetchone()
        if cached and cached["state"] == "pending" and cached["started"] > now - 120:
            raise HTTPException(409, "Este registro ya se está comprobando. Reintenta en unos instantes.")
        reading = None
        if not reread and cached and cached["state"] == "completed" and cached["document_id"] == document["id"] and cached["digest"] == document["digest"]:
            reading = json.loads(cached["reading"])
        if reading is None:
            if not configuration()["available"]:
                raise HTTPException(503, "La comprobación de originales con IA no está configurada en el servidor.")
            key = "invoice-check:" + user["id"]
            con.execute("DELETE FROM attempts WHERE reset<?", (now,))
            attempt = con.execute("SELECT count FROM attempts WHERE key=?", (key,)).fetchone()
            if attempt and attempt["count"] >= 100:
                raise HTTPException(429, "Se ha alcanzado el límite de 100 comprobaciones nuevas por hora. Los resultados se conservan; continúa más tarde.")
            try:
                content = Path(document["path"]).read_bytes()
            except OSError:
                raise HTTPException(422, "No se puede leer el archivo original. Revisa el justificante asociado.") from None
            if hashlib.sha256(content).hexdigest() != document["digest"]:
                raise HTTPException(422, "El archivo original no coincide con el que se guardó. Revisa el justificante.")
            con.execute("INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1", (key, now + 3600))
        con.execute("INSERT INTO invoice_checks VALUES(?,?,?,?, 'pending',NULL,?,?) ON CONFLICT(invoice_id) DO UPDATE SET document_id=excluded.document_id,digest=excluded.digest,version=excluded.version,state='pending',reading=NULL,started=excluded.started,request_id=excluded.request_id", (invoice_id, document["id"], document["digest"], original["version"], now, request_id))
        audit(con, user["id"], "invoice.check_requested", invoice_id, actor=user.get("actor_id"))
    reused = reading is not None
    try:
        if reading is None:
            reading = analyze(content, document["mime"], original["kind"])
    except Exception as error:
        with db() as con:
            con.execute("UPDATE invoice_checks SET state='failed' WHERE invoice_id=? AND request_id=?", (invoice_id, request_id))
        if isinstance(error, AIUnavailable):
            raise HTTPException(502, str(error)) from None
        raise
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        current = con.execute("SELECT version,document_id FROM invoices WHERE id=? AND user_id=?", (invoice_id, user["id"])).fetchone()
        if not current:
            raise HTTPException(404, "El registro se eliminó durante la comprobación.")
        changed = current["version"] != original["version"] or current["document_id"] != original["document_id"]
        updated = con.execute("UPDATE invoice_checks SET state='completed',reading=? WHERE invoice_id=? AND request_id=?", (json.dumps(reading), invoice_id, request_id)).rowcount
        if not updated:
            raise HTTPException(409, "Otra comprobación sustituyó esta lectura. Actualiza los resultados.")
        audit(con, user["id"], "invoice.checked", invoice_id, actor=user.get("actor_id"))
    original["lines"] = json.loads(original["lines"])
    result = compare(original, reading)
    if changed:
        result["status"] = "outdated"
    return {**result, "invoice_id": invoice_id, "version": original["version"], "checked_at": now, "reused": reused, "check_id": request_id}


class ApplyInvoiceCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)
    check_id: str = Field(min_length=1, max_length=100)


@app.post("/api/invoices/{invoice_id}/apply-check")
def apply_invoice_check(invoice_id: str, body: ApplyInvoiceCheck, user=Depends(workspace_user)):
    from .invoice_check import compare, correction_plan
    from pydantic import ValidationError
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute("SELECT * FROM invoices WHERE id=? AND user_id=?", (invoice_id, user["id"])).fetchone()
        if not row:
            raise HTTPException(404, "Registro no encontrado.")
        current = serialize(row)
        check = con.execute("SELECT * FROM invoice_checks WHERE invoice_id=?", (invoice_id,)).fetchone()
        document = con.execute("SELECT * FROM documents WHERE id=? AND user_id=?", (current['document_id'], user['id'])).fetchone()
        if (not check or check['state'] != 'completed' or check['request_id'] != body.check_id
                or check['version'] != current['version'] or body.version != current['version']
                or not document or check['document_id'] != document['id'] or check['digest'] != document['digest']):
            raise HTTPException(409, "El registro o su comprobación ha cambiado. Vuelve a comprobarlo antes de corregir.")
        reading = json.loads(check['reading'])
        comparison = compare(current, reading)
        patch, notes = correction_plan(current, reading, comparison['differences'])
        if not patch:
            raise HTTPException(422, ' '.join(notes) or "No hay diferencias que se puedan corregir automáticamente.")
        data = {key: current[key] for key in Invoice.model_fields if key in current}
        data.update(patch)
        try:
            proposal = Invoice.model_validate(data)
        except ValidationError:
            raise HTTPException(422, "La propuesta contiene datos incompletos o no admitidos. Revisa el registro manualmente.") from None
        saved = store_invoice(proposal, user, invoice_id, connection=con)
        changes = [{'field': key, 'before': current[key], 'after': saved[key]} for key in patch]
        record_review(con, user, invoice_id, 'corrected_from_original', saved['version'], json.dumps(changes, ensure_ascii=False))
        con.execute("UPDATE invoice_checks SET version=? WHERE invoice_id=? AND request_id=?", (saved['version'], invoice_id, body.check_id))
        result = {**compare(saved, reading), 'invoice_id': invoice_id, 'version': saved['version'],
                  'checked_at': check['started'], 'check_id': body.check_id}
        return {'invoice': saved, 'check': result, 'applied_fields': list(patch)}


@app.get("/api/document-analysis")
def document_analysis_configuration(user=Depends(workspace_user)):
    from .document_ai import configuration
    return configuration()


def reading_for_kind(result, kind):
    fields = dict(result.get("fields", {}))
    fields.pop("party", None)
    fields.pop("nif", None)
    fields.update(result.get("parties", {}).get(kind, {}))
    return {**result, "fields": fields}


def prepare_reading(document_id, kind, user, local=None):
    try:
        result = ai_extract(document_id, kind, user)
        return {**(local or {}), **result}
    except HTTPException as error:
        if error.status_code == 404:
            raise
        fallback = local if local is not None else reextract(document_id, kind, user)
        return {**fallback, "ai_error": error.detail,
                "warnings": [*fallback.get("warnings", []), "No se ha completado la lectura automática con IA. " + str(error.detail)]}


@app.post("/api/documents/{document_id}/prepare")
def prepare_document(document_id: str, kind: Literal["expense", "income"] = "expense", user=Depends(workspace_user)):
    return prepare_reading(document_id, kind, user)


@app.post("/api/documents/{document_id}/ai-extraction")
def ai_extract(document_id: str, kind: Literal["expense", "income"] = "expense", user=Depends(workspace_user)):
    from .document_ai import analyze, configuration, AIUnavailable

    request_id = str(uuid.uuid4())
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute("SELECT * FROM documents WHERE id=? AND user_id=?", (document_id, user["id"])).fetchone()
        if not row:
            raise HTTPException(404, "Documento no encontrado.")
        cached = con.execute("SELECT * FROM document_analyses WHERE document_id=?", (document_id,)).fetchone()
        cached_result = json.loads(cached["result"]) if cached and cached["state"] == "completed" else None
        # Re-read only older foreign/unknown readings whose amounts were discarded.
        obsolete_amounts = cached_result is not None and cached_result.get("classification", {}).get("document_type") in ("invoice", "receipt") and cached_result.get("classification", {}).get("issuer_country") != "ES" and cached_result.get("extraction_version", 1) < 2 and "lines" not in cached_result.get("fields", {})
        if cached_result is not None and not obsolete_amounts:
            return {**reading_for_kind(json.loads(cached["result"]), kind), "id": row["id"], "name": row["name"], "mime": row["mime"], "cached": True, "ai_error": None}
        now = int(time.time())
        if cached and cached["state"] == "pending" and cached["started"] > now - 120:
            raise HTTPException(409, "Este documento ya se está analizando. Vuelve a abrirlo en unos instantes.")
        if not configuration()["available"]:
            raise HTTPException(503, "La lectura con IA no está configurada en el servidor.")
        key = "document-ai:" + user["id"]
        con.execute("DELETE FROM attempts WHERE reset<?", (now,))
        attempt = con.execute("SELECT count FROM attempts WHERE key=?", (key,)).fetchone()
        if attempt and attempt["count"] >= 20:
            raise HTTPException(429, "Se ha alcanzado el límite de 20 lecturas con IA por hora. Puedes continuar con la lectura local.")
        con.execute("INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1", (key, now + 3600))
        con.execute("INSERT INTO document_analyses VALUES(?,'pending',NULL,?,?) ON CONFLICT(document_id) DO UPDATE SET state='pending',started=excluded.started,request_id=excluded.request_id", (document_id, now, request_id))
        audit(con, user["id"], "document.ai_requested", document_id, actor=user.get("actor_id"))
        # Read under the lock so deletion cannot remove the file mid-read.
        content = Path(row["path"]).read_bytes()
    try:
        result = analyze(content, row["mime"], kind)
    except Exception as error:
        with db() as con:
            con.execute("UPDATE document_analyses SET state='failed' WHERE document_id=? AND request_id=?", (document_id, request_id))
        if isinstance(error, AIUnavailable):
            raise HTTPException(502, str(error)) from None
        raise
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        if not con.execute("SELECT 1 FROM documents WHERE id=? AND user_id=?", (document_id, user["id"])).fetchone():
            raise HTTPException(404, "El documento se eliminó durante la lectura.")
        con.execute("UPDATE document_analyses SET state='completed',result=? WHERE document_id=? AND request_id=?", (json.dumps(result),document_id,request_id))
        audit(con, user["id"], "document.ai_extracted", document_id, actor=user.get("actor_id"))
    return {**result, "id": row["id"], "name": row["name"], "mime": row["mime"], "cached": False, "ai_error": None}


class DeleteUnattachedDocuments(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_ids: list[str] = Field(min_length=1, max_length=1000)


@app.post("/api/documents/delete-unattached")
def delete_unattached_documents(body: DeleteUnattachedDocuments, user=Depends(workspace_user)):
    ids = list(dict.fromkeys(body.document_ids))
    deleted, skipped, paths = [], [], []
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        for document_id in ids:
            row = con.execute("SELECT * FROM documents WHERE id=? AND user_id=?", (document_id, user['id'])).fetchone()
            if not row:
                skipped.append(document_id)
                continue
            if con.execute("SELECT 1 FROM invoices WHERE document_id=?", (document_id,)).fetchone():
                skipped.append(document_id)
                continue
            con.execute("INSERT OR IGNORE INTO pending_file_deletions(path) VALUES(?)", (row['path'],))
            con.execute("DELETE FROM documents WHERE id=? AND user_id=?", (document_id, user['id']))
            audit(con, user['id'], 'document.delete', document_id, actor=user.get('actor_id'))
            deleted.append(document_id)
            paths.append(row['path'])
    purge_deleted_documents()
    with db() as con:
        pending = {row['path'] for row in con.execute('SELECT path FROM pending_file_deletions')}
    return {'deleted_ids': deleted, 'skipped_ids': skipped, 'files_pending': sum(path in pending for path in paths)}


@app.delete("/api/documents/{document_id}")
def delete_unattached_document(document_id: str, user=Depends(workspace_user)):
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute("SELECT * FROM documents WHERE id=? AND user_id=?", (document_id,user["id"])).fetchone()
        if not row:
            raise HTTPException(404, "Documento no encontrado.")
        if con.execute("SELECT 1 FROM invoices WHERE document_id=?", (document_id,)).fetchone():
            raise HTTPException(409, "Este documento está asociado a un registro. No se puede eliminar desde Documentos sin registrar.")
        con.execute("INSERT OR IGNORE INTO pending_file_deletions(path) VALUES(?)", (row["path"],))
        con.execute("DELETE FROM documents WHERE id=?", (document_id,))
        audit(con,user["id"],"document.delete",document_id,actor=user.get("actor_id"))
    purge_deleted_documents()
    with db() as con:
        pending = bool(con.execute("SELECT 1 FROM pending_file_deletions WHERE path=?", (row["path"],)).fetchone())
    return {"ok": True, "file_pending": pending}


@app.get("/api/documents/{document_id}")
def document(document_id: str, user=Depends(workspace_user)):
    with db() as con:
        row = con.execute(
            "SELECT * FROM documents WHERE id=? AND user_id=?",
            (document_id, user["id"]),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Documento no encontrado.")
        audit(con, user["id"], "document.read", document_id, actor=user.get("actor_id"))
    return FileResponse(row["path"], media_type=row["mime"], filename=row["name"])


@app.get("/api/health")
def health():
    return {"status": "ok"}


DIST = Path(os.getenv("FRONTEND_DIR", "../frontend/dist"))
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")
