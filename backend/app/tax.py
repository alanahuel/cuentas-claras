"""Indicative calculations only; monetary values are integer euro cents."""

from decimal import Decimal, ROUND_HALF_UP


def percentage(cents: int, rate: int) -> int:
    return int(
        (Decimal(cents) * Decimal(rate) / 100).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
    )


def summarize(invoices, year, quarter, profile, adjustments):
    end = f"{year}-{quarter * 3:02d}-31"
    start = f"{year}-{(quarter - 1) * 3 + 1:02d}-01"
    ytd = [
        i
        for i in invoices
        if i["status"] == "confirmed" and f"{year}-01-01" <= i["date"] <= end
    ]
    period = [i for i in ytd if i["date"] >= start]
    income = sum(i["base"] for i in ytd if i["kind"] == "income")
    expenses = sum(i["deductible_base"] for i in ytd if i["kind"] == "expense")
    withheld = sum(i["withholding"] for i in ytd if i["kind"] == "income")
    output_vat = sum(i["vat"] for i in period if i["kind"] == "income")
    input_vat = sum(i["deductible_vat"] for i in period if i["kind"] == "expense")
    net_before_allowance = income - expenses - adjustments["extra_expenses"]
    simplified = profile.get("regime") == "direct_simplified"
    # Art. 30 RIRPF: accumulated positive net, capped annually, not per quarter.
    # The exceptional 7% rate applies only to the 2023 tax year.
    allowance_rate = (7 if year == 2023 else 5) if simplified else 0
    difficult_expenses = (
        min(200000, percentage(max(0, net_before_allowance), allowance_rate))
        if simplified else 0
    )
    net = net_before_allowance - difficult_expenses
    previous_net = (
        profile.get("previous_net")
        if profile.get("previous_net_year") == year - 1
        else None
    )
    reduction = (
        0
        if previous_net is None
        else next(
            (
                value
                for ceiling, value in [
                    (900000, 10000),
                    (1000000, 7500),
                    (1100000, 5000),
                    (1200000, 2500),
                ]
                if previous_net <= ceiling
            ),
            0,
        )
    )
    box04 = percentage(max(net, 0), 20)
    box07 = box04 - adjustments["box05"] - withheld
    box14 = max(0, box07) - reduction
    box15 = min(max(0, box14), adjustments["negative_prior"])
    supported = profile.get("regime") in ("direct_normal", "direct_simplified")
    vat_estimate = (
        output_vat
        - input_vat
        - min(max(output_vat - input_vat, 0), adjustments["vat_credit"])
    )
    vat_reserve = (
        max(0, vat_estimate) if profile.get("vat_regime") == "general" else None
    )
    obligation = profile.get("irpf_required", "unknown")
    irpf_reserve = (
        (max(0, box14 - box15) if obligation == "yes" else 0)
        if supported and obligation in ("yes", "no")
        else None
    )
    complete = vat_reserve is not None and irpf_reserve is not None
    known_reserve = (vat_reserve or 0) + (irpf_reserve or 0)
    return dict(
        vat_reserve=vat_reserve,
        irpf_reserve=irpf_reserve,
        tax_reserve=known_reserve if complete else None,
        known_reserve=known_reserve,
        reserve_complete=complete,
        income=income,
        expenses=expenses,
        net_before_allowance=net_before_allowance,
        difficult_expenses=difficult_expenses,
        difficult_expenses_rate=allowance_rate,
        net=net,
        withheld=withheld,
        quarter_income=sum(i["base"] for i in period if i["kind"] == "income"),
        quarter_expenses=sum(
            i["deductible_base"] for i in period if i["kind"] == "expense"
        ),
        output_vat=output_vat,
        input_vat=input_vat,
        vat_balance=output_vat - input_vat,
        vat_estimate=output_vat
        - input_vat
        - min(max(output_vat - input_vat, 0), adjustments["vat_credit"]),
        vat_credit_applied=min(
            max(output_vat - input_vat, 0), adjustments["vat_credit"]
        ),
        vat_credit_remaining=adjustments["vat_credit"]
        - min(max(output_vat - input_vat, 0), adjustments["vat_credit"]),
        box04=box04,
        box05=adjustments["box05"],
        box07=box07,
        reduction=reduction,
        box14=box14,
        box15=box15,
        irpf_estimate=max(0, box14 - box15),
        supported=supported,
        irpf_required=profile.get("irpf_required", "unknown"),
        count=len(period),
        pending=sum(i["status"] == "draft" for i in invoices),
        assumptions=[
            "Operaciones nacionales ordinarias; sin prorrata, criterio de caja ni bienes de inversión.",
            "Modelo 130, apartado I, estimación directa normal o simplificada al 20 %. No incluye casillas 16 a 18 ni especialidades territoriales.",
            "En simplificada se incluyen automáticamente provisiones y gastos de difícil justificación sobre el rendimiento positivo acumulado, con límite anual de 2.000 €. No los dupliques en otros gastos; no se contempla la reducción incompatible del artículo 32.2.1.º.",
            "Casilla 05, compensaciones y ajustes requieren revisión. No es una declaración tributaria.",
        ],
    )
