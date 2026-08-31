# Contexto del proyecto — Tablero de Soporte (CE-Retention)

Última actualización: 28-ago-2026.

Este documento resume, en un solo lugar, cómo funciona el tablero completo: de dónde sale cada dato, cómo se calcula cada métrica, qué está hardcodeado temporalmente y por qué, y qué preguntas/hallazgos quedaron abiertos. Es el documento a usar para replicar el proceso en otros tableros (ej. el de Lucía) o para retomar el trabajo si se hace en otra sesión.

---

## 1. Qué es el proyecto

Un tablero (`index.html`, servido por una API en `lib/metrics.mjs` + `lib/hubspot.mjs`, desplegado en Vercel) que muestra métricas operativas de soporte: volumen de tickets, tiempo de cierre, tasa de reapertura (reopen), FCR (resolución en primer contacto) y CSAT (satisfacción), más un desglose por país/versión y una tendencia mensual.

Toda la data sale de **HubSpot** (objeto `TICKET`). Ya no se usa Metabase para nada — eso se eliminó en una limpieza anterior del proyecto.

Repo local del usuario: `C:\Users\jesus\Documents\dashboard\ce-retention-soporte-ops` (carpeta conectada a esta sesión). El push a GitHub siempre se hace manualmente desde PowerShell en la máquina del usuario porque la sesión en la nube no tiene credenciales de git.

---

## 2. Filtro base — común a (casi) todas las métricas

Documentado en `MAPEO_CAMPOS_TABLA.md`. Se aplica salvo que se indique lo contrario:

```
hs_pipeline IN (lista_pipelines_soporte + pipelines_legacy)
AND createdate >= inicio_del_período   -- por defecto: 1-ene del año en curso
AND createdate <= fin_del_período      -- por defecto: hoy
AND hs_all_associated_contact_emails != 'mailer-daemon@amazonses.com'   -- excluye rebotes
AND hubspot_owner_id != <owner de Lucía>   -- solo si HUBSPOT_OWNER_LUCIA está seteada
```

### 2.1 Pipeline — el bug histórico más importante que se encontró

La propiedad real en HubSpot **no es `pipeline`** (esa propiedad no existe en el objeto Ticket) — es **`hs_pipeline`**, y sus valores son **IDs numéricos**, no nombres. Antes de corregirlo (27-ago-2026), el código filtraba por nombre sobre una propiedad que no existía, así que es muy probable que ningún filtro de pipeline haya matcheado nunca correctamente en versiones previas del tablero.

Los 18 pipelines de soporte confirmados en el panel oficial de HubSpot, con su ID real:

| Pipeline | ID |
|---|---|
| MEX_Sup | 1857352 |
| Acrecer_Sup | 2238445 |
| COL_Sup | 1857341 |
| Premium Sup (No transferir) | 2236512 |
| Nómina_Sup | 1940485 |
| Alianza de Pagos y Fintech | 1940463 |
| Dentalink | 1940496 |
| DOM_Sup | 1857358 |
| Payments Sup | 1855951 |
| POS_Sup | 1940490 |
| Innpulsa_Sup | 1936983 |
| Consultas API_Sup | 38406328 |
| Solicitudes Partners_Sup | 97373833 |
| Customer support | 745378666 |
| Contador Sup | 1940479 |
| Plan Fundaciones y Educación | 1940502 |
| Alegra Tienda_Sup | 2236244 |
| Integraciones_Sup | 99256347 |

Más 2 pipelines legacy (ya no aparecen por nombre en HubSpot, pero el panel oficial los incluye como "alguna vez ha sido"): `2302067`, `1857375`.

En código (`lib/hubspot.mjs`) esto se expresa como **un solo filtro `IN`** con las 20 IDs juntas — no como dos filterGroups separados — porque HubSpot Search API tiene un límite de filtros combinados por consulta (visto en producción: máx. 18) y duplicar el filtro de pipeline por cada alternativa se comía ese límite rápido, rompiendo las consultas de FCR y tiempo de cierre con un error `400 "too many total filters across filter groups"`.

### 2.2 Exclusión de rebotes

Caso REVOPS-1324: se excluyen tickets cuyo `hs_all_associated_contact_emails` sea `mailer-daemon@amazonses.com` — son bounces automáticos de correo, no casos reales de soporte.

### 2.3 Exclusión de Lucía

Si la env var `HUBSPOT_OWNER_LUCIA` está seteada, se excluye `hubspot_owner_id = ese owner` — para no contar lo que gestiona la asistente automatizada Lucía. Si la variable no está seteada, no se excluye nada (nunca falla por su ausencia).

---

## 3. Cómo se calcula cada métrica

### 3.1 Volumen de tickets

`COUNT(*)` de tickets que cumplen el filtro base, agrupados por `createdate` dentro del período. No incluye rebotes (ver 2.2).

### 3.2 Cerrados

"Cerrado" = `closed_date` está poblado (`HAS_PROPERTY`). Confirmado 21-ago-2026.

### 3.3 Reopen (tasa de reapertura)

Definición confirmada con Estefanía Messa (REVPYME-732, revisado en vivo 27-ago-2026): un ticket cuenta como reopen si **cualquiera** de estas dos propiedades vale exactamente `'Nueva consulta'`:
- `reopen__retroactivo_tema_diferente` (valores posibles: `Nueva consulta`, `Cierre agradecimiento`, `Ambiguo`)
- `ticket_reabierto__wf` (valores posibles: `Nueva consulta`, `Cierre o agradecimiento` — aquí NO existe la categoría `Ambiguo`)

`Ambiguo` y `Cierre agradecimiento`/`Cierre o agradecimiento` **NO cuentan** como reopen — solo `'Nueva consulta'` en cualquiera de las dos.

`Reopen % = reopen / volumen × 100`. Validado dos veces en vivo: 3,3% (1.510/45.321) y 3,18% (1.438/45.240).

### 3.4 FCR (resolución en primer contacto)

`FCR = cerrados − cerrados_que_reabrieron` (algebraico — no se filtra "ninguna de las dos propiedades dice Nueva consulta" directo porque eso requiere un combo NOT_HAS_PROPERTY/NEQ que duplica filtros y vuelve a chocar con el límite de 18 filtros de HubSpot Search API).

`cerrados_que_reabrieron` = tickets cerrados (`closed_date HAS_PROPERTY`) que ADEMÁS cumplen la condición de reopen de 3.3 (cualquiera de las dos propiedades = `'Nueva consulta'`).

`FCR % = FCR / cerrados × 100`. Con datos reales (createdate, corte 27-ago-2026): 42.015/43.406 = **96,8%**.

**⚠️ Punto en discusión con Lauren Pacheco (28-ago-2026):** ella propuso una variante de este cálculo por Slack, con dos diferencias:
1. Su query filtra por **`closed_date`** (cuándo se cerró) en vez de `createdate` (cuándo se creó) — universo distinto: da 45.425 cerrados vs. 43.406 con `createdate`.
2. Su query aplica un buffer de **3 días** sobre `closed_date` (`closed_date < NOW() − INTERVAL 3 days`) para no contar como "resuelto en primer contacto" un ticket que fue cerrado hace muy poco y todavía podría reabrirse.
3. Su query **también excluye `'Ambiguo'`** en `reopen__retroactivo_tema_diferente` del numerador del FCR (no solo `'Nueva consulta'`) — esto es una diferencia real de definición, no solo de universo.

Corrí su query exacta contra HubSpot en vivo (28-ago-2026): con su ajuste de Ambiguo, FCR = 43.976/45.425 = **96,8%**. Sin ese ajuste (como está hoy el dashboard, solo `'Nueva consulta'` cuenta), sobre el mismo universo de `closed_date`: FCR = 44.044/45.425 = **97,0%**. Diferencia: 68 tickets.

**Pendiente de resolver:** ¿"Ambiguo" en `reopen__retroactivo_tema_diferente` debería excluirse del FCR (como propone Lauren) o seguir contando como resuelto en primer contacto (como confirmó Estefanía y como está implementado hoy)? Si se decide cambiarlo, hay que actualizar `MAPEO_CAMPOS_TABLA.md` y la lógica de `REOPEN_RETRO` en `lib/hubspot.mjs` (y el hardcode en `lib/metrics.mjs` si sigue activo).

### 3.5 Tiempo de cierre promedio

Se usa la propiedad **`time_to_close`** de HubSpot (ya viene calculada en milisegundos por HubSpot, creación→cierre), promediada sobre tickets cerrados **excluyendo** los que reabrieron (misma definición de reopen de 3.3). No es un cálculo manual de `closed_date − createdate` — se usa el campo nativo de HubSpot.

Regla de formato en el tablero: si el promedio es menor a 72 horas, se muestra en horas; si es 72 horas o más, se muestra en días (pedido explícito del usuario, aplicado en `fmtDuracion()` de `index.html`).

### 3.6 CSAT (satisfacción)

**Propiedad real:** `clasificacion_encuesta_ces_csat` (nombre interno confirmado en Configuración → Propiedades → Tickets). Antes el código buscaba una propiedad con otro nombre (`fecha_ultima_encuesta_csat`, sin la "r" extra) que no existía.

**Valores:** en inglés — `Promoter`, `Passive`, `Detractor` (NO `Promotor`/`Neutro`/`Detractor` en español, que es lo que se asumía antes por error).

**Fecha de filtro — OJO, eje de tiempo distinto:** CSAT se agrupa/filtra por `fecha_de_la_ultima_encuestra_ces_csat` (cuándo se **contestó** la encuesta — nombre real, con la "r" extra en "encuestra"), **no** por `createdate` del ticket. Un ticket creado en julio puede tener su encuesta contestada en agosto, y por lo tanto aparecer en el corte de CSAT de agosto aunque su `createdate` sea de julio.

`CSAT % = Promoter / (Promoter + Passive + Detractor) × 100`.

Validado en vivo contra el panel oficial "Satisfacción" de HubSpot: **83,63%** exacto (2.054 Promoter / 2.456 total respuestas), con 4 filtros del panel oficial reproducidos.

Distribución CSAT (gráfico de barras): eje X en orden fijo Detractor → Passive → Promoter (etiquetas en español en el tablero: Detractor, Neutro, Promotor), con el % de cada barra mostrado encima (plugin custom de Chart.js).

### 3.7 Distribución por país (llamada "versión" en el código/tablero)

**Hallazgo importante:** la propiedad `version` (nombre interno; label en HubSpot: "HD - Versión") **no contiene versiones de producto — contiene nombres de país**: `colombia`, `mexico`, `republicaDominicana`, etc. Esto contradice la premisa original del proyecto de que "no hay ninguna propiedad de país confiable en HubSpot", que en su momento llevó a quitar el corte por país del tablero. De hecho sí existe, con este nombre.

**Pendiente de decisión (no resuelto aún):** ¿renombrar esta sección del tablero de "Versión" a "País" para reflejar lo que realmente muestra?

Esta tabla **no está desglosada por mes** — muestra siempre el total agregado del corte completo (ene–ago 2026), sin importar qué mes/rango se elija en el filtro de período del tablero. Hacerlo por mes implicaría 13 países × 8 meses de consultas adicionales por MCP; no se hizo por ahora.

### 3.8 Tendencia (gráfico de volumen mensual)

Gráfico de barras con el volumen de tickets creados por mes (antes era semanal — se cambió a mensual por pedido explícito). No está afectado por el filtro de período del tablero (siempre muestra la serie completa ene–ago).

---

## 4. El hardcode temporal — por qué existe y cómo funciona

**Motivo:** mientras se construye el sistema de "cubos" (precómputo de buckets semanales/mensuales en Vercel KV, ver `PLAN_IMPLEMENTACION.md`), cada carga del tablero hacía 6-8 llamadas en vivo a la API de HubSpot. Con varias personas abriendo el tablero a la vez, esto saturó el límite por segundo de la cuenta (`429 RATE_LIMIT`). Por pedido explícito del usuario, se reemplazaron las llamadas en vivo por un valor fijo (hardcodeado), sacado en un momento puntual vía HubSpot MCP.

**Dónde vive:** `lib/metrics.mjs`, constante `HARDCODE_TEMPORAL = true` cerca del inicio del archivo. Mientras esté en `true`, `buildMetrics()` nunca llama a HubSpot en vivo — todo sale de arrays hardcodeados. Para volver al modo en vivo (una vez se resuelva el rate limit o se construyan los cubos), basta poner `HARDCODE_TEMPORAL = false`.

**Cómo se construyó para que el filtro de período siga funcionando razonablemente:**

En vez de un solo total fijo para todo el corte (que ignoraba el filtro de fecha por completo — bug real que existió un rato), se sacó por HubSpot MCP el desglose **mes por mes** (enero a agosto 2026) de cada métrica:
- Volumen, cerrados, reopen, cerrados-reabiertos y tiempo de cierre: agrupados por `createdate`.
- CSAT (Promoter/Passive/Detractor): agrupado por `fecha_de_la_ultima_encuestra_ces_csat` (fecha de encuesta contestada — eje distinto, ver 3.6).

Estos arrays mensuales quedan documentados en `METRICAS_MCP.md`, "Corte 2". La función `hardcodeMetrics(start, end)` en `lib/metrics.mjs` determina qué meses caen dentro del rango `[start, end]` pedido (función `mesesIncluidos()`) y **suma solo esos meses** — así, si el usuario filtra por "Febrero 2026" o por un rango "Febrero–Marzo 2026", el tablero muestra el sub-total real de esos meses, no el total del corte completo repetido.

El tiempo de cierre se promedia **ponderado** por la cantidad de tickets base de cada mes incluido (no un promedio simple de promedios mensuales, que distorsionaría el resultado cuando se mezclan meses con volúmenes distintos).

**Limitación conocida:** si el usuario elige una fecha personalizada más fina que un mes completo (ej. 15-feb a 20-feb), no hay dato hardcodeado a ese nivel de granularidad — el código cae de vuelta a sumar todos los meses disponibles como fallback, para no devolver ceros. La distribución por país (3.7) tampoco tiene desglose mensual — siempre usa el total agregado completo.

**Fuente de los números hardcodeados:** `METRICAS_MCP.md`, que es un registro acumulativo (sin deduplicar — cada corte queda con su fecha/hora y rango usado) de todo lo que se ha sacado en vivo por HubSpot MCP para este propósito. Tiene dos cortes: "Corte 1" (totales agregados ene–ago) y "Corte 2" (desglose mensual).

---

## 5. Metodología para replicar esto en otro tablero (ej. el de Lucía)

Si se quiere aplicar el mismo enfoque de "hardcode temporal mensual" a otro tablero:

1. **Confirmar los nombres reales de las propiedades vía HubSpot MCP** (`search_properties`, `get_properties`) antes de asumir nada — no confiar en los nombres que aparecen en documentación vieja o en el código actual. En este proyecto, 3 de las propiedades más importantes (`pipeline`, `hd_version`, `fecha_ultima_encuesta_csat`) tenían nombres equivocados que llevaban meses sin matchear nada.
2. **Identificar qué propiedad de fecha corresponde a cada métrica.** No asumir que todo se agrupa por `createdate` — verificar si hay métricas basadas en un evento posterior (una encuesta contestada, un cierre, una reapertura) que deban agruparse por su propia fecha, no por la de creación del ticket.
3. **Escribir una query SQL por métrica** usando `mcp__HubSpot__query_crm_data` con `DATE_TRUNC(propiedad_fecha, 'MONTH')` en el `GROUP BY`, filtrando por el mismo filtro base (pipeline, rango de fechas, exclusiones). Recordar las limitaciones de este SQL-like: no hay `SELECT DISTINCT`, `AS` aliases, `CASE WHEN`, `COALESCE`, ni `HAVING`.
4. **Validar el desglose mensual sumando contra un total ya conocido/confiable.** Si las sumas no coinciden (o casi), algo está mal en la query antes de hardcodear nada.
5. **Guardar todo en un `.md` de registro acumulativo** (sin deduplicar cortes anteriores) para trazabilidad — cada corte con su fecha, rango, y qué propiedades/filtros se usaron.
6. **En el código**, guardar los arrays mensuales y sumar solo los meses que caen en el rango pedido por el filtro de período del tablero — no repetir siempre el total del corte completo.
7. **Documentar explícitamente qué partes del tablero NO tienen desglose mensual** (por costo de las queries adicionales) y por lo tanto no van a reaccionar al filtro de fecha — para que quede claro y no se asuma que todo el tablero es dinámico.

---

## 6. Archivos clave del repo

- `index.html` — el tablero completo (HTML+CSS+JS en un solo archivo). Incluye el selector de período (mes único / rango de meses / año completo / fecha personalizada), los KPIs, el gráfico de tendencia mensual, la distribución CSAT, y la tabla de país/versión.
- `lib/metrics.mjs` — orquesta el cálculo de todas las métricas (`buildMetrics()`), aplica el hardcode temporal (`HARDCODE_TEMPORAL`), y valida cordura de los datos antes de servirlos (`validarMetrics()`).
- `lib/hubspot.mjs` — todas las consultas en vivo a la HubSpot Search API (usadas solo cuando `HARDCODE_TEMPORAL = false`). Contiene los filtros base, los IDs de pipeline, y las funciones `fetchHubspotMetrics`, `fetchTiempoCierre`, `fetchCsat`, `fetchDistribucionVersion`, `fetchTendenciaSemanal`.
- `MAPEO_CAMPOS_TABLA.md` — documentación de qué propiedad de HubSpot alimenta cada métrica, con el SQL/fórmula de cada una. Es la referencia "de negocio" de cómo se define cada métrica.
- `METRICAS_MCP.md` — registro acumulativo de todo lo sacado en vivo por HubSpot MCP (Corte 1: totales agregados; Corte 2: desglose mensual). Es la fuente de los números hardcodeados en `lib/metrics.mjs`.
- `PLAN_IMPLEMENTACION.md` — plan (no ejecutado aún) para el sistema de "cubos" en Vercel KV que reemplazaría el hardcode temporal por datos siempre frescos sin pegarle en vivo a HubSpot en cada carga.

---

## 7. Preguntas / decisiones pendientes (a la fecha de este documento)

1. **FCR y "Ambiguo":** ¿debería `'Ambiguo'` en `reopen__retroactivo_tema_diferente` excluirse del FCR (propuesta de Lauren) o seguir contando como resuelto en primer contacto (definición actual, confirmada por Estefanía)? Sin resolver.
2. **"Versión" vs. "País":** ¿renombrar esa sección del tablero ahora que se confirmó que la propiedad `version` en realidad guarda país, no versión de producto? Sin resolver.
3. **Universo de FCR/tiempo de cierre:** ¿debería el cálculo filtrar por `createdate` (como está hoy) o por `closed_date` con un buffer de días (como propone Lauren)? Son universos distintos y dan números distintos incluso con la misma definición de reopen. Sin resolver.
4. **Cubos (Vercel KV):** sigue sin construirse — el hardcode temporal (`HARDCODE_TEMPORAL = true`) sigue activo y depende de refrescarse manualmente cada vez que se necesite un corte más reciente.
5. **Desglose mensual de país/versión:** no se sacó por MCP — pendiente si se decide que vale el costo de las consultas adicionales.
