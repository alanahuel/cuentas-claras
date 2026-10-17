import React from "react";

const aeat = "https://sede.agenciatributaria.gob.es/Sede/";
const links = {
  census: aeat + "censos-nif-domicilio-fiscal/tramites-censales-relacionados-empresarios-profesionales-retenedores.html",
  irpf: aeat + "irpf/empresarios-individuales-profesionales/regimenes-determinar-rendimiento-actividad.html",
  vat: aeat + "iva/regimenes-tributacion-iva.html",
  model130: aeat + "impuestos-tasas/impuesto-sobre-renta-personas-fisicas/modelo-130-irpf______esionales-estimacion-directa-fraccionado_/instrucciones.html",
};
const descriptions = {
  irpf: {
    unknown: "Si no conoces la modalidad, deja «Pendiente de confirmar». Puedes seguir registrando documentos.",
    direct_normal: "Calcula el rendimiento a partir de ingresos y gastos deducibles. La app estima el Modelo 130 para actividades del apartado I en esta modalidad.",
    direct_simplified: "La app estima el Modelo 130 con ingresos y gastos deducibles e incluye automáticamente los gastos de difícil justificación: 5 % del rendimiento positivo acumulado (7 % en 2023), hasta 2.000 € al año. Amortizaciones y otros ajustes requieren revisión.",
    modules: "El rendimiento se calcula con los módulos de la actividad. La app registra tus documentos, pero no calcula el Modelo 131.",
  },
  vat: {
    unknown: "El régimen de IVA se confirma por separado del IRPF. No se deduce del porcentaje que aparece en una factura.",
    general: "La previsión resta el IVA deducible de tus compras al IVA de tus ventas, con los ajustes del periodo. Solo cubre operaciones nacionales ordinarias.",
    special: "Selecciona esta opción si tu actividad necesita reglas fuera del alcance de la app. Podrás llevar el registro, pero no habrá previsión completa de IVA.",
  },
  model130: {
    unknown: "Confirma si debes presentar el pago fraccionado de IRPF. Tener alguna factura con retención no basta para indicar que estás exonerado.",
    yes: "Indicas que debes presentar el Modelo 130. Es un anticipo del IRPF; no sustituye la declaración anual de la Renta.",
    no: "Indicas una exoneración que ya has confirmado. Esto no significa estar exento de IRPF ni de la Renta anual.",
  },
};
function Source({ topic, children }) { return <a href={links[topic]} target="_blank" rel="noreferrer">{children}</a>; }

export default function FiscalHelp({ topic, value }) {
  if (topic === "start") return <aside className="fiscal-start">
    <h3>¿No sabes qué elegir?</h3>
    <p>Ten a mano tu alta censal (Modelo 036 o el antiguo 037) y sus modificaciones. En la AEAT, consulta «Mis datos censales»: revisa las actividades, los regímenes de IRPF e IVA y la obligación del Modelo 130. Si tienes varias actividades, confirma su combinación con tu gestoría.</p>
    <Source topic="census">Consultar trámites censales de la AEAT</Source>
    <small>Puedes guardar lo que conoces y dejar el resto pendiente. Tu ubicación no determina el régimen.</small>
  </aside>;
  return <div className="fiscal-help">
    <p id={`fiscal-${topic}-hint`} aria-live="polite">{descriptions[topic][value] || descriptions[topic].unknown}</p>
    <details><summary>{topic === "irpf" ? "¿Cómo distingo normal, simplificada y módulos?" : topic === "vat" ? "¿Y si tengo operaciones exentas o un régimen especial?" : "¿Cuándo puede aplicarse la excepción del 70 %?"}</summary>
      {topic === "irpf" && <>
        <dl className="fiscal-options">
          <div><dt>Directa normal</dt><dd>Se aplica, entre otros casos, al superar 600.000 € de cifra de negocios en el año anterior o por renuncia o exclusión de la simplificada.</dd></div>
          <div><dt>Directa simplificada</dt><dd>Puede corresponder si no superas ese límite, no has renunciado y cumples los demás requisitos. No basta con facturar poco: confirma la modalidad de tu alta.</dd></div>
          <div><dt>Estimación objetiva (módulos)</dt><dd>Solo para actividades incluidas y que cumplen sus requisitos. Se usan indicadores de la actividad en lugar del resultado real de ingresos menos gastos.</dd></div>
        </dl>
        <p>Elige tu modalidad real aunque la app todavía no la calcule. «Simplificada» en IRPF y «simplificado» en IVA son regímenes distintos.</p>
        <Source topic="irpf">Comparar regímenes de IRPF en la AEAT</Source>
      </>}
      {topic === "vat" && <>
        <p>Recargo de equivalencia, criterio de caja, agricultura, operaciones internacionales, prorrata o actividades exentas necesitan una revisión específica. Usa «Régimen especial / otras operaciones» si tu caso queda fuera de las operaciones nacionales ordinarias que calcula la app.</p>
        <p>Una factura con IVA al 0 % no confirma por sí sola una exención. Si tienes dudas, deja el campo pendiente y comprueba tus obligaciones censales.</p>
        <Source topic="vat">Consultar regímenes de IVA en la AEAT</Source>
      </>}
      {topic === "model130" && <>
        <p>En actividades profesionales, puede no existir obligación de pago fraccionado si al menos el 70 % de los ingresos del año anterior estuvieron sujetos a retención o ingreso a cuenta. Al iniciar la actividad, se considera el trimestre correspondiente.</p>
        <p>Se compara el importe de los ingresos, no el número de facturas ni el porcentaje retenido. Por ejemplo: 7.000 € de ingresos sujetos a retención sobre 10.000 € de ingresos profesionales representan el 70 %.</p>
        <p>Para actividades agrícolas, ganaderas o forestales hay reglas específicas. En módulos puede corresponder el Modelo 131. Confirma el caso antes de marcar una exoneración.</p>
        <Source topic="model130">Consultar quién presenta el Modelo 130</Source>
      </>}
    </details>
  </div>;
}

export function FiscalReadiness({ profile }) {
  const vatReady = profile.vat_regime === "general";
  const irpfReady = ["direct_normal", "direct_simplified"].includes(profile.regime) && ["yes", "no"].includes(profile.irpf_required);
  return <aside className="fiscal-readiness" aria-live="polite">
    <h3>Con esta configuración</h3>
    <dl><div><dt>Registro de ingresos y gastos</dt><dd>Disponible</dd></div><div><dt>Previsión de IVA</dt><dd>{vatReady ? "Disponible · operaciones ordinarias" : profile.vat_regime === "unknown" ? "Pendiente de confirmar el régimen" : "Fuera del cálculo disponible"}</dd></div><div><dt>Previsión del Modelo 130</dt><dd>{irpfReady ? profile.irpf_required === "no" ? "Sin reserva · exoneración indicada" : profile.regime === "direct_simplified" ? "Disponible · directa simplificada, apartado I" : "Disponible · directa normal, apartado I" : profile.regime === "unknown" || profile.irpf_required === "unknown" ? "Faltan datos por confirmar" : "Modalidad no calculada por la app"}</dd></div></dl>
    <small>Las previsiones requieren revisar documentos y ajustes. La Renta anual y otras obligaciones quedan fuera del cálculo.</small>
  </aside>;
}
