# Mapeo de métricas — Tablero de Soporte

Inventario completo del tablero, **elemento por elemento**, en el mismo orden en que aparecen en pantalla. Para cada uno: qué muestra, de dónde sale el dato y cómo se calcula.

Sirve para responder "¿de dónde sale este número?" sin revisar el código, y para que alguien de datos pueda auditar cualquier valor por su cuenta.

**Estado al 27-ago-2026.** Los valores de ejemplo corresponden al período 01-may-2026 → 27-ago-2026.

## Resumen de confiabilidad

| Estado | Cuántos | Cuáles |
|---|---|---|
| Validado contra fuente oficial | 2 | Volumen, Reopen |
| Correcto, con salvedad documentada | 4 | Tiempo de cierre, CSAT, País, Tendencia semanal |
| **Sin validar — evidencia de que mide mal** | **1** | **FCR** |
| Convención de presentación sin respaldo formal | 2 | Semáforo de la tabla de países, semanas "censuradas" |

## Las dos fuentes

| Fuente | Qué aporta | Cómo se consulta |
|---|---|---|
| **HubSpot** | Volumen, Reopen, FCR | Objeto `tickets`, filtrando `createdate` en el rango elegido |
| **Metabase** | Tiempo de cierre, CSAT, País, Tendencia semanal | Tabla `bi_ce_interactions` (base **Viz**, esquema `dm_customer_experience`), filtrando `channel = 'ticket'` y `created_at` en el rango |

---

# 1. Encabezado

## "Actualizado: <fecha>"

> **⚠ TEMPORAL:** hoy muestra **siempre la fecha de hoy**, calculada en el navegador — no la fecha real del dato. Es una decisión provisional y está marcada en el código como `TEMPORAL`. Mientras siga así, el encabezado dirá "hoy" aunque una parte de los datos sea más antigua.

Cuando se revierta, mostrará `meta.generado`, que es la fecha de corte real del período consultado.

## Subtítulo — "Período <desde> — <hasta>"

Sale de `meta.periodo.label`. Refleja el rango efectivamente consultado, no el que está escrito en los campos del filtro. Si el API ajusta o ignora un parámetro, acá se ve el rango real.

---

# 2. Barra de filtros

## Desde / Hasta

Dos campos de fecha editables. Al presionar **Aplicar** se vuelve a consultar `/api/metrics?desde=…&hasta=…`, y **HubSpot y Metabase recalculan todo sobre ese rango**. No es un filtro visual: son consultas nuevas a las dos fuentes.

El filtro acota por **fecha de creación del ticket** (`createdate` en HubSpot, `created_at` en Metabase). Un ticket creado en junio y cerrado en agosto pertenece al rango de junio.

El día "hasta" se incluye completo (hasta las 23:59:59).

**Validaciones:** si el rango está invertido o una fecha tiene formato inválido, el API responde con un error explicando el motivo, sin consultar las fuentes.

---

# 3. Sección "Soporte" — Tarjetas de KPI

Cinco tarjetas. Cada una muestra únicamente etiqueta y valor.

## 3.1 Volumen de tickets — 110.023

**HubSpot** · Validado

```
COUNT(tickets)
  WHERE createdate ENTRE desde Y hasta
    AND hs_all_associated_contact_emails ≠ "mailer-daemon@amazonses.com"
```

La exclusión corresponde al caso REVOPS-1324: `mailer-daemon@amazonses.com` es el remitente automático de rebotes de Amazon SES, el correo del sistema de facturación electrónica. No son casos de soporte, pero entraban al pipeline como tickets normales e inflaban el volumen con picos de miles de un día a otro.

La comparación es **exacta** (`NEQ`) y deliberadamente **no** "contiene": esa otra forma fragmenta el correo por los puntos y genera falsos positivos.

Este número es además el **denominador del Reopen rate** y la base de la columna "% del total" de la tabla de países.

## 3.2 Tiempo de cierre promedio — 47,2 h

**Metabase** · Validado

```
AVG(time_to_close_seconds) ÷ 3600
  WHERE channel = 'ticket'
    AND created_at ENTRE desde Y hasta
    AND closed_at TIENE VALOR
```

Solo entran los tickets que **ya cerraron**. Los que siguen abiertos quedan fuera del promedio hasta que cierren, para no arrastrarlo artificialmente hacia abajo.

## 3.3 Reopen rate — 0,52%

**HubSpot** · Validado, con 1 salvedad

```
COUNT DISTINCT(tickets)
  WHERE createdate ENTRE desde Y hasta
    AND (
      reopen__retroactivo_tema_diferente EN ("Nueva consulta", "Ambiguo")
      O ticket_reabierto__wf = "Nueva consulta"
    )
÷ Volumen de tickets
```

**Definición:** un reopen es un ticket que, tras estar cerrado **3 días o más**, recibe un mensaje nuevo del cliente que requiere gestión. No cuentan los agradecimientos ni las reaperturas generadas por el propio agente.

La lógica ya viene aplicada y marcada dentro de HubSpot por el equipo de datos, en dos propiedades según la ventana de tiempo:

| Ventana | Propiedad | Valores que cuentan | Valores que no |
|---|---|---|---|
| Hasta 20-ago-2026 | `reopen__retroactivo_tema_diferente` | `Nueva consulta`, `Ambiguo` | `Cierre agradecimiento` |
| Desde 21-ago-2026 | `ticket_reabierto__wf` | `Nueva consulta` | `Cierre o agradecimiento` |

`Ambiguo` cuenta a propósito: el flujo es *fail-safe* — ante la duda asume que el mensaje sí requiere gestión, para no perder una solicitud real.

**Validación:** los conteos coinciden **exactamente** con el reporte del caso REVPYME-732 — 1.413 "nueva consulta" y 70 "ambiguo". Definición construida y avalada por Estefanía Messa.

**Por qué cambió:** antes se usaba `hs_ticket_reopened_at`, un campo automático que se activa con cualquier reapertura sin distinguir el motivo (se prendía igual si el cliente solo agradecía, si un agente tocaba el ticket, o si pasaba el mismo día del cierre). Sobrecontaba unas **4,5 veces** — 2,53% contra 0,52%.

**Detalle de implementación:** los dos filtros van como grupos separados unidos con OR, para que HubSpot devuelva el total ya deduplicado. Hay tickets creados antes del 21-ago que quedaron marcados como retroactivos y que después se reabrieron vía flujo — tienen las dos propiedades. Sumar dos búsquedas por separado los contaría doble (hoy son 4 casos, y van a crecer).

> **⚠ Salvedad:** la fórmula oficial se limita a los 18 pipelines de soporte. El numerador ya queda acotado a esos pipelines porque solo esos tickets recibieron la marca, pero el denominador cuenta todos los tickets del portal. **La tasa real de soporte sería algo más alta que 0,52%.** Falta la lista de esos 18 pipelines para dejarlo exacto.

## 3.4 FCR (1er contacto) — 39,3%

**HubSpot** · **SIN VALIDAR**

```
COUNT(tickets WHERE hs_num_times_contacted = 1 AND closed_date TIENE VALOR)
÷ COUNT(tickets WHERE closed_date TIENE VALOR)
```

> **🔴 Este indicador mide algo distinto de lo que dice medir.**

Las dos propiedades no son equivalentes:

| Propiedad | Qué mide (definición de HubSpot) |
|---|---|
| `hs_is_one_touch_ticket` — *First contact resolution* | "was the ticket closed with just one agent message sent" — el campo **oficial** |
| `hs_num_times_contacted` — *Number of times contacted* | "the number of times a call, email, or meeting was logged on the ticket" — la **aproximación** que se usa hoy |

El campo oficial cuenta **un solo mensaje del agente**. La aproximación cuenta **todas** las interacciones registradas, en ambas direcciones. Un caso resuelto al primer contacto normalmente tiene dos —el cliente escribe y el agente responde— y esa aproximación lo excluye.

**Evidencia:** de los 29 tickets que el campo oficial marca como resueltos al primer contacto, la aproximación solo captura 10. Está dejando fuera unos dos tercios, así que **el 39,3% probablemente está subestimado**.

**Dato que corrige un supuesto previo:** se creía que el campo oficial no se poblaba desde mayo. Sí tiene datos — 1.696 tickets cerrados, incluidos algunos creados hoy. Está escaso (1,6% de los cerrados), pero activo.

**Cautela:** la comparación se apoya en 29 casos sobre un campo poblado en el 1,6% de los tickets. Sirve para señalar la dirección del error, no para cuantificarlo.

**Nota sobre el denominador:** "cerrado" se define como `closed_date` con valor. Se confirmó el 21-ago-2026 y reemplazó a un filtro anterior demasiado amplio que también contaba tickets abiertos.

**Pendiente:** preguntarle al equipo de datos por qué el campo oficial se pobla tan poco, y evaluar reconstruir el FCR con la lógica real de "un mensaje del agente", como ya se hizo con el reopen.

## 3.5 CSAT (Promoter) — 94,7%

**Metabase** · Correcto, con 1 salvedad

```
COUNT(*) AGRUPADO POR csat_classification
  WHERE channel = 'ticket'
    AND created_at ENTRE desde Y hasta
    AND csat_classification TIENE VALOR

Promoter ÷ (Promoter + Passive + Detractor)
```

> **⚠ Salvedad:** solo el 6% de los tickets tiene encuesta respondida (6.256 respuestas sobre el período). El indicador refleja a quienes respondieron, no al total de clientes atendidos.

---

# 4. Sección "Evolución" — Dos gráficos

Subtítulo fijo en pantalla: *"Semanas grises = datos incompletos (tickets muy recientes que aún no cierran)"*.

## 4.1 Gráfico "Volumen semanal y tiempo de cierre"

Gráfico combinado, dos series sobre ejes distintos.

| Serie | Tipo | Eje | Dato |
|---|---|---|---|
| **Tickets creados** | Barras (teal) | Izquierdo — "Tickets" | `COUNT(*)` agrupado por semana de `created_at` |
| **Horas prom. hasta cierre** | Línea (azul oscuro) | Derecho — "Horas" | `AVG(time_to_close_seconds) ÷ 3600` por la misma semana |

**Fuente:** Metabase, misma tabla y filtros que el resto.

```
COUNT(*) y AVG(time_to_close_seconds) ÷ 3600
  AGRUPADO POR SEMANA(created_at)
```

**Las barras grises.** Las últimas semanas se pintan en gris en vez de teal. No es decoración: marca las semanas cuyos tickets **todavía no han tenido tiempo de cerrarse**, por lo que su promedio de horas se ve artificialmente bajo y podría leerse como una mejora que no ocurrió.

> **⚠ Convención sin respaldo formal:** el criterio para marcar una semana como incompleta lo definí yo, no viene de una regla de negocio — una semana reciente cuyo volumen sea **menor al 40% del promedio de las anteriores** se considera incompleta. Es un umbral razonable pero arbitrario. Vale la pena confirmarlo con el equipo de datos o reemplazarlo por una regla explícita (por ejemplo, "las últimas 2 semanas siempre").

## 4.2 Gráfico "Distribución CSAT"

Barras horizontales, tres categorías, en **conteos absolutos** (no porcentajes).

| Barra | Color | Dato |
|---|---|---|
| Promoter | Verde | `COUNT(*)` donde `csat_classification = 'Promoter'` |
| Passive | Ámbar | `COUNT(*)` donde `csat_classification = 'Passive'` |
| Detractor | Rojo | `COUNT(*)` donde `csat_classification = 'Detractor'` |

**Subtítulo dinámico:** *"De los tickets con encuesta respondida (N)"*, donde N es la suma de las tres barras.

**Relación con el KPI:** la tarjeta de CSAT muestra el **porcentaje** de Promoter sobre ese mismo total; este gráfico muestra los **conteos** que lo componen. Son el mismo dato en dos presentaciones.

---

# 5. Sección "Corte geográfico" — Un gráfico y una tabla

Ambos salen de la misma consulta a Metabase:

```
COUNT(*) y AVG(time_to_close_seconds) ÷ 3600
  AGRUPADO POR country
  WHERE channel = 'ticket' AND created_at ENTRE desde Y hasta
```

Los códigos se traducen a nombre: `COL` Colombia, `DOM` Rep. Dominicana, `MEX` México, `CRI` Costa Rica, `ARG` Argentina, `PAN` Panamá, `PER` Perú. Los tickets de otros países (`USA`, `ESP`) **quedan fuera del tablero**.

## 5.1 Gráfico "Horas promedio hasta cierre"

Barras horizontales, un país por barra, **ordenadas de mayor a menor** tiempo de cierre.

> **⚠ Inconsistencia entre el gráfico y la tabla:** este gráfico **excluye** la fila "Sin país", mientras que la tabla de al lado **sí la incluye**. Es intencional —una barra que representa al 90% de los tickets aplastaría visualmente al resto— pero no está señalado en pantalla, así que quien compare los dos elementos puede confundirse. Convendría rotularlo.

## 5.2 Tabla "Detalle por país"

Cuatro columnas:

| Columna | De dónde sale |
|---|---|
| **País** | Nombre traducido del código. "Sin país" se muestra con una etiqueta gris |
| **Tickets** | `COUNT(*)` por país (Metabase) |
| **% del total** | Tickets del país ÷ **Volumen de HubSpot** |
| **Cierre prom.** | `AVG(time_to_close_seconds) ÷ 3600` por país (Metabase) |

**El semáforo de la columna "Cierre prom.":**

| Apariencia | Condición |
|---|---|
| Etiqueta roja | ≥ 90 horas |
| Etiqueta verde | ≤ 15 horas |
| Texto normal | Entre 15 y 90 horas |

> **⚠ Convención sin respaldo formal:** esos dos umbrales (90 h y 15 h) son de presentación, no una meta de servicio acordada. No corresponden a ningún SLA documentado. Si el equipo tiene un objetivo real de tiempo de cierre, deberían reemplazarse por ese número.

**Las tres salvedades de la fila "Sin país":**

1. Cerca del **90% de los tickets no tiene país registrado**, así que todo este corte representa solo al 10% restante. Es una limitación del dato de origen, no del tablero.
2. La columna "Cierre prom." de esa fila muestra el **promedio global**, no el de los tickets sin país. Metabase sí devuelve ese valor propio, pero el tablero lo descarta. **Es un error conocido y pendiente de corregir** (en la versión anterior del tablero ese número era 39,5 h contra 47,2 h del promedio general).
3. Sus tickets se calculan **restando entre dos fuentes distintas**: volumen de HubSpot menos la suma de tickets con país de Metabase. Se hace así para que los porcentajes sumen 100, pero arrastra cualquier diferencia de población entre las dos fuentes.

---

# 6. Cómo verificar cualquier número

1. **Los de HubSpot** se reproducen con una búsqueda de tickets aplicando los filtros de la fórmula correspondiente.
2. **Los de Metabase** se reproducen con una pregunta sobre `bi_ce_interactions` con los mismos filtros y agrupaciones.
3. **El endpoint `/api/diagnostico`** del tablero muestra los conteos crudos de HubSpot en vivo, sin transformación — útil para comparar contra lo que se ve en pantalla.
4. **El endpoint `/api/metrics?desde=…&hasta=…`** devuelve el JSON completo con todos los valores del período, incluida la estructura interna de cada indicador.

# 7. Pendientes abiertos

| # | Pendiente | Bloquea |
|---|---|---|
| 1 | Acceso a la API de Metabase (error de autenticación) | Que 4 de los indicadores respondan al filtro de fechas |
| 2 | Lista de los 18 pipelines de soporte | Cerrar la salvedad del denominador del Reopen |
| 3 | Reconstruir el FCR con la lógica de "un mensaje del agente" | Que el FCR sea confiable |
| 4 | Corregir el promedio de cierre de la fila "Sin país" | Precisión de la tabla de países |
| 5 | Confirmar los umbrales del semáforo (90 h / 15 h) | Que el color refleje una meta real |
| 6 | Confirmar el criterio de "semana incompleta" (40%) | Que el gris del gráfico siga una regla acordada |
| 7 | Revertir la fecha fija del encabezado | Que la fecha mostrada sea la real del dato |

Detalle técnico complementario en `INSTRUCTIVO.md` — secciones 5, 8 y 9.
