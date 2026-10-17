"""Compare recorded values with an independent reading; never edit an invoice."""
import re
import unicodedata
from .tax import percentage


def normalized(value):
    text = unicodedata.normalize("NFKD", str(value)).casefold()
    return re.sub(r"[^a-z0-9]", "", text)


def tax_groups(lines):
    groups = {}
    for line in lines:
        rate = line["vat_rate"]
        group = groups.setdefault(rate, {"vat_rate": rate, "base": 0, "vat": 0})
        group["base"] += line["base"]
        group["vat"] += percentage(line["base"], rate)
    return [groups[key] for key in sorted(groups)]


def compare(invoice, reading):
    fields = dict(reading.get("fields", {}))
    fields.pop("party", None)
    fields.pop("nif", None)
    fields.update(reading.get("parties", {}).get(invoice["kind"], {}))
    differences, missing, checked = [], [], []
    labels = {"date": "Fecha de emisión", "number": "Número", "party": "Tercero", "nif": "NIF", "withholding": "Retención", "detected_total": "Total", "lines": "Bases y tipos de IVA"}
    valid_document = reading.get("classification", {}).get("document_type") in ("invoice", "receipt")
    for field, label in labels.items():
        if not valid_document or field not in fields:
            missing.append(label)
            continue
        recorded = invoice["total" if field == "detected_total" else field]
        detected = fields[field]
        if field == "lines":
            recorded, detected = tax_groups(recorded), tax_groups(detected)
        checked.append(label)
        equal = normalized(recorded) == normalized(detected) if field in ("party", "nif") else recorded == detected
        if not equal:
            differences.append({"field": field, "label": label, "recorded": recorded, "detected": detected})
    date_difference = next((d for d in differences if d["field"] == "date"), None)
    def period(value):
        return f"T{(int(value[5:7]) - 1) // 3 + 1} {value[:4]}"
    period_change = None
    if date_difference and period(date_difference["recorded"]) != period(date_difference["detected"]):
        period_change = {"recorded": period(date_difference["recorded"]), "detected": period(date_difference["detected"])}
    warnings = reading.get("warnings", [])
    patch, correction_notes = correction_plan(invoice, reading, differences)
    return {
        "status": "differences" if differences else "incomplete" if missing or warnings else "matched",
        "differences": differences, "missing": missing, "checked": checked,
        "warnings": warnings, "period_change": period_change,
        "correctable_fields": list(patch), "correction_notes": correction_notes,
    }


def correction_plan(invoice, reading, differences):
    """Only proposals derivable without inventing fiscal choices or a total."""
    fields = {**reading.get('fields', {}), **reading.get('parties', {}).get(invoice['kind'], {})}
    changed = {d['field'] for d in differences}
    patch = {key: fields[key] for key in ('date', 'number', 'party', 'nif') if key in changed}
    notes = []
    monetary = {}
    if 'lines' in changed:
        old = invoice['lines']
        all_deductions = {(l.get('irpf_deduct', 100), l.get('vat_deduct', 100)) for l in old}
        lines = []
        for line in fields['lines']:
            same_rate = [l for l in old if l['vat_rate'] == line['vat_rate']]
            deductions = {(l.get('irpf_deduct', 100), l.get('vat_deduct', 100)) for l in same_rate} or all_deductions
            if len(deductions) != 1:
                notes.append('El desglose tiene deducibilidades distintas. Corrige los importes en la revisión del registro.')
                break
            irpf, vat = next(iter(deductions))
            lines.append({**line, 'irpf_deduct': irpf, 'vat_deduct': vat,
                          'description': same_rate[0].get('description', '') if len(same_rate) == 1 else line.get('description', '')})
        else:
            monetary['lines'] = lines
    if 'withholding' in changed:
        monetary['withholding'] = fields['withholding']
    if changed & {'lines', 'withholding', 'detected_total'}:
        lines = monetary.get('lines', invoice['lines'])
        withholding = monetary.get('withholding', invoice['withholding'])
        total = sum(l['base'] + percentage(l['base'], l['vat_rate']) for l in lines) - withholding
        if fields.get('detected_total') == total and not notes:
            patch.update(monetary)
        else:
            notes.append('El total leído y el desglose no permiten una corrección automática coherente. Revisa los importes manualmente.')
    return patch, notes
