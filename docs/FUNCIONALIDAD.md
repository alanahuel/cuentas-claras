# Referencia técnica del código

Este documento describe comportamientos presentes en el código, no una lista de funcionalidades de producto terminadas. En particular, las secciones sobre gestorías, equipos y colaboración son trabajo exploratorio: ofrecer la aplicación a gestores es una intención futura. El alcance de portfolio está definido en el [README](../README.md).

Aplicación multiusuario en español: React + FastAPI + SQLite, documentos privados y OCR local (PDF/Tesseract). Primera versión funcional para registrar documentos existentes, revisar su información y consultar estimaciones fiscales.

## Funciones implementadas

- Registro público de cuentas independientes y alta administrativa opcional; contraseñas Argon2id, sesiones HttpOnly, CSRF y límite de intentos.
- Ingresos/gastos, varios tipos de IVA por documento, retenciones, deducibilidad independiente para IVA e IRPF, estados borrador/revisado y detección de duplicados.
- Originales privados PDF/JPG/PNG/WebP (12 MB, hasta 8 páginas). OCR local, sugerencias de fecha/NIF/número/base/IVA/total cuando se reconocen. Texto y original visibles para revisión. Lectura automática con OpenAI al subir o abrir documentos, con clasificación de tipo/país, resultado reutilizable y fallback local si no está disponible.
- Reserva conjunta para IVA e IRPF, total apartado por usuario/trimestre y cantidad pendiente de ahorrar. Se identifican previsiones parciales; no se compensan impuestos entre sí.
- Resumen trimestral de IVA general; estimación orientativa del 130 apartado I para directa normal y simplificada, con retenciones acumuladas, casilla 05, minoración y negativos previos introducidos por el usuario.
- Exportación CSV con protección frente a fórmulas. Control de versiones para evitar sobrescribir una edición concurrente.
- PWA instalable. Borradores nuevos offline en IndexedDB durante una sesión abierta; sincronización explícita e idempotente. El service worker nunca cachea API ni documentos privados.
- Copia consistente y restauración con comprobación de hashes de documentos.

## Arranque local

Requiere Python >=3.12, uv, Node >=22 y Tesseract con español/inglés para fotos. El texto de PDF funciona sin Tesseract.

```bash
cd frontend
npm ci
npm run build
cd ../backend
uv sync --frozen
uv run python -m app.manage create-user --email tu-correo@example.com --name 'Tu nombre'
uv run python -m app.manage create-user --email padre@example.com --name 'Padre'
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Abre **http://localhost:8000** (el origen debe coincidir con `APP_ORIGIN`). Las contraseñas se piden de forma interactiva; no se pasan como argumentos. También puedes crear una cuenta desde «Registrarse». No hay credenciales predeterminadas.

Desarrollo con Vite: `APP_ORIGIN=http://localhost:5173 uv run uvicorn app.main:app`, y `npm run dev` en frontend. Abre localhost:5173.

Variables: `DATA_DIR` (por defecto `backend/data` al arrancar desde backend), `FRONTEND_DIR`, `APP_ORIGIN`, `COOKIE_SECURE` (true con HTTPS).

## Verificación

```bash
cd backend && uv run pytest -q
cd ../frontend && npm run build
```

Prueba de navegador: usa un directorio aislado terminado en `cuentas-e2e`, ejecuta `scripts/seed-test.py` con `DATA_DIR` apuntando allí, arranca backend con `APP_ORIGIN=http://127.0.0.1:8000`, instala Chromium (`npx playwright install chromium`) y ejecuta `npm run test:e2e`. Los datos de ejemplo son exclusivamente sintéticos y no se despliegan.

## Límites que importan

Es un registro y una estimación, no software de emisión conforme a SIF/VERI*FACTU ni presentación de modelos. No implementa el 131, el 390, prorrata, regímenes especiales, facturas rectificativas negativas, operaciones internacionales o criterio de caja. Los tipos de IVA disponibles son 0/4/10/21; el 0 no clasifica automáticamente una exención. Cuotas/gastos sin factura fiscal pueden guardarse como borrador, pero este flujo requiere referencia/tercero/NIF para confirmar.

El rendimiento previo del perfil está asociado a un ejercicio y la minoración solo se aplica al año siguiente; debe actualizarse al cambiar de ejercicio. El perfil inicial no constituye un historial completo de regímenes fiscales. Los ajustes sí pertenecen a ejercicio/trimestre. La deducibilidad del IVA no deducido como gasto de IRPF requiere ajuste manual cuando proceda. Las fechas se imputan por fecha de factura en esta primera versión.

La extracción local es heurística y no garantiza detectar todos los campos. Reconoce desgloses de varios tipos de IVA en tablas de base/porcentaje/cuota y bloques etiquetados; los diseños no reconocidos necesitan revisión manual o lectura con IA. No se aplican automáticamente exoneraciones fiscales.

Offline parcial: no permite iniciar sesión sin red, leer facturas del servidor ni adjuntar fotos offline. Los borradores locales no están cifrados con una clave propia; requieren un dispositivo de confianza. Cerrar sesión borra los borradores locales después de advertir si quedan pendientes. Si el servidor no es accesible, el cierre remoto de sesión no se considera completado.

No hay 2FA, recordatorios push, borrado automático por antigüedad ni recuperación por correo. Cada usuario puede cambiar su contraseña desde Perfil fiscal. El administrador puede restablecer contraseñas con `python -m app.manage reset-password --email ...`. Cifrado de disco/BD, copia externa y revisión de conservación/RGPD deben configurarse según el entorno; HTTPS y permisos de archivos no equivalen a cifrado en reposo.

Fuentes, matices legales y decisiones: [alcance](ALCANCE.md). La interfaz no anuncia cumplimiento legal ni exactitud fiscal completa.


## Registro y reserva de impuestos

Registro con nombre, correo normalizado y contraseña de al menos 12 caracteres, hash Argon2id y sesión privada. No verifica propiedad del correo ni envía mensajes; la recuperación sigue siendo administrativa. Se limita a 10 intentos de registro por origen de conexión y hora. En el despliegue tras Traefik ese origen es el proxy, por lo que el límite es compartido; no se confía en cabeceras de IP arbitrarias.

La reserva suma exclusivamente importes positivos a ingresar de IVA y del pago fraccionado de IRPF configurado; un IVA negativo no se descuenta del IRPF. Cuando no se conoce un régimen, la cifra se presenta como parcial y no se calcula un restante total. No estima la liquidación anual de Renta ni otras obligaciones (p. ej. retenciones a proveedores). El dinero apartado es un total manual por cuenta, año y trimestre, independiente de declaraciones, ingresos y gastos; no mueve dinero ni se arrastra al cambiar de periodo.

## Colaboración y revisión por gestoría

La cartera permite buscar clientes y abrir sus pendientes de todos los periodos. El titular de una cuenta con gestoría activa guarda borradores o los envía; el gestor aprueba y contabiliza, o solicita cambios con un comentario. El cliente corrige y reenvía. Cada intervención conserva autor, fecha y versión, y los documentos pendientes quedan fuera del cálculo fiscal. Las cuentas sin gestoría activa mantienen su revisión propia.

Para volver a una cuenta normal: Clientes → Ajustes e historial → Volver a cuenta de autónomo → Cambiar a autónomo. Los clientes se conservan con acceso suspendido y se invalidan las invitaciones pendientes. Reactivar recupera solo las autorizaciones vigentes. Los equipos internos se administran desde la pestaña Equipo.


## Equipo y asignaciones

Clientes → Equipo permite invitar por código al correo de una cuenta, consultar incorporaciones y asignar clientes a cada colaborador. El invitado abre Gestoría y accesos → Equipo, comprueba el código y acepta. El titular administra toda su cartera; el colaborador ve solo los clientes asignados y puede revisarlos y aprobar documentos con su propia identidad en el historial. Los códigos caducan en 24 horas, son de un solo uso y se comparten manualmente.

Desmarcar un cliente retira acceso; retirar al colaborador o salir del equipo elimina sus asignaciones. Archivar o desactivar suspende el acceso. Revocar desde la cuenta del cliente elimina también las asignaciones del equipo a ese cliente. Una nueva vinculación no las restaura automáticamente. No hay promoción de otros administradores ni rol de solo lectura en esta versión.


## Lectura y rellenado de documentos

La subida valida el archivo y obtiene OCR local; después lo analiza automáticamente con OpenAI cuando está configurado. La extracción distingue emisor y receptor según Gasto/Ingreso, prioriza la fecha de emisión, reconoce formatos monetarios españoles e ingleses, bases con varios tipos de IVA y retenciones, y compara el total con el desglose. Los resultados ambiguos se señalan para revisión. Las fotos se orientan según EXIF y se preparan para Tesseract; los PDF sin texto se rasterizan por página con tamaño limitado.

El formulario conserva campos editados a mano o aplicados desde plantillas, incluso si la lectura termina más tarde. «Datos detectados» permite aplicar una propuesta concreta. Cambiar Gasto/Ingreso cambia el tercero propuesto cuando ese campo no se ha editado. El aviso de diferencia de total se actualiza al modificar los importes. La deducibilidad conserva los valores iniciales del formulario; no se deduce del justificante.

### Lectura automática con IA

Configura **ambas** variables en el proceso backend: `OPENAI_API_KEY` y `DOCUMENT_AI_MODEL`. El modelo elegido debe admitir imágenes, PDF y Structured Outputs. No hay modelo implícito ni claves en el frontend. En Docker, completa `.env` y recrea el contenedor. En la instalación nativa, el servicio admite el archivo opcional `/etc/cuentas/document-ai.env (ruta de ejemplo)`, con permisos 600, y requiere reiniciarse tras configurarlo. En desarrollo, exporta las variables antes de arrancar Uvicorn; el backend no carga `.env` automáticamente.

Subir un documento o abrirlo en revisión envía el original a OpenAI automáticamente, sin confirmación por archivo; genera consumo en la cuenta API. El resultado se guarda en `document_analyses` y se reutiliza en aperturas posteriores y al cambiar Gasto/Ingreso. No se procesan documentos existentes en lote al desplegar. Los fallos dejan disponible el archivo y la lectura local, con aviso y botón «Reintentar lectura con IA». La petición usa Responses API, adjuntos en base64 y `store: false` (esto no equivale a garantizar ausencia de retención por parte del proveedor). No se suben documentos mediante Files API. Hay un máximo de 20 solicitudes por hora y espacio de trabajo, plazo de red de 60 segundos y no se reintenta automáticamente. Se audita quién solicita la lectura y cuándo, sin claves ni contenido del justificante en el historial.

La IA clasifica factura, recibo, otro documento o desconocido, e identifica el país del emisor a partir del original. No se deduce España solo por idioma, euros, IVA o dirección del cliente. Se muestra la clasificación con su evidencia, sin garantizar autenticidad ni validez fiscal. Los documentos extranjeros o de país desconocido rellenan también las bases y el IVA explícitos en euros si el desglose es válido y compatible. Copiar esos importes no determina su tratamiento fiscal ni deducibilidad; las retenciones siguen requiriendo revisión manual. Las lecturas antiguas que descartaron estos importes se actualizan una vez al reabrir. Si no es factura/recibo, no se rellenan campos. Una clasificación posterior retira propuestas locales no editadas que ya no sean válidas, preservando siempre correcciones manuales.

El servidor valida la estructura recibida, fechas, importes en céntimos, moneda y cuotas de IVA. Una respuesta incompleta, rechazada o inválida conserva el formulario. Se excluyen desgloses incompatibles con los tipos e importes admitidos por la aplicación. Los resultados son propuestas y siempre requieren revisión humana; el análisis no crea ni confirma registros.

Referencias de implementación: [archivos en Responses](https://developers.openai.com/api/docs/guides/file-inputs), [imágenes](https://developers.openai.com/api/docs/guides/images-vision) y [respuestas estructuradas](https://developers.openai.com/api/docs/guides/structured-outputs).

### Pruebas del autocompletado

`cd backend && uv run pytest -q` cubre el parser, PDF mixtos, validación de IA, aislamiento y límites. `cd frontend && npm run test:unit` comprueba la conservación de cambios. Con el servidor de pruebas aislado, `npm run test:e2e -- tests/document-autofill.spec.js tests/photo-recurring-packet.spec.js` verifica PDF, OCR real de una foto sintética, propuestas de IA simuladas y escritorio/móvil. Las pruebas no hacen llamadas externas. La calidad de IA sobre documentos reales debe evaluarse al configurar el proveedor.


## Dashboard anual y guía del perfil fiscal

La vista general muestra ingresos brutos (bases de ingresos revisados), gastos (bases de todos los gastos revisados, aunque no sean íntegramente deducibles), beneficio antes de impuestos (diferencia de esas bases) e impuestos pagados registrados. El selector permite comparar el trimestre elegido con el año completo. Las gráficas mensuales de ingresos/gastos, beneficio y pagos incluyen detalle por mes y una tabla accesible. Los borradores quedan fuera; los meses sin documentos tienen cero registros, no una previsión. El beneficio sin IVA no incluye ajustes fiscales ni representa el saldo bancario.

«Registrar o corregir impuestos pagados» guarda los totales mensuales de IVA, IRPF y otros impuestos según los justificantes. Es un registro manual de ingresos directos a Hacienda, por mes del pago, aunque la declaración corresponda a otro trimestre o ejercicio. No incluye retenciones en facturas ni cuotas de autónomos. Guardar sustituye el total del mes; cero explícito y mes sin registrar se distinguen. Los pagos no modifican las estimaciones fiscales, sus ajustes ni el dinero apartado. Se conservan por cuenta y ejercicio, con auditoría del operador y los mismos permisos del expediente; la eliminación de cuenta elimina también estos datos. No hay conciliación bancaria ni comprobación automática con Hacienda.

El perfil ofrece explicaciones junto a cada selección, comparaciones desplegables y enlaces a la AEAT para comprobar el alta censal, los regímenes y la obligación del Modelo 130. El panel «Con esta configuración» indica qué cálculos admite la aplicación. Elegir una modalidad no compatible conserva los registros sin presentar una previsión completa. La directa simplificada también permite estimar el Modelo 130 con los límites indicados.

Para probar en un puerto alternativo, define `PLAYWRIGHT_BASE_URL` al ejecutar los E2E y usa ese mismo origen en `APP_ORIGIN` del servidor de pruebas.

## Ayuda con IA

«Ayuda con IA» ofrece conversaciones privadas sobre el uso de Cuentas con una guía versionada en `backend/app/assistant.py`. Permite crear, cerrar, reabrir y eliminar conversaciones. Cerrar vuelve a la lista y conserva el historial en la cuenta; eliminar requiere confirmación y borra mensajes. No consulta facturas, perfiles ni chats de gestoría, no tiene herramientas y no ejecuta acciones. La pregunta y los mensajes recientes de esa conversación se envían a OpenAI; las respuestas se muestran como texto, sin interpretar HTML. No es asesoramiento fiscal ni garantiza respuestas correctas.

El servidor conserva hasta 50 conversaciones por usuario y 100 envíos por conversación en SQLite, privados del usuario autenticado incluso al trabajar en expedientes delegados. El contexto incluye como máximo cinco intercambios completos y 8000 caracteres de historial; las conversaciones largas siguen visibles, pero el modelo no recibe su parte más antigua. Estos tokens también cuentan en los límites. Las claves de envío evitan cobrar dos veces al recuperar una respuesta completada. Solo se genera una respuesta simultánea por conversación. Un envío interrumpido queda señalado como fallido después de dos minutos; los fallos conservan la reserva de consumo.

Eliminar la cuenta borra sus conversaciones y mensajes por cascada. Las copias cifradas conservan su rotación de 14 días. Se mantiene `/api/assistant` para pestañas de la versión anterior, con los mismos límites y sin almacenar ese formato anterior de preguntas independientes. «Mensajes» se muestra solo con una gestoría activa vinculada, una gestoría propia activa o pertenencia activa a un equipo.

Límites predeterminados, configurables por entorno:

| Variable | Valor |
| --- | ---: |
| `ASSISTANT_DAILY_LIMIT` | 20 preguntas por usuario/día |
| `ASSISTANT_MONTHLY_TOKENS` | 100000 tokens por usuario/mes |
| `ASSISTANT_GLOBAL_DAILY_LIMIT` | 200 preguntas/día en toda la app |
| `ASSISTANT_GLOBAL_MONTHLY_TOKENS` | 1000000 tokens/mes en toda la app |

Además, 3 peticiones por minuto/usuario, 1200 caracteres por pregunta, 600 tokens máximos de salida y 30 segundos de espera. Día y mes naturales en UTC. Los tokens incluyen la guía enviada y la respuesta. Se reserva un margen conservador antes de llamar al proveedor y se ajusta al consumo devuelto; cuando queda menos que la reserva necesaria se rechaza la petición. Un fallo mantiene la reserva y cuenta como intento, porque puede haberse facturado. No hay reintentos automáticos.

Los contadores SQLite se actualizan atómicamente y pertenecen al usuario autenticado, incluso al usar expedientes delegados. Persisten entre reinicios; borrar una cuenta elimina sus contadores pero conserva el consumo global. Son límites exclusivos del asistente, no de la lectura documental ni del resto de usos de la clave API. El límite de tokens no es un presupuesto exacto en euros. `store: false` desactiva el almacenamiento de respuestas recuperables en la API, no garantiza ausencia de retención del proveedor.

Pruebas: `cd backend && uv run pytest -q tests/test_assistant.py`; navegador con servidor aislado: `npm run test:e2e -- tests/assistant.spec.js`. Las pruebas automatizadas simulan el proveedor. Documentación oficial: [Responses API](https://developers.openai.com/api/reference/python/resources/responses/methods/create), [modelo y precios](https://developers.openai.com/api/docs/models/gpt-4.1-mini).

### Eliminar documentos sin registrar

Cada original de «Documentos sin registrar» tiene un botón Eliminar. Tras confirmar, se retiran el archivo y la lectura guardada, se audita el operador y se actualiza la lista. El servidor exige acceso al espacio y rechaza borrar cualquier documento asociado a un registro, incluido un borrador. El borrado se serializa con la asociación a registros; una lectura en curso no puede resucitar un original eliminado. Si falla el borrado físico se registra en la cola de limpieza y se informa al usuario. Las copias cifradas conservan su retención habitual de 14 días.

### Informe contable compartido con la gestoría

En **Facturas y gastos → Informe contable para la gestoría**, elige ejercicio y trimestre y abre **Ver informe / Imprimir**. La vista incluye resumen, comprobaciones pendientes, perfil, estimaciones y ajustes, pagos anotados, registros, notas e historial de revisión. Los justificantes se abren desde cada ficha; la carpeta PDF/ZIP existente permite imprimir o entregar los originales juntos. El anexo incluye los registros anteriores del año necesarios para contrastar el IRPF acumulado. Los borradores están identificados y quedan fuera de los cálculos.

**Crear enlace temporal** guarda una copia fechada del informe. Puedes escoger 1 hora, 24 horas, 3 días, 7 días o 30 días. Copia el enlace al crearlo: no se puede recuperar después, aunque sí revocarlo y crear otro. Cualquier persona que lo reciba puede consultar los datos y descargar los justificantes incluidos sin una cuenta. El enlace no incorpora cambios posteriores; crea uno nuevo para entregar una nueva versión.

El servidor comprueba la caducidad y la revocación en cada petición de informe o justificante. La página abierta comprueba la vigencia cada 30 segundos y muestra una cuenta atrás. Las copias ya descargadas o impresas no se pueden retirar. Los buscadores reciben `noindex, nofollow, noarchive, nosnippet`; no se promete invisibilidad absoluta en internet. Los accesos usan `Cache-Control: no-store` y `Referrer-Policy: no-referrer`, y la PWA no almacena estas rutas `/api/`.

Límites: 20 enlaces activos por espacio y 1000 registros acumulados por informe. Los enlaces vencidos se eliminan de la base de datos al crear el siguiente enlace; dejan de funcionar en su fecha de caducidad aunque no se haya ejecutado esa limpieza. Al eliminar la cuenta, se eliminan sus copias compartidas. Las pruebas están en `backend/tests/test_reports.py` y `frontend/tests/reports.spec.js`.


### Cambio de régimen y comprobación de originales

La directa simplificada recalcula los registros existentes e incluye automáticamente provisiones y gastos de difícil justificación: 5 % del rendimiento positivo acumulado (7 % en 2023), con límite anual de 2.000 €. No se prorratea ese límite por trimestre ni se duplica la deducción en otros gastos. Las amortizaciones siguen siendo un ajuste manual. No se incluyen especialidades territoriales ni la reducción incompatible del artículo 32.2.1.º. El perfil se aplica a los periodos consultados; cambiarlo no crea un historial de altas censales. El IVA general conserva su cálculo independiente, por fecha de factura y trimestre.

En **Facturas y gastos → Comprobar todas las facturas**, se contrastan los registros de todos los periodos con una lectura independiente de sus originales mediante OpenAI. Se comparan fecha de emisión, número, tercero/NIF, bases agrupadas por tipo de IVA, retención y total; las diferencias de fecha que cambiarían el trimestre se destacan. Datos ausentes, documentos sin original y lecturas incompletas no cuentan como coincidencias. La clasificación, deducibilidad, notas y tratamiento fiscal necesitan revisión manual. El proceso no edita ni aprueba registros.

La lectura de comprobación se guarda aparte del autocompletado y se reutiliza al volver a comprobar; «Volver a leer original» solicita una lectura nueva. Tras editar un registro, el resultado queda desactualizado hasta contrastarlo de nuevo. Las comprobaciones ya terminadas persisten al cerrar la página. El botón Detener termina tras el archivo actual; salir interrumpe el envío de los siguientes. Hasta 100 lecturas nuevas por hora y espacio, independientes del límite de carga/autocompletado, con gasto en la API configurada. Los errores conservan los registros y permiten continuar. Las copias de seguridad incluyen las comprobaciones; borrar un registro elimina su comprobación.


### Corrección rápida y eliminación conjunta

Tras comprobar originales, **Corregir discrepancias** aplica las propuestas disponibles de un registro; **Corregir todas las discrepancias (N)** procesa los registros corregibles de todos los periodos. Se actualizan listas y estimaciones, incluido el trimestre cuando cambia la fecha. No hace nuevas llamadas de IA. Las propuestas se calculan en servidor y se valida tanto la versión de factura como la identidad de la lectura: una edición o relectura posterior obliga a actualizar antes de aplicar. Cada corrección conserva el antes/después en el historial. No salta los permisos de aprobación de gestoría.

Se conservan categoría, notas, original y porcentajes de deducibilidad. Los importes solo se aplican si su desglose permite reconciliar exactamente el total leído; las deducibilidades ambiguas y totales sin desglose quedan para revisión manual. Una corrección parcial puede resolver la fecha y dejar importes pendientes. La operación conjunta muestra los éxitos y los registros sin corregir; no revierte correcciones ya guardadas si otro registro falla.

**Documentos sin registrar → Eliminar todos (N)** ofrece una confirmación con el número de archivos. Solo solicita los identificadores visibles al pulsar: archivos nuevos o asociados entretanto a un registro se conservan. El borrado individual confirma junto al archivo. Los paneles usan claves de React distintas para evitar duplicados al navegar entre pantallas.

Prueba de navegador de estas acciones: arrancar `DATA_DIR=/tmp/corrections-cuentas-e2e APP_ORIGIN=http://127.0.0.1:8018 uv run python tests/serve_invoice_checks.py` desde backend y ejecutar `INVOICE_CHECKS_FIXTURE=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:8018 npm run test:e2e -- tests/check-corrections.spec.js` desde frontend. Este servidor de pruebas usa una lectura sintética y nunca llama al proveedor real.


### Eliminar facturas o gastos duplicados

Abre el registro desde Facturas y gastos y pulsa **Eliminar factura** o **Eliminar gasto**. Se pide confirmación, se verifica la versión y se retira el registro de los cálculos con auditoría del operador. El justificante se conserva: si ningún otro registro lo usa, aparece en Documentos sin registrar. En cuentas con gestoría activa, solo un operador delegado puede eliminar registros ya contabilizados; los borradores conservan los permisos anteriores. Los informes compartidos son copias fechadas y no se reescriben tras eliminar un registro.
