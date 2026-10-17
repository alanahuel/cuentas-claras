"""Read-only, dated accounting reports. All amounts remain integer cents."""
from datetime import datetime, timezone
from html import escape


def money(value):
    if value is None:
        return "Pendiente de configurar"
    return f"{value / 100:,.2f}".replace(",", "_").replace(".", ",").replace("_", ".") + " €"


def stamp(value):
    return datetime.fromtimestamp(value, timezone.utc).strftime("%d/%m/%Y %H:%M UTC")


def render_report(data, document_url, expires=None):
    e = lambda value: escape(str(value), quote=True)
    rows, totals = data["records"], data["summary"]
    quarter, year = data["quarter"], data["year"]
    start = f"{year}-{(quarter - 1) * 3 + 1:02d}-01"
    period = [r for r in rows if r["date"] >= start]
    confirmed = [r for r in period if r["status"] == "confirmed"]
    income = sum(r["base"] for r in confirmed if r["kind"] == "income")
    expenses = sum(r["base"] for r in confirmed if r["kind"] == "expense")

    def table(headers, values):
        return '<div class="table-scroll" tabindex="0" role="region" aria-label="Tabla de datos del informe"><table' + (' class="wide"' if len(headers) > 2 else '') + '><thead><tr>' + ''.join(f'<th scope="col">{e(h)}</th>' for h in headers) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join(f'<td class="{"amount" if str(v).endswith(" €") else ""}">{e(v)}</td>' for v in row) + '</tr>' for row in values) + '</tbody></table></div>'

    def amounts(values):
        return table(["Concepto", "Importe"], [(label, money(value)) for label, value in values])

    pending = sum(r["status"] != "confirmed" for r in period)
    missing = sum(not r["document_id"] or r["document_id"] not in data["documents"] for r in period)
    issues = [f"{pending} registros del trimestre pendientes de revisión; excluidos de los cálculos.", f"{missing} registros del trimestre sin justificante adjunto.", f"{data['unattached']} documentos sin asociar a ningún registro; no tienen periodo y quedan fuera del informe."]
    if not totals["reserve_complete"]:
        issues.append("La reserva fiscal está incompleta. Revisa el perfil fiscal antes de usarla.")
    if not totals["adjustments_reviewed"]:
        issues.append("Los ajustes del trimestre no se han revisado; se han usado valores iniciales de cero.")
    profile = data["profile"]
    labels = {"unknown": "Pendiente", "direct_normal": "Estimación directa normal", "direct_simplified": "Estimación directa simplificada", "modules": "Módulos", "general": "General", "special": "Especial", "yes": "Sí", "no": "No"}
    body = f'''<header><h1>Informe contable · T{quarter} {year}</h1><p class="owner">{e(data['name'])}</p><p>Copia generada el {stamp(data['created'])} · Referencia {e(data['reference'])}</p><p>Documento de trabajo para contrastar registros y justificantes con la gestoría. No acredita una auditoría ni una declaración presentada.</p></header>
    <nav aria-label="Secciones"><a href="#resumen">Resumen</a><a href="#comprobaciones">Comprobaciones</a><a href="#fiscal">Cálculos y ajustes</a><a href="#registros">Registros y justificantes</a><a href="#criterios">Criterios de lectura</a></nav>
    <section id="resumen"><h2>Resumen del trimestre</h2><p>{len(period)} registros · {len(confirmed)} revisados · {pending} pendientes. Importes en euros.</p>'''
    body += amounts([("Ingresos · bases revisadas", income), ("Gastos · bases revisadas", expenses), ("Resultado antes de impuestos · ingresos − gastos", income - expenses), ("IVA repercutido", totals["output_vat"]), ("IVA deducible", totals["input_vat"]), ("Reserva fiscal estimada", totals["tax_reserve"]), ("Dinero apartado", totals["saved_amount"])]) + '</section>'
    body += '<section id="comprobaciones"><h2>Comprobaciones pendientes</h2><ul>' + ''.join(f'<li>{e(issue)}</li>' for issue in issues) + '</ul></section>'
    body += '<section id="fiscal"><h2>Perfil, cálculos y ajustes</h2>'
    body += table(["Dato del perfil", "Valor registrado"], [("IRPF", labels.get(profile.get("regime", "unknown"), "Pendiente")), ("IVA", labels.get(profile.get("vat_regime", "unknown"), "Pendiente")), ("Obligación de pago fraccionado IRPF", labels.get(profile.get("irpf_required", "unknown"), "Pendiente")), (f"Rendimiento previo ({profile.get('previous_net_year', 'año sin configurar')})", money(profile.get("previous_net")))])
    body += '<h3>IVA del trimestre</h3><p>Saldo = IVA repercutido − IVA deducible. La estimación descuenta el crédito anterior aplicable. La reserva no puede ser negativa.</p>'
    body += amounts([(label, totals[key]) for key, label in [("vat_balance", "Saldo IVA"), ("vat_credit_applied", "Crédito anterior aplicado"), ("vat_credit_remaining", "Crédito restante"), ("vat_reserve", "Reserva IVA estimada")]])
    body += '<h3>IRPF acumulado desde enero</h3><p>El acumulado incluye registros revisados desde el 1 de enero hasta el cierre del trimestre; el anexo permite comprobar también los trimestres anteriores. Son cifras del cálculo disponible en la aplicación, sujetas al perfil y a revisión de la gestoría.</p>'
    body += amounts([(label, totals.get(key)) for key, label in [("income", "Ingresos acumulados"), ("expenses", "Gastos deducibles acumulados"), ("difficult_expenses", "Provisiones y gastos de difícil justificación automáticos"), ("net", "Rendimiento tras gastos y ajustes"), ("withheld", "Retenciones de ingresos acumuladas"), ("box04", "Cálculo previo (casilla 04)"), ("box05", "Pagos previos (casilla 05)"), ("box07", "Resultado previo (casilla 07)"), ("reduction", "Minoración del cálculo"), ("irpf_reserve", "Reserva IRPF estimada")]])
    body += '<h3>Ajustes registrados</h3>' + amounts([(label, totals["adjustments"][key]) for key, label in [("box05", "Pagos fraccionados anteriores"), ("negative_prior", "Resultados negativos anteriores"), ("extra_expenses", "Gastos adicionales acumulados"), ("vat_credit", "Crédito IVA anterior")]])
    body += '<h3>Pagos de impuestos anotados</h3><p>Son anotaciones manuales, independientes de las reservas estimadas. «Sin anotar» no significa que no se haya pagado.</p>'
    body += table(["Mes", "IVA", "IRPF", "Otros", "Estado"], [(f"{year}-{m['month']:02d}", money(m['vat_paid']), money(m['irpf_paid']), money(m['other_paid']), "Anotado" if m['payments_recorded'] else "Sin anotar") for m in totals["months"] if (quarter - 1) * 3 < m["month"] <= quarter * 3]) + '</section>'
    body += '<section id="registros"><h2>Registros y justificantes</h2><p>Las fichas conservan los datos y el estado de revisión en la fecha de generación. Los borradores no suman en los totales.</p>'
    if not period:
        body += '<p>No hay registros en este trimestre.</p>'
    for title, selected in [("Registros del trimestre", period), ("Anexo · registros anteriores del año", [r for r in rows if r["date"] < start])]:
        if not selected:
            continue
        body += f'<h3>{title}</h3>'
        for r in selected:
            state = "Revisado" if r["status"] == "confirmed" else "Pendiente · excluido de cálculos"
            body += f'<article><h4>{e(r["date"])} · {"Ingreso" if r["kind"] == "income" else "Gasto"} · {e(r["number"] or "Sin número")}</h4><p><strong>{e(r["party"] or "Tercero sin indicar")}</strong> · NIF: {e(r["nif"] or "Sin indicar")}<br>{state} · Versión {r["version"]} · {e(r["category"])}</p>'
            body += table(["Concepto", "Base", "IVA %", "Deducible IVA %", "Deducible IRPF %"], [(line.get("description") or "Sin concepto", money(line["base"]), line["vat_rate"], line["vat_deduct"], line["irpf_deduct"]) for line in r["lines"]])
            body += amounts([(label, r[key]) for key, label in [("base", "Base"), ("vat", "IVA"), ("withholding", "Retención"), ("total", "Total · base + IVA − retención"), ("deductible_base", "Base deducible IRPF"), ("deductible_vat", "IVA deducible")]])
            body += f'<p class="note">Notas: {e(r["note"] or "Sin notas")}</p>'
            doc = data["documents"].get(r["document_id"])
            if doc:
                body += f'<p><a href="{e(document_url(doc["id"]))}" target="_blank" rel="noreferrer">Ver justificante: {e(doc["name"])}</a></p><p class="digest">Huella SHA-256: {e(doc["digest"])}</p>'
            else:
                body += '<p><strong>Sin justificante adjunto.</strong> Esta ficha no sustituye al original.</p>'
            reviews = [v for v in data["reviews"] if v["invoice_id"] == r["id"]]
            if reviews:
                body += '<h5>Historial de revisión</h5>' + table(["Fecha UTC", "Operador", "Acción", "Versión", "Comentario"], [(stamp(v["at"]), v["actor_name"], {"submitted": "Enviado", "approved": "Aprobado", "changes_requested": "Cambios solicitados", "edited": "Modificado"}.get(v["action"], v["action"]), v["version"], v["comment"]) for v in reviews])
            body += '</article>'
    body += '</section><section id="criterios"><h2>Criterios y dudas habituales</h2><h3>¿Qué representan los totales?</h3><p>Los ingresos y gastos del resumen usan bases revisadas del trimestre. El gasto contable mostrado y el gasto deducible pueden diferir por sus porcentajes de deducción. El resultado no es el saldo bancario: este informe no concilia cobros ni pagos de facturas con movimientos bancarios.</p><h3>¿Por qué no coincide todo con el IRPF?</h3><p>El IRPF usa el acumulado desde enero, gastos deducibles, retenciones y ajustes. El IVA usa el trimestre seleccionado. Los importes pendientes de configurar no equivalen a cero.</p><h3>¿Qué queda fuera?</h3><p>Los documentos sin asociar, los borradores guardados solo en un dispositivo y las operaciones no registradas. Los justificantes se abren por separado y no se incluyen al imprimir esta vista; la carpeta PDF/ZIP de la aplicación permite entregar los originales juntos.</p><h3>¿Qué ocurre al caducar?</h3><p>El enlace y los justificantes dejan de estar disponibles. Las copias ya descargadas o impresas siguen en poder del destinatario. Este informe es una copia fechada y no incorpora cambios posteriores.</p></section>'
    expiry = f'<p>Acceso hasta {stamp(expires)} · <span id="countdown" data-expires="{expires}"></span></p>' if expires else '<p>Vista privada · datos a fecha de generación</p>'
    return f'''<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive,nosnippet"><meta name="referrer" content="no-referrer"><title>Informe contable · T{quarter} {year}</title><link rel="stylesheet" href="/api/report-assets/report.css"><script src="/api/report-assets/report.js" defer></script></head><body><div class="toolbar">{expiry}<button id="print-report" type="button">Imprimir / Guardar PDF</button></div><main>{body}</main><footer>Cuentas · Informe de apoyo a la revisión contable · {e(data['reference'])}</footer></body></html>'''
