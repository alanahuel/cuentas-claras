"""Conservative, traceable suggestions from invoice text. No external services."""

import re
import unicodedata
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

MONEY = r"(?<![\w.,])[-−]?(?:\d{1,3}(?:[. ,]\d{3})+|\d+)[.,]\d{2}(?![\d.,])"
NIF = r"\b(?:ES[ -]?)?(?:[A-Z][ -]?\d{7}[ -]?[A-Z0-9]|\d{8}[ -]?[A-Z])\b"
RATE = r"(\d{1,2}(?:[.,]\d{1,2})?)\s*%"


def folded(value):
    return "".join(
        c
        for c in unicodedata.normalize("NFKD", value.lower())
        if not unicodedata.combining(c)
    )


def money(raw):
    raw = raw.replace(" ", "").replace("−", "-")
    separator = max(raw.rfind(","), raw.rfind("."))
    whole = raw[:separator].replace(",", "").replace(".", "")
    return int(Decimal(whole + "." + raw[separator + 1 :]) * 100)


def percentage(base, rate):
    return int(
        (Decimal(base) * Decimal(str(rate)) / 100).quantize(
            Decimal(1), rounding=ROUND_HALF_UP
        )
    )


def parse_fields(text, kind="expense"):
    lines = [
        re.sub(r"[\t\u00a0 ]+", " ", line).strip()
        for line in text.splitlines()
        if line.strip()
    ]
    # Bind isolated labels to their values before distinguishing due/issue dates.
    joined, skip = [], False
    for i, line in enumerate(lines):
        if skip:
            skip = False
            continue
        if i + 1 < len(lines) and re.fullmatch(
            r"(?:fecha(?: de emision| factura)?|emision|vencimiento|due date|invoice date)\s*:?",
            folded(line),
        ):
            joined.append(line + " " + lines[i + 1])
            skip = True
        else:
            joined.append(line)
    lines = joined
    fields, evidence, warnings = {}, {}, []

    def suggest(key, value, source, method="read"):
        fields[key] = value
        evidence[key] = {"text": source[:400], "method": method}

    def unique(key, candidates):
        values = {str(value): (value, source) for value, source in candidates}
        if len(values) == 1:
            value, source = next(iter(values.values()))
            suggest(key, value, source)
        elif len(values) > 1:
            warnings.append(
                f"Hay varios valores posibles para {LABELS[key]}. Comprueba el original."
            )

    # Prefer issue dates over due dates, order dates, and payment dates.
    dates, explicit_dates = [], []
    months = {
        name: i + 1
        for i, name in enumerate(
            [
                "enero",
                "febrero",
                "marzo",
                "abril",
                "mayo",
                "junio",
                "julio",
                "agosto",
                "septiembre",
                "octubre",
                "noviembre",
                "diciembre",
            ]
        )
    }
    for line in lines:
        label = folded(line)
        if re.search(r"vencimiento|due date|pedido|pago|payment|entrega", label):
            continue
        matches = []
        for m in re.finditer(
            r"\b(?:(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})|(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2}))\b",
            line,
        ):
            matches.append(
                tuple(map(int, m.group(1, 2, 3)))
                if m[1]
                else (int(m[6]), int(m[5]), int(m[4]))
            )
        for m in re.finditer(
            r"\b(\d{1,2})\s+(?:de\s+)?("
            + "|".join(months)
            + r")\s+(?:de\s+)?(20\d{2})\b",
            label,
        ):
            matches.append((int(m[3]), months[m[2]], int(m[1])))
        for parts in matches:
            try:
                candidate = (date(*parts).isoformat(), line)
            except ValueError:
                continue
            dates.append(candidate)
            if re.search(r"fecha|emision|invoice date|issued", label):
                explicit_dates.append(candidate)
    unique("date", explicit_dates or dates)

    numbers = []
    for i, line in enumerate(lines):
        m = re.match(
            r"^(?:(?:n[uú]mero|n[º°o.]*)\s*(?:de\s*)?(?:factura|invoice)|(?:factura|invoice)\s*(?:n[uú]mero|number|num\.?|n[º°o.]*)?)\s*[:#.-]?\s*(.*)$",
            line,
            re.IGNORECASE,
        )
        if m:
            value = m[1].strip() or (lines[i + 1] if i + 1 < len(lines) else "")
            if re.fullmatch(
                r"[A-Z0-9][A-Z0-9_./-]{0,99}", value, re.IGNORECASE
            ) and re.search(r"\d", value):
                numbers.append((value, line + (" " + value if not m[1] else "")))
    unique("number", numbers)

    # Keep both roles so changing Income/Expense does not need another OCR pass.
    parties = {"expense": {}, "income": {}}
    party_sources = {"expense": {}, "income": {}}
    conflicts = set()

    def party_value(role, key, value, source):
        if (role, key) in conflicts:
            return
        if key in parties[role] and parties[role][key] != value:
            parties[role].pop(key)
            party_sources[role].pop(key)
            conflicts.add((role, key))
            warnings.append(
                "Hay datos de varios terceros en una misma sección. Comprueba el cliente o proveedor."
            )
            return
        parties[role][key] = value
        party_sources[role][key] = source

    current = None
    section_seen = False
    for i, line in enumerate(lines):
        label = folded(line)
        role = re.match(
            r"^(proveedor|emisor|vendedor|supplier|seller|datos del emisor|cliente|receptor|destinatario|customer|bill to|datos del cliente)\b\s*:?\s*(.*)",
            label,
        )
        if role:
            section_seen = True
            current = (
                "income"
                if role[1]
                in (
                    "cliente",
                    "receptor",
                    "destinatario",
                    "customer",
                    "bill to",
                    "datos del cliente",
                )
                else "expense"
            )
            name = line[len(line) - len(role[2]) :].strip() if role[2] else ""
            if (
                not name
                and i + 1 < len(lines)
                and not re.search(r"[:\d]", lines[i + 1])
            ):
                name = lines[i + 1]
            if (
                name
                and not re.search(NIF, name.upper())
                and not re.search(r"\b(?:nif|cif|dni|nie)\b", folded(name))
            ):
                party_value(current, "party", name[:200], line)
        elif re.match(
            r"^(fecha|factura|invoice|concepto|descripcion|base|subtotal|total|iva|vat|iban|forma de pago)\b",
            label,
        ):
            current = None
        name = re.match(r"^(?:razon social|nombre fiscal)\s*:\s*(.+)", label)
        if name:
            target = current or ("expense" if not section_seen else None)
            if target:
                party_value(target, "party", line.split(":", 1)[1].strip()[:200], line)
        ids = re.findall(NIF, line.upper())
        if current and len(ids) == 1:
            party_value(
                current, "nif", re.sub(r"[ -]", "", ids[0]).removeprefix("ES"), line
            )
    # Without role labels a single NIF is ambiguous; only use an explicit supplier line.
    for key, value in parties[kind].items():
        suggest(key, value, party_sources[kind][key])
    if "nif" not in fields and re.search(NIF, text.upper()):
        warnings.append(
            "No se ha identificado con seguridad el NIF del tercero. Comprueba si corresponde al cliente o al proveedor."
        )

    # Join labels with a numeric following line (common in native PDF extraction).
    rows = []
    for i, line in enumerate(lines):
        row = line
        if (
            not re.search(MONEY, row)
            and i + 1 < len(lines)
            and re.match(r"^[€$]?\s*[-−]?\d", lines[i + 1])
        ):
            row += " " + lines[i + 1]
        rows.append(row)
    totals, bases, retentions, vat_amounts = [], [], [], []
    rates, retention_rates, breakdown = set(), set(), []
    paired_breakdown = []
    pending_base = None
    invalid_breakdown = False
    for row in rows:
        label = folded(row)
        # Percentages with decimal precision are not money.
        amounts = [
            money(m[0])
            for m in re.finditer(MONEY, row)
            if not re.match(r"\s*%", row[m.end() :])
        ]
        if (
            re.match(
                r"^(?:total(?:\s+(?:factura|a pagar|documento|general))?|importe total|grand total|amount due)\s*:?\s*(?:eur|€|\$)?\s*[-−]?\d",
                label,
            )
            and amounts
        ):
            totals.append((amounts[-1], row))
        if (
            re.match(r"^(?:base imponible|total bases?|subtotal|net amount)\b", label)
            and amounts
        ):
            bases.append((amounts[0], row))
            pending_base = (amounts[0], row)
        if re.search(r"\b(?:irpf|retencion|withholding)\b", label):
            if amounts:
                retentions.append((abs(amounts[-1]), row))
            retention_rates.update(
                Decimal(m.replace(",", ".")) for m in re.findall(RATE, row)
            )
        elif re.search(r"\b(?:iva|vat|i\.v\.a\.)", label):
            row_rates = {Decimal(m.replace(",", ".")) for m in re.findall(RATE, row)}
            rates.update(row_rates)
            if len(amounts) == 1:
                vat_amounts.append((amounts[0], row))
                if pending_base and len(row_rates) == 1:
                    rate = next(iter(row_rates))
                    base, base_source = pending_base
                    if (
                        base >= 0
                        and rate in (0, 4, 10, 21)
                        and abs(percentage(base, rate) - amounts[0]) <= 1
                    ):
                        paired_breakdown.append(
                            (base, int(rate), base_source + "\n" + row)
                        )
                    else:
                        invalid_breakdown = True
                    pending_base = None
        # Summary table: base | IVA % | cuota, optionally preceded by 'Base'.
        table = re.match(
            r"^(?:base(?: imponible)?\s*:?\s*)?("
            + MONEY
            + r")\s+(?:€\s*)?(?:iva\s*)?"
            + RATE
            + r"\s+("
            + MONEY
            + r")(?:\s*(?:€|EUR))?$",
            row,
            re.IGNORECASE,
        )
        if table:
            base, rate, quota = (
                money(table[1]),
                Decimal(table[2].replace(",", ".")),
                money(table[3]),
            )
            rates.add(rate)
            if (
                rate in (0, 4, 10, 21)
                and base >= 0
                and abs(percentage(base, rate) - quota) <= 1
            ):
                breakdown.append((base, int(rate), row))
            else:
                invalid_breakdown = True
                warnings.append(
                    "Una fila del desglose de IVA no cuadra o usa un tipo no admitido. Revísala en el original."
                )
    unique("detected_total", totals)
    unique("withholding", retentions)
    unsupported = any(rate not in (0, 4, 10, 21) for rate in rates)
    if unsupported:
        warnings.append(
            "El documento contiene tipos de IVA no admitidos. Introduce el desglose manualmente."
        )
    base_values = {base for base, _ in bases}
    selected = []
    if not breakdown and len(paired_breakdown) > 1:
        breakdown = paired_breakdown
    if breakdown and not unsupported and not invalid_breakdown:
        # Repeated page headers/totals must not silently double the invoice.
        selected = list(dict.fromkeys((base, rate) for base, rate, _ in breakdown))
        if {rate for _, rate in selected} != rates:
            selected = []
        source = "\n".join(row for _, _, row in breakdown)
    elif len(base_values) == 1 and not unsupported and not invalid_breakdown:
        base = next(iter(base_values))
        if not rates and len({value for value, _ in vat_amounts}) == 1 and base > 0:
            quota = vat_amounts[0][0]
            matches = [
                rate for rate in (0, 4, 10, 21) if percentage(base, rate) == quota
            ]
            if len(matches) == 1:
                rates.add(Decimal(matches[0]))
        if len(rates) == 1 and base >= 0:
            rate = int(next(iter(rates)))
            quotas = {value for value, _ in vat_amounts}
            if not quotas or (
                len(quotas) == 1
                and abs(percentage(base, rate) - next(iter(quotas))) <= 1
            ):
                selected = [(base, rate)]
            else:
                warnings.append(
                    "La cuota de IVA no coincide con la base y el porcentaje. Revisa los importes."
                )
        source = "\n".join(row for _, row in bases + vat_amounts)
    if selected:
        suggest(
            "lines",
            [
                {
                    "base": base,
                    "vat_rate": rate,
                    "irpf_deduct": 100,
                    "vat_deduct": 100,
                    "description": "",
                }
                for base, rate in selected
            ],
            source,
        )
        if "withholding" not in fields and len(retention_rates) == 1:
            rate = next(iter(retention_rates))
            if 0 <= rate <= 100:
                suggest(
                    "withholding",
                    percentage(sum(base for base, _ in selected), rate),
                    f"Retención {rate}% sobre la base detectada",
                    "calculated",
                )
    elif bases or breakdown or rates:
        warnings.append(
            "No se ha podido completar un desglose de IVA fiable. Revisa las bases y los tipos."
        )
    if re.search(r"\b(?:USD|GBP|CHF)\b|[$£]", text):
        for key in ("lines", "withholding", "detected_total"):
            fields.pop(key, None)
            evidence.pop(key, None)
        warnings.append(
            "Se ha detectado otra moneda. Introduce los importes en euros manualmente."
        )
    if fields.get("detected_total", 0) < 0:
        fields.pop("lines", None)
        evidence.pop("lines", None)
        warnings.append(
            "El total es negativo. Este formulario no admite facturas rectificativas negativas."
        )
    if len({number for number, _ in numbers}) > 1:
        fields, evidence = {}, {}
        parties = {"expense": {}, "income": {}}
        warnings.append(
            "El archivo contiene varios números de factura. Sube cada factura por separado o completa el formulario manualmente."
        )
    if any(line["base"] > 1000000000 for line in fields.get("lines", [])):
        fields.pop("lines", None)
        evidence.pop("lines", None)
        warnings.append(
            "Una base supera el importe admitido. Comprueba la lectura del documento."
        )
    reconciliation = None
    if "lines" in fields and "detected_total" in fields:
        calculated = sum(
            line["base"] + percentage(line["base"], line["vat_rate"])
            for line in fields["lines"]
        ) - fields.get("withholding", 0)
        difference = calculated - fields["detected_total"]
        reconciliation = {
            "calculated_total": calculated,
            "difference": difference,
            "matches": abs(difference) <= 2,
        }
        if abs(difference) > 2:
            warnings.append(
                "El total detectado no coincide con las bases, el IVA y la retención. Revisa descuentos, cuotas o importes pendientes."
            )
    return {
        "fields": fields,
        "parties": parties,
        "evidence": evidence,
        "warnings": list(dict.fromkeys(warnings)),
        "missing_fields": [
            key
            for key in ("date", "number", "party", "nif", "lines")
            if key not in fields
        ],
        "reconciliation": reconciliation,
    }


LABELS = {
    "date": "la fecha",
    "number": "el número de factura",
    "detected_total": "el total",
    "withholding": "la retención",
}
