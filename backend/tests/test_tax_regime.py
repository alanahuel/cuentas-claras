"""Regressions for changing regime after recording invoices."""
import pytest
from app.tax import summarize
from test_app import env, client, invoice  # noqa: F401

ADJUSTMENTS = dict(box05=0, negative_prior=0, extra_expenses=0, vat_credit=0)
PROFILE = dict(regime="direct_simplified", vat_regime="general", irpf_required="yes")

@pytest.mark.parametrize("year,income,expenses,extra,allowance,net", [
    (2026, 100000, 20000, 10000, 3500, 66500),
    (2026, 6000000, 0, 0, 200000, 5800000),
    (2026, 100000, 120000, 0, 0, -20000),
    (2026, 100000, 100000, 0, 0, 0),
    (2026, 10, 0, 0, 1, 9),
    (2023, 100000, 0, 0, 7000, 93000),
])
def test_simplified_allowance(year, income, expenses, extra, allowance, net):
    rows = [
        dict(status="confirmed", date=f"{year}-01-10", kind="income", base=income, vat=0, withholding=0),
        dict(status="confirmed", date=f"{year}-02-10", kind="expense", deductible_base=expenses, deductible_vat=0),
    ]
    s = summarize(rows, year, 1, PROFILE, {**ADJUSTMENTS, "extra_expenses": extra})
    assert s["difficult_expenses"] == allowance
    assert s["net"] == net
    assert s["supported"] and s["reserve_complete"]
    assert s["irpf_reserve"] >= 0


def test_accumulated_allowance_and_quarter_vat():
    rows = [
        dict(status="confirmed", date="2026-01-10", kind="income", base=3000000, vat=630000, withholding=0),
        dict(status="confirmed", date="2026-04-10", kind="income", base=3000000, vat=630000, withholding=0),
        dict(status="confirmed", date="2026-07-10", kind="expense", deductible_base=4000000, deductible_vat=840000),
        dict(status="draft", date="2026-08-10", kind="income", base=9000000),
        dict(status="confirmed", date="2025-01-10", kind="income", base=9000000),
    ]
    q1 = summarize(rows, 2026, 1, PROFILE, ADJUSTMENTS)
    q2 = summarize(rows, 2026, 2, PROFILE, {**ADJUSTMENTS, "box05": 570000})
    q3 = summarize(rows, 2026, 3, PROFILE, ADJUSTMENTS)
    assert q1["difficult_expenses"] == 150000
    assert q2["difficult_expenses"] == 200000
    assert q2["irpf_estimate"] == 590000
    assert q2["output_vat"] == 630000
    assert q3["difficult_expenses"] == 100000
    assert q3["vat_balance"] == -840000
    assert q3["vat_reserve"] == 0


def test_profile_change_recalculates_existing_invoices_without_changing_vat(env):
    c = client(env)
    normal_profile = {**PROFILE, "regime": "direct_normal"}
    assert c.put("/api/profile", json=normal_profile).status_code == 200
    assert c.post("/api/invoices", json={**invoice(), "withholding": 0}).status_code == 200
    expense = {**invoice(), "kind": "expense", "lines": [dict(base=20000, vat_rate=21, vat_deduct=50, irpf_deduct=100)], "withholding": 0}
    assert c.post("/api/invoices", json=expense).status_code == 200
    original = c.get("/api/invoices").json()
    normal = c.get("/api/summary?year=2026&quarter=1").json()
    assert normal["irpf_reserve"] == 16000
    assert c.put("/api/profile", json=PROFILE).status_code == 200
    simple = c.get("/api/summary?year=2026&quarter=1").json()
    assert simple["difficult_expenses"] == 4000
    assert simple["irpf_reserve"] == 15200
    assert simple["vat_estimate"] == normal["vat_estimate"] == 18900
    assert simple["tax_reserve"] == 34100
    assert c.get("/api/invoices").json() == original
    assert c.put("/api/profile", json=normal_profile).status_code == 200
    assert c.get("/api/summary?year=2026&quarter=1").json() == normal
    assert c.put("/api/profile", json={**PROFILE, "irpf_required": "no"}).status_code == 200
    assert c.get("/api/summary?year=2026&quarter=1").json()["irpf_reserve"] == 0
