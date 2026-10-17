import importlib, io, json, uuid
from datetime import date
import pytest
from fastapi.testclient import TestClient
from app.tax import percentage, summarize


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("APP_ORIGIN", "http://testserver")
    import app.main as main

    main = importlib.reload(main)
    with main.db() as con:
        for uid in ["alice", "bob"]:
            con.execute(
                "INSERT INTO users(id,email,name,password) VALUES(?,?,?,?)",
                (
                    uid,
                    uid + "@example.test",
                    uid,
                    main.passwords.hash("a-secure-password"),
                ),
            )
    return main


def client(env, name="alice"):
    c = TestClient(env.app)
    r = c.post(
        "/api/login",
        headers={"Origin": "http://testserver"},
        json={"email": name + "@example.test", "password": "a-secure-password"},
    )
    assert r.status_code == 200
    c.headers.update({"Origin": "http://testserver", "X-CSRF-Token": r.json()["csrf"]})
    return c


def invoice(**kwargs):
    return dict(
        kind="income",
        status="confirmed",
        date="2026-01-10",
        number="2026-01",
        party="Cliente",
        nif="B12345678",
        lines=[dict(base=100000, vat_rate=21)],
        withholding=15000,
        request_id=str(uuid.uuid4()),
        **kwargs,
    )


def test_money_and_accumulated_tax():
    assert percentage(5, 10) == 1
    rows = [
        dict(
            status="confirmed",
            date="2026-01-10",
            kind="income",
            base=100000,
            vat=21000,
            withholding=15000,
        ),
        dict(
            status="confirmed",
            date="2026-04-10",
            kind="income",
            base=200000,
            vat=42000,
            withholding=30000,
        ),
        dict(
            status="confirmed",
            date="2026-04-20",
            kind="expense",
            deductible_base=50000,
            deductible_vat=5000,
            withholding=0,
        ),
        dict(status="draft", date="2026-04-20", kind="income", base=99999999),
    ]
    s = summarize(
        rows,
        2026,
        2,
        {"previous_net": 1200000, "previous_net_year": 2025},
        {"box05": 5000, "negative_prior": 0, "extra_expenses": 0, "vat_credit": 0},
    )
    assert s["income"] == 300000 and s["expenses"] == 50000
    assert s["vat_balance"] == 37000 and s["withheld"] == 45000
    assert s["box07"] == 0 and s["irpf_estimate"] == 0 and s["reduction"] == 2500
    assert s["pending"] == 1


@pytest.mark.parametrize(
    "previous,expected",
    [
        (900000, 10000),
        (900001, 7500),
        (1000000, 7500),
        (1000001, 5000),
        (1100001, 2500),
        (1200001, 0),
        (None, 0),
    ],
)
def test_reduction_boundaries(previous, expected):
    s = summarize(
        [],
        2026,
        1,
        {"previous_net": previous, "previous_net_year": 2025},
        {"box05": 0, "negative_prior": 0, "extra_expenses": 0, "vat_credit": 0},
    )
    assert s["reduction"] == expected


def test_auth_csrf_logout(env):
    unauth = TestClient(env.app)
    assert unauth.get("/api/invoices").status_code == 401
    c = client(env)
    assert "HttpOnly" in c.cookies.__str__() or c.cookies.get("session")
    assert (
        c.post(
            "/api/invoices", json=invoice(), headers={"X-CSRF-Token": "bad"}
        ).status_code
        == 403
    )
    assert (
        c.post(
            "/api/invoices", json=invoice(), headers={"Origin": "https://evil.test"}
        ).status_code
        == 403
    )
    assert c.post("/api/logout").status_code == 200
    assert c.get("/api/invoices").status_code == 401


def test_isolation_duplicates_version_and_export(env):
    alice, bob = client(env), client(env, "bob")
    body = invoice()
    r = alice.post("/api/invoices", json=body)
    assert r.status_code == 200, r.text
    saved = r.json()
    assert saved["total"] == 106000
    assert alice.post("/api/invoices", json=body).json()["id"] == saved["id"]
    body2 = {**body, "request_id": str(uuid.uuid4())}
    assert alice.post("/api/invoices", json=body2).status_code == 409
    assert bob.get("/api/invoices").json() == []
    assert bob.put("/api/invoices/" + saved["id"], json=body).status_code == 404
    assert bob.delete("/api/invoices/" + saved["id"]).status_code == 404
    assert bob.post("/api/invoices", json=body).status_code == 200
    body["party"] = "=SUM(1,1)"
    assert alice.put("/api/invoices/" + saved["id"], json=body).status_code == 200
    assert alice.put("/api/invoices/" + saved["id"], json=body).status_code == 409
    assert alice.delete("/api/invoices/" + saved["id"]).status_code == 409
    csv = alice.get("/api/export?year=2026&quarter=1")
    assert "'=SUM" in csv.text and "no-store" in csv.headers["cache-control"]


def test_multi_rate_partial_deduction_and_validation(env):
    c = client(env)
    body = {
        **invoice(),
        "kind": "expense",
        "withholding": 0,
        "lines": [
            {"base": 10000, "vat_rate": 21, "vat_deduct": 50, "irpf_deduct": 75},
            {"base": 20000, "vat_rate": 10},
        ],
    }
    r = c.post("/api/invoices", json=body).json()
    assert (
        r["vat"] == 4100
        and r["deductible_vat"] == 3050
        and r["deductible_base"] == 27500
    )
    assert c.get("/api/summary?year=2026&quarter=1").json()["input_vat"] == 3050
    assert c.get("/api/summary?year=2026&quarter=5").status_code == 422
    assert (
        c.post(
            "/api/invoices",
            json={**invoice(), "lines": [{"base": -100, "vat_rate": 21}]},
        ).status_code
        == 422
    )
    assert (
        c.post("/api/invoices", json={**invoice(), "date": "2026-02-30"}).status_code
        == 422
    )


def test_document_ownership_and_ocr(env):
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text(
        (72, 72),
        "Factura F-2026-001\nFecha 01/04/2026\nProveedor B12345678\nBase imponible 100,00 EUR\nIVA 21% 21,00\nTotal 121,00 EUR",
    )
    content = doc.tobytes()
    alice, bob = client(env), client(env, "bob")
    r = alice.post(
        "/api/documents", files={"file": ("factura.pdf", content, "application/pdf")}
    )
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["fields"]["date"] == "2026-04-01"
    assert result["fields"]["nif"] == "B12345678"
    assert result["fields"]["lines"][0]["base"] == 10000
    assert result["fields"]["detected_total"] == 12100
    assert len(alice.get("/api/documents").json()) == 1
    assert bob.get("/api/documents").json() == []
    assert bob.get("/api/documents/" + result["id"] + "/extraction").status_code == 404
    assert bob.get("/api/documents/" + result["id"]).status_code == 404
    assert alice.get("/api/documents/" + result["id"]).content == content
    assert (
        bob.post("/api/invoices", json=invoice(document_id=result["id"])).status_code
        == 404
    )
    assert (
        alice.post(
            "/api/documents",
            files={"file": ("factura.pdf", content, "application/pdf")},
        ).status_code
        == 409
    )
    assert (
        alice.post(
            "/api/documents",
            files={
                "file": ("fake.pdf", b"<script>alert(1)</script>", "application/pdf")
            },
        ).status_code
        == 422
    )
    assert (
        alice.post(
            "/api/documents",
            files={
                "file": ("big.pdf", b"x" * (12 * 1024 * 1024 + 1), "application/pdf")
            },
        ).status_code
        == 413
    )


def test_attempt_limit(env):
    c = TestClient(env.app)
    for _ in range(8):
        assert (
            c.post(
                "/api/login",
                headers={"Origin": "http://testserver"},
                json={"email": "unknown@test.com", "password": "incorrect"},
            ).status_code
            == 401
        )
    assert (
        c.post(
            "/api/login",
            headers={"Origin": "http://testserver"},
            json={"email": "unknown@test.com", "password": "incorrect"},
        ).status_code
        == 429
    )


def test_previous_year_and_vat_credit():
    s = summarize(
        [],
        2027,
        1,
        {"previous_net": 100, "previous_net_year": 2025},
        {"box05": 0, "negative_prior": 0, "extra_expenses": 0, "vat_credit": 10000},
    )
    assert (
        s["reduction"] == 0
        and s["vat_credit_applied"] == 0
        and s["vat_estimate"] == 0
        and s["vat_credit_remaining"] == 10000
    )


def test_password_change_revokes_other_sessions(env):
    first, second = client(env), client(env)
    assert (
        first.put(
            "/api/password",
            json={"current_password": "bad", "new_password": "another-secure-password"},
        ).status_code
        == 400
    )
    assert (
        first.put(
            "/api/password",
            json={
                "current_password": "a-secure-password",
                "new_password": "another-secure-password",
            },
        ).status_code
        == 200
    )
    assert first.get("/api/me").status_code == 200
    assert second.get("/api/me").status_code == 401
    fresh = TestClient(env.app)
    assert (
        fresh.post(
            "/api/login",
            headers={"Origin": "http://testserver"},
            json={"email": "alice@example.test", "password": "another-secure-password"},
        ).status_code
        == 200
    )


def test_snapshot_restores_originals_and_revokes_sessions(env, tmp_path):
    import os, subprocess, sys, pymupdf

    c = client(env)
    pdf = pymupdf.open()
    pdf.new_page().insert_text(
        (72, 72),
        "Factura TEST-01, B12345678, 01/01/2026, Base imponible 10,00, IVA 21%, Total 12,10",
    )
    content = pdf.tobytes()
    document = c.post(
        "/api/documents", files={"file": ("original.pdf", content, "application/pdf")}
    ).json()
    body = invoice(document_id=document["id"])
    assert c.post("/api/invoices", json=body).status_code == 200
    snapshot = tmp_path.parent / (tmp_path.name + "-snapshot")
    restored = tmp_path.parent / (tmp_path.name + "-restored")
    subprocess.run(
        [sys.executable, "-m", "app.backup", str(snapshot)],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [sys.executable, "-m", "app.restore", str(snapshot), str(restored)],
        check=True,
        capture_output=True,
    )
    import sqlite3

    with sqlite3.connect(restored / "accounts.sqlite") as con:
        assert con.execute("SELECT count(*) FROM invoices").fetchone()[0] == 1
        assert con.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0
        path = con.execute("SELECT path FROM documents").fetchone()[0]
        from pathlib import Path

        assert Path(path).read_bytes() == content
        assert str(restored) in path


def test_registration_validation_and_private_session(env):
    c = TestClient(env.app)
    body = {
        "name": "  Nuevo usuario  ",
        "email": "New@Example.test",
        "password": "my-registration-password",
    }
    assert c.post("/api/register", json=body).status_code == 403
    c.headers["Origin"] = "http://testserver"
    assert (
        c.post("/api/register", json={**body, "password": "short"}).status_code == 422
    )
    assert c.post("/api/register", json={**body, "email": "invalid"}).status_code == 422
    assert c.post("/api/register", json={**body, "name": "   "}).status_code == 422
    result = c.post("/api/register", json=body)
    assert result.status_code == 201, result.text
    user = result.json()
    assert user["email"] == "new@example.test" and user["name"] == "Nuevo usuario"
    assert user["profile"] == {} and "password" not in user
    c.headers["X-CSRF-Token"] = user["csrf"]
    assert c.get("/api/me").json()["id"] == user["id"]
    assert c.get("/api/invoices").json() == []
    with env.db() as con:
        row = con.execute(
            "SELECT password FROM users WHERE id=?", (user["id"],)
        ).fetchone()
        assert row["password"].startswith("$argon2id$")
    assert (
        c.post("/api/register", json={**body, "email": "new@example.test"}).status_code
        == 409
    )
    assert c.post("/api/logout").status_code == 200
    assert c.get("/api/me").status_code == 401
    assert (
        c.post(
            "/api/login",
            json={"email": "new@example.test", "password": body["password"]},
        ).status_code
        == 200
    )


def test_registration_rate_limit(env):
    c = TestClient(env.app, headers={"Origin": "http://testserver"})
    # Failed duplicates count too; changing email cannot bypass the source limit.
    for n in range(10):
        result = c.post(
            "/api/register",
            json={
                "name": "Usuario",
                "email": "alice@example.test",
                "password": "a-secure-password",
            },
        )
        assert result.status_code == 409
    assert (
        c.post(
            "/api/register",
            json={
                "name": "Usuario",
                "email": "other@example.test",
                "password": "a-secure-password",
            },
        ).status_code
        == 429
    )


def test_reserve_does_not_offset_taxes_or_invent_unknowns():
    rows = [
        dict(
            status="confirmed",
            date="2026-01-10",
            kind="income",
            base=100000,
            vat=21000,
            withholding=0,
        ),
        dict(
            status="confirmed",
            date="2026-01-12",
            kind="expense",
            deductible_base=0,
            deductible_vat=42000,
        ),
    ]
    adjustments = {
        "box05": 0,
        "negative_prior": 0,
        "extra_expenses": 0,
        "vat_credit": 0,
    }
    profile = {
        "regime": "direct_normal",
        "vat_regime": "general",
        "irpf_required": "yes",
    }
    s = summarize(rows, 2026, 1, profile, adjustments)
    assert s["vat_estimate"] == -21000 and s["vat_reserve"] == 0
    assert s["irpf_reserve"] == 20000 and s["tax_reserve"] == 20000
    unknown = summarize(rows, 2026, 1, {}, adjustments)
    assert unknown["tax_reserve"] is None and unknown["irpf_reserve"] is None
    partial = summarize(
        rows, 2026, 1, {**profile, "vat_regime": "special"}, adjustments
    )
    assert partial["tax_reserve"] is None and partial["known_reserve"] == 20000
    exempt = summarize(rows, 2026, 1, {**profile, "irpf_required": "no"}, adjustments)
    assert exempt["tax_reserve"] == 0
    modules = summarize(
        rows,
        2026,
        1,
        {**profile, "regime": "modules", "irpf_required": "no"},
        adjustments,
    )
    assert modules["irpf_reserve"] is None


def test_savings_isolation_period_and_persistence(env):
    alice, bob = client(env), client(env, "bob")
    assert (
        alice.put(
            "/api/profile",
            json={
                "regime": "direct_normal",
                "vat_regime": "general",
                "irpf_required": "yes",
            },
        ).status_code
        == 200
    )
    assert (
        alice.post("/api/invoices", json={**invoice(), "withholding": 0}).status_code
        == 200
    )
    assert alice.put("/api/savings/2026/1", json={"amount": 15037}).status_code == 200
    s = alice.get("/api/summary?year=2026&quarter=1").json()
    assert (
        s["tax_reserve"] == 41000
        and s["saved_amount"] == 15037
        and s["remaining_to_save"] == 25963
    )
    assert bob.get("/api/summary?year=2026&quarter=1").json()["saved_amount"] == 0
    assert alice.get("/api/summary?year=2026&quarter=2").json()["saved_amount"] == 0
    assert alice.put("/api/savings/2026/1", json={"amount": 50000}).status_code == 200
    assert (
        alice.get("/api/summary?year=2026&quarter=1").json()["remaining_to_save"] == 0
    )
    assert alice.put("/api/savings/2026/5", json={"amount": 10}).status_code == 422
    assert alice.put("/api/savings/2026/1", json={"amount": -1}).status_code == 422
    assert (
        alice.put(
            "/api/savings/2026/1", json={"amount": 1}, headers={"X-CSRF-Token": "wrong"}
        ).status_code
        == 403
    )


def test_delete_account_requires_confirmation_and_removes_only_owner(env):
    alice, bob = client(env), client(env, "bob")
    assert alice.post("/api/invoices", json=invoice()).status_code == 200
    assert bob.post("/api/invoices", json=invoice()).status_code == 200
    paths = {}
    with env.db() as con:
        for uid in ("alice", "bob"):
            path = env.DATA / "documents" / str(uuid.uuid4())
            path.write_bytes(b"test original")
            paths[uid] = path
            con.execute(
                "INSERT INTO documents VALUES(?,?,?,?,?,?)",
                (str(uuid.uuid4()), uid, "test.pdf", "application/pdf", uid, str(path)),
            )
            con.execute("INSERT INTO savings VALUES(?,?,?,?)", (uid, 2026, 1, 1234))
            con.execute("INSERT INTO adjustments VALUES(?,?,?,?)", (uid, 2026, 1, "{}"))
    body = {"current_password": "a-secure-password", "confirmation": "ELIMINAR"}
    assert (
        alice.request(
            "DELETE", "/api/account", json={**body, "confirmation": ""}
        ).status_code
        == 422
    )
    assert (
        alice.request(
            "DELETE", "/api/account", json={**body, "current_password": "wrong"}
        ).status_code
        == 400
    )
    assert (
        alice.request(
            "DELETE", "/api/account", json=body, headers={"X-CSRF-Token": "wrong"}
        ).status_code
        == 403
    )
    assert paths["alice"].exists()
    response = alice.request("DELETE", "/api/account", json=body)
    assert response.status_code == 200
    assert response.json() == {"ok": True, "documents_pending": False}
    assert not paths["alice"].exists() and paths["bob"].exists()
    assert alice.get("/api/me").status_code == 401
    assert bob.get("/api/me").status_code == 200
    assert len(bob.get("/api/invoices").json()) == 1
    with env.db() as con:
        for table in (
            "sessions",
            "invoices",
            "documents",
            "adjustments",
            "savings",
            "audit",
        ):
            assert (
                con.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE user_id='alice'"
                ).fetchone()[0]
                == 0
            )
        assert (
            con.execute("SELECT COUNT(*) FROM users WHERE id='alice'").fetchone()[0]
            == 0
        )


def test_file_purge_failure_is_durable_and_retried(env, monkeypatch):
    from pathlib import Path

    path = env.DATA / "documents" / "pending-test"
    path.write_bytes(b"original")
    with env.db() as con:
        con.execute("INSERT INTO pending_file_deletions VALUES(?)", (str(path),))
    original = Path.unlink

    def fail(self, *args, **kwargs):
        raise PermissionError("unavailable")

    monkeypatch.setattr(Path, "unlink", fail)
    env.purge_deleted_documents()
    assert path.exists()
    with env.db() as con:
        assert (
            con.execute("SELECT COUNT(*) FROM pending_file_deletions").fetchone()[0]
            == 1
        )
    monkeypatch.setattr(Path, "unlink", original)
    env.purge_deleted_documents()
    assert not path.exists()


def test_templates_private_and_account_deletion(env):
    alice, bob = client(env), client(env, "bob")
    body = dict(
        kind="expense",
        label="Suscripción",
        party="Proveedor",
        nif="B12345678",
        lines=[dict(base=2000, vat_rate=21)],
        withholding=0,
        note="Mensual",
    )
    r = alice.post("/api/templates", json=body)
    assert r.status_code == 200
    tid = r.json()["id"]
    assert bob.get("/api/templates").json() == []
    assert bob.put("/api/templates/" + tid, json=body).status_code == 404
    assert bob.delete("/api/templates/" + tid).status_code == 404
    assert (
        alice.put(
            "/api/templates/" + tid, json={**body, "label": "Actualizada"}
        ).json()["label"]
        == "Actualizada"
    )
    assert (
        alice.request(
            "DELETE",
            "/api/account",
            json=dict(current_password="a-secure-password", confirmation="ELIMINAR"),
        ).status_code
        == 200
    )


def test_quarter_packet_originals_notes_drafts_and_isolation(env):
    import pymupdf, zipfile
    from PIL import Image
    from pathlib import Path

    alice, bob = client(env), client(env, "bob")
    original = pymupdf.open()
    page = original.new_page()
    page.insert_text((40, 40), "ORIGINAL FACTURA 2026")
    pdf = original.tobytes()
    original.close()
    ids = []
    with env.db() as con:
        for index in range(2):
            did = str(uuid.uuid4())
            ids.append(did)
            path = env.DATA / "documents" / did
            if index == 0:
                path.write_bytes(pdf)
            else:
                Image.new("RGB", (60, 100), "white").save(path, format="JPEG")
            con.execute(
                "INSERT INTO documents VALUES(?,?,?,?,?,?)",
                (
                    did,
                    "alice",
                    f"original-{index}",
                    "application/pdf" if index == 0 else "image/jpeg",
                    did,
                    str(path),
                ),
            )
    first = invoice(document_id=ids[0], note="Nota completa para gestor")
    assert alice.post("/api/invoices", json=first).status_code == 200
    second = invoice(document_id=ids[1])
    second.update(status="draft", number="draft-2")
    assert alice.post("/api/invoices", json=second).status_code == 200
    third = invoice()
    third["number"] = "sin-original"
    alice.post("/api/invoices", json=third)
    outside = invoice()
    outside.update(date="2026-04-01", number="otro-trimestre")
    alice.post("/api/invoices", json=outside)
    bob.post("/api/invoices", json=invoice())
    r = alice.get("/api/quarter-packet?year=2026&quarter=1&format=zip")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-store"
    with zipfile.ZipFile(io.BytesIO(r.content)) as archive:
        names = [n for n in archive.namelist() if n.startswith("originales/")]
        assert len(names) == 2
        assert archive.read(next(n for n in names if n.endswith(".pdf"))) == pdf
        data = json.loads(archive.read("datos-completos.json"))
        assert len(data["records"]) == 3
        assert all(row["user_id"] == "alice" for row in data["records"])
        with pymupdf.open(
            stream=archive.read("imprimir-trimestre.pdf"), filetype="pdf"
        ) as output:
            text = "\n".join(p.get_text() for p in output)
            assert "ORIGINAL FACTURA 2026" in text
            assert "Nota completa para gestor" in text
            assert "POR REVISAR" in text
            assert "SIN JUSTIFICANTE" in text
            assert "otro-trimestre" not in text
    other = bob.get("/api/quarter-packet?year=2026&quarter=1")
    with pymupdf.open(stream=other.content, filetype="pdf") as output:
        assert "ORIGINAL FACTURA 2026" not in "".join(p.get_text() for p in output)
    assert alice.get("/api/quarter-packet?year=2026&quarter=4").status_code == 422
    assert alice.get("/api/quarter-packet?year=2026&quarter=5").status_code == 422
    with env.db() as con:
        path = con.execute(
            "SELECT path FROM documents WHERE id=?", (ids[0],)
        ).fetchone()["path"]
    Path(path).unlink()
    assert alice.get("/api/quarter-packet?year=2026&quarter=1").status_code == 409


def test_agency_managed_clients_and_isolation(env):
    manager, other = client(env), client(env, "bob")
    assert (
        manager.post("/api/agency/clients", json={"name": "Cliente Uno"}).status_code
        == 403
    )
    assert (
        manager.put("/api/agency", json={"name": "Gestoría de prueba"}).status_code
        == 200
    )
    first = manager.post("/api/agency/clients", json={"name": "Cliente Uno"}).json()[
        "id"
    ]
    second = manager.post("/api/agency/clients", json={"name": "Cliente Dos"}).json()[
        "id"
    ]
    h = {"X-Workspace-Id": first}
    assert other.get("/api/invoices", headers=h).status_code == 403
    assert (
        other.get("/api/export?year=2026&quarter=1&workspace=" + first).status_code
        == 403
    )
    assert manager.get("/api/workspace", headers=h).json()["name"] == "Cliente Uno"
    assert "password" not in manager.get("/api/workspace", headers=h).json()
    assert manager.get("/api/me", headers=h).json()["id"] == "alice"
    row = manager.post("/api/invoices", json=invoice(), headers=h)
    assert row.status_code == 200
    assert manager.get("/api/invoices").json() == []
    assert len(manager.get("/api/invoices", headers=h).json()) == 1
    assert manager.get("/api/invoices", headers={"X-Workspace-Id": second}).json() == []
    assert (
        manager.put(
            "/api/invoices/" + row.json()["id"],
            json=invoice(),
            headers={"X-Workspace-Id": second},
        ).status_code
        == 404
    )
    history = manager.get("/api/activity", headers=h).json()
    assert next(a for a in history if a["action"] == "invoice.save")["actor"] == "alice"
    assert (
        manager.get(
            "/api/quarter-packet?year=2026&quarter=1&workspace=" + first
        ).status_code
        == 200
    )
    assert (
        manager.put("/api/agency/clients/" + first, json={"archived": True}).status_code
        == 200
    )
    assert manager.get("/api/invoices", headers=h).status_code == 403
    manager.put("/api/agency/clients/" + first, json={"archived": False})
    assert manager.get("/api/invoices", headers=h).status_code == 200
    assert (
        manager.request(
            "DELETE",
            "/api/account",
            json={"current_password": "a-secure-password", "confirmation": "ELIMINAR"},
        ).status_code
        == 409
    )


def test_invitation_preview_consent_revocation_and_expiry(env):
    manager, customer = client(env), client(env, "bob")
    manager.put("/api/agency", json={"name": "Gestoría de prueba"})
    code = manager.post("/api/agency/invite").json()["code"]
    assert (
        manager.get("/api/invoices", headers={"X-Workspace-Id": "bob"}).status_code
        == 403
    )
    assert (
        customer.post("/api/agency/connection", json={"code": code}).json()["name"]
        == "Gestoría de prueba"
    )
    assert (
        manager.get("/api/invoices", headers={"X-Workspace-Id": "bob"}).status_code
        == 403
    )
    assert (
        customer.post(
            "/api/agency/connection", json={"code": code, "accept": True}
        ).status_code
        == 200
    )
    assert (
        customer.post(
            "/api/agency/connection", json={"code": code, "accept": True}
        ).status_code
        == 404
    )
    assert customer.post("/api/invoices", json=invoice() | {"status": "draft"}).status_code == 200
    assert (
        len(manager.get("/api/invoices", headers={"X-Workspace-Id": "bob"}).json()) == 1
    )
    assert customer.delete("/api/agency/connections/alice").status_code == 200
    assert (
        manager.get("/api/invoices", headers={"X-Workspace-Id": "bob"}).status_code
        == 403
    )
    assert len(customer.get("/api/invoices").json()) == 1
    code = manager.post("/api/agency/invite").json()["code"]
    with env.db() as con:
        con.execute("UPDATE agency_invites SET expires=0")
    assert (
        customer.post(
            "/api/agency/connection", json={"code": code, "accept": True}
        ).status_code
        == 404
    )
    code = manager.post("/api/agency/invite").json()["code"]
    manager.delete("/api/agency/invite")
    assert (
        customer.post(
            "/api/agency/connection", json={"code": code, "accept": True}
        ).status_code
        == 404
    )


def test_agency_registration_and_delegated_documents(env):
    import pymupdf
    c=TestClient(env.app)
    r=c.post('/api/register',headers={'Origin':'http://testserver'},json={'name':'Nueva gestoría','email':'agency@example.test','password':'secure-agency-password','account_type':'agency'})
    assert r.status_code == 201
    c.headers.update({'Origin':'http://testserver','X-CSRF-Token':r.json()['csrf']})
    assert c.get('/api/workspaces').json()['agency']=='Nueva gestoría'
    uid=c.post('/api/agency/clients',json={'name':'Cliente prueba'}).json()['id']
    assert c.put('/api/agency/clients/'+uid,json={'archived':False,'name':'Nuevo nombre'}).status_code==200
    assert c.get('/api/workspace',headers={'X-Workspace-Id':uid}).json()['name']=='Nuevo nombre'
    pdf=pymupdf.open();p=pdf.new_page();p.insert_text((40,40),'Factura TEST-123 NIF B12345678 Base imponible: 100,00 IVA 21% Total 121,00');content=pdf.tobytes();pdf.close()
    h={'X-Workspace-Id':uid}
    upload=c.post('/api/documents',headers=h,files={'file':('factura.pdf',content,'application/pdf')})
    assert upload.status_code==200
    did=upload.json()['id']
    assert c.get('/api/documents/'+did).status_code==404
    assert c.get('/api/documents/'+did+'?workspace='+uid).content==content
    assert client(env,'bob').get('/api/documents/'+did+'?workspace='+uid).status_code==403
    assert len(c.get('/api/documents',headers=h).json())==1
    assert c.get('/api/workspaces').json()['clients'][0]['unattached']==1
    c.put('/api/agency/clients/'+uid,json={'archived':True})
    assert c.post('/api/documents',headers=h,files={'file':('factura.pdf',content,'application/pdf')}).status_code==403


def linked_clients(env):
    manager, customer = client(env), client(env, "bob")
    assert manager.put("/api/agency", json={"name": "Asesoría de prueba"}).status_code == 200
    code = manager.post("/api/agency/invite").json()["code"]
    assert customer.post("/api/agency/connection", json={"code": code, "accept": True}).status_code == 200
    return manager, customer, {"X-Workspace-Id": "bob"}


def test_document_review_roundtrip_and_accounting(env):
    manager, customer, scope = linked_clients(env)
    payload = invoice() | {"status": "draft", "review_action": "submit"}
    assert customer.get("/api/review-policy").json() == {"required": True, "can_approve": False}
    assert customer.post("/api/invoices", json=payload | {"status": "confirmed", "review_action": "save"}).status_code == 403
    sent = customer.post("/api/invoices", json=payload)
    assert sent.status_code == 200
    row = sent.json()
    assert row["review_state"] == "submitted" and row["status"] == "draft"
    # Idempotent submission: retries do not create an additional invoice/event.
    assert customer.post("/api/invoices", json=payload).json()["id"] == row["id"]
    path = "/api/invoices/" + row["id"]
    assert len(customer.get(path + "/reviews").json()) == 1
    assert customer.get('/api/summary?year=2026&quarter=1').json()['quarter_income'] == 0
    returned = manager.post(path + "/request-changes", headers=scope, json={"version": row["version"], "comment": "Corrige el NIF y adjunta el original."})
    assert returned.status_code == 200
    row = returned.json()
    assert row["review_state"] == "changes_requested"
    assert "Corrige" in customer.get("/api/invoices").json()[0]["review_note"]
    stale = manager.put(path, headers=scope, json=payload | {"status": "confirmed", "review_action": "save", "version": row["version"] - 1})
    assert stale.status_code == 409
    corrected = customer.put(path, json=payload | {"version": row["version"], "nif": "B87654321"})
    assert corrected.status_code == 200
    row = corrected.json()
    approved = manager.put(path, headers=scope, json=payload | {"version": row["version"], "nif": "B87654321", "status": "confirmed", "review_action": "save"})
    assert approved.status_code == 200
    row = approved.json()
    assert row["status"] == "confirmed" and row["review_state"] == "approved"
    assert customer.get('/api/summary?year=2026&quarter=1').json()['quarter_income'] == 100000
    history = customer.get(path + "/reviews").json()
    assert [e["action"] for e in history] == ["approved", "submitted", "changes_requested", "submitted"]
    assert [e["actor_name"] for e in history] == ["alice", "bob", "alice", "bob"]
    # An owner correction explicitly returns the record to draft and removes its fiscal effect.
    edited = customer.put(path, json=payload | {"version": row["version"], "review_action": "save"})
    assert edited.json()["review_state"] == "draft"
    assert customer.get('/api/summary?year=2026&quarter=1').json()['quarter_income'] == 0
    assert customer.get(path + "/reviews").json()[0]["action"] == "edited"


def test_review_permissions_validation_and_revocation(env):
    manager, customer, scope = linked_clients(env)
    payload = invoice() | {"status": "draft", "review_action": "submit"}
    assert customer.post("/api/invoices", json=payload | {"nif": ""}).status_code == 422
    row = customer.post("/api/invoices", json=payload).json()
    path = "/api/invoices/" + row["id"]
    decision = {"version": row["version"], "comment": "Comprueba los importes."}
    assert customer.post(path + "/request-changes", json=decision).status_code == 403
    assert manager.get(path + "/reviews").status_code == 404
    assert manager.post(path + "/request-changes", headers=scope, json=decision | {"comment": "  "}).status_code == 422
    assert manager.post(path + "/request-changes", headers=scope, json=decision | {"version": 99}).status_code == 409
    assert manager.post(path + "/request-changes", headers=scope, json=decision).status_code == 200
    assert manager.post(path + "/request-changes", headers=scope, json=decision | {"version": 2}).status_code == 409
    assert customer.delete('/api/agency/connections/alice').status_code == 200
    assert manager.get(path + "/reviews", headers=scope).status_code == 403
    assert manager.post(path + "/request-changes", headers=scope, json=decision).status_code == 403
    assert customer.get('/api/review-policy').json()['required'] is False
    assert customer.put(path, json=payload | {"version": 2, "status": "confirmed", "review_action": "save"}).status_code == 200


def test_agency_to_personal_preserves_clients_and_suspends_permissions(env):
    manager, customer, scope = linked_clients(env)
    managed_id = manager.post('/api/agency/clients', json={"name": "Cliente conservado"}).json()['id']
    managed_scope = {"X-Workspace-Id": managed_id}
    owned = manager.post('/api/invoices', json=invoice()).json()
    delegated = manager.post('/api/invoices', headers=managed_scope, json=invoice()).json()
    assert delegated['review_state'] == 'approved'
    invitation = manager.post('/api/agency/invite').json()['code']
    assert manager.post('/api/agency/deactivate').status_code == 200
    spaces = manager.get('/api/workspaces').json()
    assert spaces['agency'] is None and spaces['clients'] == []
    assert spaces['inactive_agency'] == 'Asesoría de prueba'
    assert manager.get('/api/invoices').json()[0]['id'] == owned['id']
    assert manager.get('/api/invoices', headers=scope).status_code == 403
    assert manager.get('/api/invoices', headers=managed_scope).status_code == 403
    assert manager.post('/api/agency/clients', json={"name": "No permitido"}).status_code == 403
    assert manager.post('/api/agency/invite').status_code == 403
    assert customer.post('/api/agency/connection', json={"code": invitation}).status_code == 404
    assert customer.get('/api/review-policy').json()['required'] is False
    # Consent can be revoked while the manager is inactive, and must not resurrect.
    assert customer.delete('/api/agency/connections/alice').status_code == 200
    assert manager.put('/api/agency', json={"name": "Asesoría reactivada"}).status_code == 200
    assert manager.get('/api/invoices', headers=scope).status_code == 403
    assert manager.get('/api/invoices', headers=managed_scope).json()[0]['id'] == delegated['id']
    assert len(manager.get('/api/workspaces').json()['clients']) == 1


def test_review_migration_preserves_existing_data_and_draft_deletion(env):
    c = client(env)
    row = c.post('/api/invoices', json=invoice()).json()
    with env.db() as con:
        con.execute('ALTER TABLE agencies DROP COLUMN enabled')
        con.execute('ALTER TABLE invoices DROP COLUMN review_state')
        con.execute('ALTER TABLE invoices DROP COLUMN review_note')
    importlib.reload(env)
    persisted = c.get('/api/invoices').json()[0]
    assert persisted['id'] == row['id'] and persisted['status'] == 'confirmed'
    assert persisted['review_state'] == 'draft'
    manager, customer, scope = linked_clients(env)
    sent = customer.post('/api/invoices', json=invoice() | {'status': 'draft', 'review_action': 'submit'}).json()
    assert customer.delete('/api/invoices/' + sent['id']).status_code == 200
    with env.db() as con:
        assert con.execute('SELECT COUNT(*) FROM invoice_reviews WHERE invoice_id=?', (sent['id'],)).fetchone()[0] == 0


def team_member(env, manager, name='charlie'):
    with env.db() as con:
        con.execute('INSERT INTO users(id,email,name,password) VALUES(?,?,?,?)', (name, name+'@example.test', name, env.passwords.hash('a-secure-password')))
    employee = client(env, name)
    invitation = manager.post('/api/team/invitations', json={'email':name+'@example.test'})
    assert invitation.status_code == 200
    code = invitation.json()['code']
    assert employee.post('/api/team/join', json={'code':code}).json()['accepted'] is False
    assert employee.post('/api/team/join', json={'code':code,'accept':True}).status_code == 200
    assert employee.post('/api/team/join', json={'code':code,'accept':True}).status_code == 404
    return employee


def test_team_assigned_access_and_review_actor(env):
    manager, customer, scope = linked_clients(env)
    employee = team_member(env, manager)
    other = manager.post('/api/agency/clients', json={'name':'Otro cliente'}).json()['id']
    assert employee.get('/api/workspaces').json()['clients'] == []
    assert employee.get('/api/invoices', headers=scope).status_code == 403
    assert employee.get('/api/team').status_code == 403
    assert manager.put('/api/team/members/charlie/clients', json={'client_ids':['bob']}).status_code == 200
    spaces = employee.get('/api/workspaces').json()
    assert [c['id'] for c in spaces['clients']] == ['bob']
    assert spaces['clients'][0]['can_manage'] == 0
    assert spaces['memberships'][0]['id'] == 'alice'
    for target in ['alice',other]:
        assert employee.get('/api/invoices', headers={'X-Workspace-Id':target}).status_code == 403
        assert employee.get('/api/export?year=2026&quarter=1&workspace='+target).status_code == 403
    assert employee.put('/api/agency/clients/bob',json={'archived':True}).status_code == 403
    payload = invoice() | {'status':'draft','review_action':'submit'}
    sent = customer.post('/api/invoices', json=payload).json()
    approved = employee.put('/api/invoices/'+sent['id'],headers=scope,json=payload | {'status':'confirmed','review_action':'save','version':sent['version']})
    assert approved.status_code == 200 and approved.json()['review_state'] == 'approved'
    history = customer.get('/api/invoices/'+sent['id']+'/reviews').json()
    assert history[0]['actor_name'] == 'charlie'
    assert employee.get('/api/review-policy',headers=scope).json()['can_approve'] is True
    assert manager.get('/api/team').json()['members'][0]['client_ids'] == ['bob']


def test_team_removal_archive_and_revocation_invalidate_access(env):
    manager, customer, scope = linked_clients(env)
    employee = team_member(env,manager)
    assignment = '/api/team/members/charlie/clients'
    manager.put(assignment,json={'client_ids':['bob']})
    manager.put('/api/agency/clients/bob',json={'archived':True})
    assert employee.get('/api/workspaces').json()['clients'] == []
    assert employee.get('/api/invoices',headers=scope).status_code == 403
    manager.put('/api/agency/clients/bob',json={'archived':False})
    assert employee.get('/api/invoices',headers=scope).status_code == 200
    customer.delete('/api/agency/connections/alice')
    assert manager.get('/api/team').json()['members'][0]['client_ids'] == []
    assert employee.get('/api/invoices',headers=scope).status_code == 403
    code = manager.post('/api/agency/invite').json()['code']
    customer.post('/api/agency/connection',json={'code':code,'accept':True})
    assert employee.get('/api/invoices',headers=scope).status_code == 403
    manager.put(assignment,json={'client_ids':['bob']})
    manager.put(assignment,json={'client_ids':[]})
    for url in ['/api/invoices','/api/templates','/api/activity','/api/review-policy','/api/summary?year=2026&quarter=1']:
        assert employee.get(url,headers=scope).status_code == 403
    manager.put(assignment,json={'client_ids':['bob']})
    assert manager.delete('/api/team/members/charlie').status_code == 200
    assert employee.get('/api/workspaces').json()['memberships'] == []
    assert employee.get('/api/invoices',headers=scope).status_code == 403


def test_team_invitation_scope_expiry_rotation_and_cancel(env):
    manager, customer, scope = linked_clients(env)
    assert manager.post('/api/team/invitations',json={'email':'ALICE@example.test'}).status_code == 422
    assert manager.post('/api/team/invitations',json={'email':'wrong'}).status_code == 422
    first = manager.post('/api/team/invitations',json={'email':'bob@example.test'}).json()
    assert manager.post('/api/team/join',json={'code':first['code'],'accept':True}).status_code == 404
    second = manager.post('/api/team/invitations',json={'email':'bob@example.test'}).json()
    assert customer.post('/api/team/join',json={'code':first['code']}).status_code == 404
    assert customer.post('/api/team/join',json={'code':second['code']}).status_code == 200
    # A second active owner cannot inspect, cancel, or assign members of this agency.
    customer.put('/api/agency',json={'name':'Otra gestoría'})
    assert customer.delete('/api/team/invitations/'+second['id']).status_code == 404
    assert customer.put('/api/team/members/bob/clients',json={'client_ids':['bob']}).status_code == 404
    assert manager.delete('/api/team/invitations/'+second['id']).status_code == 200
    assert customer.post('/api/team/join',json={'code':second['code']}).status_code == 404
    expired = manager.post('/api/team/invitations',json={'email':'bob@example.test'}).json()
    with env.db() as con: con.execute('UPDATE team_invites SET expires=0')
    assert customer.post('/api/team/join',json={'code':expired['code'],'accept':True}).status_code == 404
    active = manager.post('/api/team/invitations',json={'email':'bob@example.test'}).json()
    manager.post('/api/agency/deactivate')
    assert customer.post('/api/team/join',json={'code':active['code'],'accept':True}).status_code == 404
    manager.put('/api/agency',json={'name':'Reactivada'})
    assert customer.post('/api/team/join',json={'code':active['code'],'accept':True}).status_code == 404


def test_team_cannot_expand_permissions_or_self_approve(env):
    manager, customer, scope = linked_clients(env)
    employee = team_member(env,manager)
    assert employee.put('/api/team/members/charlie/clients',json={'client_ids':['bob']}).status_code == 403
    assert employee.post('/api/team/invitations',json={'email':'bob@example.test'}).status_code == 403
    assert manager.put('/api/team/members/charlie/clients',json={'client_ids':['unknown']}).status_code == 422
    invitation = manager.post('/api/agency/invite').json()['code']
    employee.post('/api/agency/connection',json={'code':invitation,'accept':True})
    assert manager.put('/api/team/members/charlie/clients',json={'client_ids':['charlie']}).status_code == 422
    assert employee.post('/api/invoices',json=invoice()).status_code == 403
    # Creating an independent agency does not grant access to this owner's portfolio.
    employee.put('/api/agency',json={'name':'Agencia independiente'})
    assert employee.put('/api/team/members/charlie/clients',json={'client_ids':['bob']}).status_code == 404
    assert employee.get('/api/invoices',headers=scope).status_code == 403


def test_team_deactivation_leave_and_account_deletion(env):
    manager, customer, scope = linked_clients(env)
    employee = team_member(env,manager)
    manager.put('/api/team/members/charlie/clients',json={'client_ids':['bob']})
    manager.post('/api/agency/deactivate')
    assert employee.get('/api/workspaces').json()['memberships'][0]['enabled'] == 0
    assert employee.get('/api/invoices',headers=scope).status_code == 403
    assert employee.delete('/api/team/memberships/alice').status_code == 200
    manager.put('/api/agency',json={'name':'Gestoría reactivada'})
    assert employee.get('/api/invoices',headers=scope).status_code == 403
    invite = manager.post('/api/team/invitations',json={'email':'charlie@example.test'}).json()['code']
    employee.post('/api/team/join',json={'code':invite,'accept':True})
    manager.put('/api/team/members/charlie/clients',json={'client_ids':['bob']})
    assert employee.request('DELETE','/api/account',json={'current_password':'a-secure-password','confirmation':'ELIMINAR'}).status_code == 200
    assert manager.get('/api/team').json()['members'] == []
    with env.db() as con:
        assert con.execute('SELECT COUNT(*) FROM team_assignments').fetchone()[0] == 0
    assert len(customer.get('/api/workspaces').json()['managers']) == 1


def test_team_multiple_agencies_remain_independent(env):
    manager, second, scope = linked_clients(env)
    employee = team_member(env,manager)
    manager.put('/api/team/members/charlie/clients',json={'client_ids':['bob']})
    second.put('/api/agency',json={'name':'Segundo equipo'})
    other_id = second.post('/api/agency/clients',json={'name':'Cliente del segundo equipo'}).json()['id']
    code = second.post('/api/team/invitations',json={'email':'charlie@example.test'}).json()['code']
    employee.post('/api/team/join',json={'code':code,'accept':True})
    second.put('/api/team/members/charlie/clients',json={'client_ids':[other_id]})
    assert {c['id'] for c in employee.get('/api/workspaces').json()['clients']} == {'bob',other_id}
    assert employee.get('/api/workspaces').json()['owned_clients'] == []
    assert manager.put('/api/team/members/charlie/clients',json={'client_ids':[other_id]}).status_code == 422
    manager.post('/api/agency/deactivate')
    assert [c['id'] for c in employee.get('/api/workspaces').json()['clients']] == [other_id]
    assert employee.get('/api/invoices',headers=scope).status_code == 403
    assert employee.get('/api/invoices',headers={'X-Workspace-Id':other_id}).status_code == 200
    assert second.delete('/api/team/members/charlie').status_code == 200
    assert employee.get('/api/workspaces').json()['clients'] == []


def test_advisor_workbench_and_client_collaboration(env):
    manager, customer, scope = linked_clients(env)
    employee = team_member(env, manager)
    assert employee.get('/api/advisor/workbench').json()['clients'] == []
    manager.put('/api/team/members/charlie/clients', json={'client_ids':['bob']})
    draft = customer.post('/api/invoices', json=invoice() | {'status':'draft','review_action':'submit'}).json()
    desk = employee.get('/api/advisor/workbench').json()
    assert [c['id'] for c in desk['clients']] == ['bob']
    assert desk['reviews'][0]['id'] == draft['id']
    assert desk['reviews'][0]['client_name'] == 'bob'
    assert customer.post('/api/service-requests', json={'title':'No','body':'No'}).status_code == 403
    created = employee.post('/api/service-requests',headers=scope,json={'title':'Factura pendiente','body':'Necesitamos la factura de septiembre.'})
    assert created.status_code == 200
    rid = created.json()['id']
    row = customer.get('/api/service-requests').json()[0]
    assert row['messages'][0]['actor_name'] == 'charlie'
    assert row['messages'][0]['role'] == 'advisor'
    assert customer.post('/api/service-requests/'+rid,json={'version':1,'action':'resolve'}).status_code == 403
    assert customer.post('/api/service-requests/'+rid,json={'version':1,'body':'Ya está subida.'}).status_code == 200
    assert manager.post('/api/service-requests/'+rid,headers=scope,json={'version':1,'action':'resolve'}).status_code == 409
    assert employee.get('/api/advisor/workbench').json()['clients'][0]['requests_answered'] == 1
    assert manager.post('/api/service-requests/'+rid,headers=scope,json={'version':2,'action':'resolve'}).status_code == 200
    assert customer.get('/api/service-requests').json()[0]['status'] == 'resolved'
    assert customer.post('/api/service-requests/'+rid,json={'version':3,'body':'Otra respuesta'}).status_code == 400
    assert manager.get('/api/service-requests').json() == []
    assert manager.post('/api/service-requests/'+rid,json={'version':3,'action':'resolve'}).status_code == 404
    assert manager.put('/api/savings/2026/3',headers=scope,json={'amount':100}).status_code == 403
    assert customer.put('/api/savings/2026/3',json={'amount':100}).status_code == 200
    manager.put('/api/team/members/charlie/clients', json={'client_ids':[]})
    assert employee.get('/api/advisor/workbench').json()['reviews'] == []
    assert employee.get('/api/service-requests',headers=scope).status_code == 403
    manager.post('/api/agency/deactivate')
    assert manager.get('/api/advisor/workbench').json()['clients'] == []
    assert manager.get('/api/service-requests',headers=scope).status_code == 403
    assert customer.get('/api/service-requests').json()[0]['messages'][1]['role'] == 'client'


def test_private_chat_messages_files_and_revocation(env):
    manager,customer,scope=linked_clients(env)
    employee=team_member(env,manager)
    manager.put('/api/team/members/charlie/clients',json={'client_ids':['bob']})
    contacts=customer.get('/api/chat').json()
    assert len(contacts)==2
    tid=next(c['id'] for c in contacts if c['advisor_id']=='charlie')
    def send(c, text='Hola', file=None, token=None):
        return c.post(f'/api/chat/{tid}/messages',data={'body':text,'request_id':token or str(uuid.uuid4())},files=file)
    rid=str(uuid.uuid4())
    first=send(employee,token=rid)
    assert first.status_code==200
    assert send(employee,token=rid).json()==first.json()
    assert next(c for c in customer.get('/api/chat').json() if c['id']==tid)['unread']==1
    messages=customer.get(f'/api/chat/{tid}/messages').json()
    assert messages[0]['sender_id']=='charlie'
    assert manager.get(f'/api/chat/{tid}/messages',headers=scope).status_code==403
    assert customer.post(f'/api/chat/{tid}/read',json={'last_id':messages[-1]['id']}).status_code==200
    assert next(c for c in customer.get('/api/chat').json() if c['id']==tid)['unread']==0
    from PIL import Image
    out=io.BytesIO();Image.new('RGB',(20,20),'green').save(out,format='PNG')
    photo=send(customer,text='',file={'file':('foto.png',out.getvalue(),'image/png')})
    assert photo.status_code==200
    url=f'/api/chat/{tid}/attachments/{photo.json()["id"]}'
    response=employee.get(url)
    assert response.status_code==200 and response.headers['content-type']=='image/jpeg'
    assert response.headers['cache-control']=='no-store'
    assert manager.get(url,headers=scope).status_code==403
    part=employee.get(url,headers={'Range':'bytes=0-9'})
    assert part.status_code==206 and len(part.content)==10
    assert employee.get(url,headers={'Range':'bytes=999999-'}).status_code==416
    assert send(customer,text='',file={'file':('evil.png',b'<svg></svg>','image/png')}).status_code==422
    assert send(customer,text='',file={'file':('evil.webm',b'<html>','audio/webm')}).status_code==422
    import wave
    wav=io.BytesIO()
    with wave.open(wav,'wb') as w:
        w.setnchannels(1);w.setsampwidth(2);w.setframerate(8000);w.writeframes(b'\x00'*1600)
    audio=send(employee,text='',file={'file':('nota.wav',wav.getvalue(),'audio/wav')})
    assert audio.status_code==200
    assert customer.get(f'/api/chat/{tid}/attachments/{audio.json()["id"]}').headers['content-type']=='audio/wav'
    assert send(customer,text='').status_code==422
    assert len(customer.get(f'/api/chat/{tid}/messages?after={first.json()["id"]}').json())==2
    manager.put('/api/team/members/charlie/clients',json={'client_ids':[]})
    assert employee.get(f'/api/chat/{tid}/messages').status_code==403
    assert customer.get(url).status_code==403
    assert send(employee).status_code==403
    assert all(c['id']!=tid for c in customer.get('/api/chat').json())
    # Account deletion removes private messages and their attachment bytes.
    assert employee.request('DELETE','/api/account',json={'current_password':'a-secure-password','confirmation':'ELIMINAR'}).status_code==200
    with env.db() as con:
        assert con.execute('SELECT COUNT(*) FROM chat_messages WHERE chat_id=?',(tid,)).fetchone()[0]==0


def test_client_activation_preserves_dossier_and_enables_private_chat(env):
    manager=client(env)
    manager.put('/api/agency',json={'name':'Gestoría de acceso'})
    created=manager.post('/api/agency/clients',json={'name':'Cliente con acceso','email':'portal@example.test'}).json()
    uid=created['id'];scope={'X-Workspace-Id':uid}
    original=manager.post('/api/invoices',headers=scope,json=invoice()).json()
    assert manager.get('/api/chat').json()==[]
    visitor=TestClient(env.app)
    visitor.headers.update({'Origin':'http://testserver'})
    preview=visitor.post('/api/client-access',json={'code':created['code']})
    assert preview.status_code==200 and preview.json()['email']=='portal@example.test'
    active=visitor.post('/api/client-access',json={'code':created['code'],'password':'client-portal-password'})
    assert active.status_code==200 and active.json()['id']==uid
    assert active.json()['account_scope']=='agency_client'
    visitor.headers.update({'X-CSRF-Token':active.json()['csrf']})
    assert visitor.get('/api/invoices').json()[0]['id']==original['id']
    assert manager.get('/api/workspaces').json()['clients'][0]['has_login']==1
    assert len(manager.get('/api/chat').json())==1
    assert visitor.put('/api/agency',json={'name':'Cannot elevate'}).status_code==403
    assert visitor.post('/api/client-access',json={'code':created['code'],'password':'other-password-value'}).status_code==404
    assert manager.post(f'/api/agency/clients/{uid}/activation',json={'email':'other@example.test'}).status_code==409
    left=visitor.delete('/api/agency/connections/alice')
    assert left.json()['access_disabled'] is True
    assert visitor.get('/api/me').status_code==401
    assert visitor.post('/api/login',json={'email':'portal@example.test','password':'client-portal-password'}).status_code==403
    assert manager.get('/api/workspaces').json()['clients'][0]['archived']==1
    with env.db() as con:
        assert con.execute('SELECT id FROM invoices WHERE user_id=?',(uid,)).fetchone()[0]==original['id']
        assert con.execute('SELECT COUNT(*) FROM sessions WHERE user_id=?',(uid,)).fetchone()[0]==0


@pytest.mark.parametrize('action',['archive','deactivate'])
def test_client_scope_suspension_does_not_remove_personal_access(env,action):
    manager,personal,scope=linked_clients(env)
    created=manager.post('/api/agency/clients',json={'name':'Cliente dependiente','email':'dependent@example.test'}).json()
    visitor=TestClient(env.app);visitor.headers.update({'Origin':'http://testserver'})
    activated=visitor.post('/api/client-access',json={'code':created['code'],'password':'client-portal-password'}).json()
    visitor.headers.update({'X-CSRF-Token':activated['csrf']})
    if action=='archive':
        for uid in [created['id'],'bob']: manager.put('/api/agency/clients/'+uid,json={'archived':True})
    else: manager.post('/api/agency/deactivate')
    assert visitor.get('/api/me').status_code==401
    assert personal.get('/api/me').status_code==200
    assert personal.get('/api/me').json()['account_scope']=='personal'
    assert personal.post('/api/login',json={'email':'bob@example.test','password':'a-secure-password'}).status_code==200


def test_existing_dossier_activation_rotation_and_email_conflicts(env):
    manager=client(env);outsider=client(env,'bob')
    manager.put('/api/agency',json={'name':'Gestoría'})
    uid=manager.post('/api/agency/clients',json={'name':'Expediente previo'}).json()['id']
    path=f'/api/agency/clients/{uid}/activation'
    assert outsider.post(path,json={'email':'owner@example.test'}).status_code==403
    assert manager.post(path,json={'email':'bob@example.test'}).status_code==409
    count=len(manager.get('/api/workspaces').json()['clients'])
    assert manager.post('/api/agency/clients',json={'name':'No duplicar','email':'bob@example.test'}).status_code==409
    assert len(manager.get('/api/workspaces').json()['clients'])==count
    old=manager.post(path,json={'email':'new@example.test'}).json()['code']
    fresh=manager.post(path,json={'email':'new@example.test'}).json()['code']
    visitor=TestClient(env.app);visitor.headers.update({'Origin':'http://testserver'})
    assert visitor.post('/api/client-access',json={'code':old}).status_code==404
    assert visitor.post('/api/client-access',json={'code':fresh}).status_code==200
    manager.put('/api/agency/clients/'+uid,json={'archived':True})
    assert visitor.post('/api/client-access',json={'code':fresh,'password':'client-portal-password'}).status_code==404


def test_optional_document_ai_ownership_configuration_and_limits(env, monkeypatch):
    from app import document_ai
    alice, bob = client(env), client(env, 'bob')
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    assert alice.get('/api/document-analysis').json()['available'] is False
    import pymupdf
    doc = pymupdf.open()
    doc.new_page().insert_text((72,72),'Factura F-234\nProveedor: Proveedor SL\nNIF B12345678\nCliente: Cliente SL\nNIF 12345678Z')
    upload = alice.post('/api/documents?kind=income',files={'file':('factura.pdf',doc.tobytes(),'application/pdf')})
    assert upload.status_code == 200
    assert upload.json()['fields']['party'] == 'Cliente SL'
    did = upload.json()['id']
    path = f'/api/documents/{did}/ai-extraction?kind=income'
    assert bob.post(path).status_code == 404
    assert alice.post(path).status_code == 503
    assert alice.get(f'/api/documents/{did}/extraction?kind=income').json()['fields']['nif'] == '12345678Z'
    monkeypatch.setenv('OPENAI_API_KEY','synthetic-key')
    monkeypatch.setenv('DOCUMENT_AI_MODEL','test-model')
    calls = []
    def fake_analyze(content, mime, kind):
        calls.append(kind)
        return {'fields':{'party':'Cliente leído'},'parties':{'income':{'party':'Cliente leído'},'expense':{}},'review_required':True}
    monkeypatch.setattr(document_ai,'analyze',fake_analyze)
    assert alice.post(path).json()['fields']['party'] == 'Cliente leído'
    assert calls == ['income']
    assert alice.get('/api/invoices').json() == []
    with env.db() as con:
        con.execute("UPDATE attempts SET count=20 WHERE key='document-ai:alice'")
    assert alice.post(path).json()['cached'] is True
    with env.db() as con:
        con.execute('DELETE FROM document_analyses WHERE document_id=?', (did,))
    assert alice.post(path).status_code == 429
    assert calls == ['income']
    assert alice.post(path.replace('income','invalid')).status_code == 422


def test_dashboard_months_use_all_expenses_and_only_confirmed_invoices(env):
    alice, bob = client(env), client(env, 'bob')
    cases = [
        dict(date='2026-01-05', kind='income', base=100000, status='confirmed'),
        dict(date='2026-01-06', kind='expense', base=40000, status='confirmed'),
        dict(date='2026-02-06', kind='expense', base=20000, status='confirmed'),
        dict(date='2026-12-31', kind='income', base=5000, status='confirmed'),
        dict(date='2025-12-31', kind='income', base=900000, status='confirmed'),
        dict(date='2026-01-10', kind='income', base=900000, status='draft'),
    ]
    for n, row in enumerate(cases):
        body = {**invoice(), **{k: v for k, v in row.items() if k != 'base'},
                'number': f'month-{n}', 'withholding': 0,
                'lines': [dict(base=row['base'], vat_rate=21, irpf_deduct=50)]}
        assert alice.post('/api/invoices', json=body).status_code == 200
    data = alice.get('/api/summary?year=2026&quarter=1').json()
    assert len(data['months']) == 12
    assert data['quarter_expenses'] == 30000
    jan, feb = data['months'][:2]
    assert (jan['income'], jan['expenses'], jan['profit'], jan['count']) == (100000, 40000, 60000, 2)
    assert feb['profit'] == -20000
    assert data['months'][11]['income'] == 5000
    assert data['months'][2]['income'] == 0
    assert all(not m['payments_recorded'] for m in data['months'])
    assert all(m['count'] == 0 for m in bob.get('/api/summary?year=2026&quarter=1').json()['months'])


def test_tax_payments_persist_replace_validate_and_delete_with_account(env):
    alice, bob = client(env), client(env, 'bob')
    url = '/api/tax-payments/2026/1'
    paid = dict(vat=21000, irpf=15000, other=500)
    assert alice.put(url, json=paid, headers={'X-CSRF-Token': 'wrong'}).status_code == 403
    for path, body in [('/api/tax-payments/2026/13', paid), ('/api/tax-payments/1999/1', paid),
                       (url, {**paid, 'vat': -1}), (url, {**paid, 'vat': 1.5}),
                       (url, {**paid, 'vat': 1000000001}), (url, {**paid, 'user_id': 'bob'})]:
        assert alice.put(path, json=body).status_code == 422
    assert alice.put(url, json=paid).status_code == 200
    assert alice.put(url, json={**paid, 'irpf': 17000}).status_code == 200
    month = client(env).get('/api/summary?year=2026&quarter=1').json()['months'][0]
    assert month['tax_paid'] == 38500 and month['payments_recorded'] is True
    assert bob.get('/api/summary?year=2026&quarter=1').json()['months'][0]['tax_paid'] == 0
    assert alice.get('/api/summary?year=2025&quarter=1').json()['months'][0]['payments_recorded'] is False
    assert alice.put('/api/tax-payments/2026/2', json=dict(vat=0, irpf=0, other=0)).status_code == 200
    assert alice.get('/api/summary?year=2026&quarter=1').json()['months'][1]['payments_recorded'] is True
    body = {'current_password': 'a-secure-password', 'confirmation': 'ELIMINAR'}
    assert alice.request('DELETE', '/api/account', json=body).status_code == 200
    with env.db() as con:
        assert con.execute('SELECT count(*) FROM tax_payments WHERE user_id=?', ('alice',)).fetchone()[0] == 0


def test_tax_payments_follow_workspace_access_and_audit_actor(env):
    manager, customer, scope = linked_clients(env)
    paid = dict(vat=12000, irpf=8000, other=0)
    assert manager.put('/api/tax-payments/2026/4', json=paid, headers=scope).status_code == 200
    assert customer.get('/api/summary?year=2026&quarter=2').json()['months'][3]['tax_paid'] == 20000
    assert manager.get('/api/summary?year=2026&quarter=2').json()['months'][3]['tax_paid'] == 0
    with env.db() as con:
        event = con.execute("SELECT user_id,actor_id FROM audit WHERE action='tax_payments.update'").fetchone()
        assert tuple(event) == ('bob', 'alice')
        con.execute('DELETE FROM client_access WHERE client_id=?', ('bob',))
    assert manager.put('/api/tax-payments/2026/4', json=paid, headers=scope).status_code == 403
