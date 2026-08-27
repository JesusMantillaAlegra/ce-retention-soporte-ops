# Documentación de métricas — Tablero de Soporte (CE-Retention)

## Filtro común a todas las métricas

Se aplica siempre, salvo que la columna "Filtros" de una métrica indique lo contrario:

```
(pipeline IN (lista_pipelines_soporte)
  -- MEX_Sup, Acrecer_Sup, COL_Sup, Premium Sup (No transferir), Nómina_Sup,
  -- Alianza de Pagos y Fintech, Dentalink, DOM_Sup, Payments Sup, POS_Sup,
  -- Innpulsa_Sup, Consultas API_Sup, Solicitudes Partners_Sup, Customer support,
  -- Contador Sup, Plan Fundaciones y Educación, Alegra Tienda_Sup, Integraciones_Sup
 OR pipeline_ever_in IN (2302067, 1857375))   -- del panel oficial de HubSpot, se toma tal cual
AND createdate >= 1-ene-[año actual]          -- dinámico, permite consultar histórico
AND hubspot_owner_id != owner_lucia            -- excluye la gestión de la asistente automatizada
```

---

## Métricas

| Métrica | Propiedad(es) de HubSpot | Filtros específicos |
|---|---|---|
| Volumen de tickets | `createdate` | Ninguno adicional |
| Tiempo de cierre promedio (8,9 días) | `createdate`, `closed_date`, `reopen__retroactivo_tema_diferente`, `ticket_reabierto__wf` | Excluir tickets con cualquiera de las dos propiedades de reopen pobladas |
| Tasa de reapertura — 3,3% (1.510 / 45.321) | `reopen__retroactivo_tema_diferente`, `ticket_reabierto__wf` | `reopen__retroactivo_tema_diferente = 'Nueva consulta' OR ticket_reabierto__wf = 'Nueva consulta'` |
| Resolución en primer contacto (FCR) | `closed_date`, `reopen__retroactivo_tema_diferente`, `ticket_reabierto__wf` | Numerador: `closed_date HAS_PROPERTY` + ninguna de las dos propiedades de reopen marcada como `'Nueva consulta'` (no es lo mismo que "vacías": un ticket puede tener la propiedad poblada con `'Cierre agradecimiento'` o `'Ambiguo'` y sigue contando como resuelto en primer contacto). Denominador: `closed_date HAS_PROPERTY` |
| Satisfacción (CSAT) — ~83-84% (varía según el momento de consulta) | `csat_property`, `fecha_ultima_encuesta_csat` | `csat_property IS NOT NULL` + `fecha_ultima_encuesta_csat >= 1-ene-[año]` |
| Distribución CSAT (Detractor, Neutro, Promotor) | Misma propiedad de CSAT | Mismo filtro que CSAT — gráfico aparte, no alimenta el KPI principal. Barras **verticales**, eje X en este orden fijo: **Detractor, Neutro, Promotor** |
| Distribución por versión | `hd_version` | Ninguno adicional |
| Tendencia semanal | `createdate`, `closed_date` | Ninguno adicional |

---

## SQL y fórmula por métrica

### Volumen de tickets
```sql
SELECT COUNT(*) AS volumen
FROM tickets
WHERE pipeline IN (lista_pipelines_soporte)
  AND createdate >= 1-ene-[año];
```
`Volumen = COUNT(tickets)`

### Tiempo de cierre promedio
```sql
SELECT AVG(closed_date - createdate) AS tiempo_cierre
FROM tickets
WHERE pipeline IN (lista_pipelines_soporte)
  AND createdate >= 1-ene-[año]
  AND closed_date IS NOT NULL
  AND reopen__retroactivo_tema_diferente IS NULL
  AND ticket_reabierto__wf IS NULL;
```
`Tiempo de cierre = AVG(closed_date − createdate)`

### Tasa de reapertura (Reopen)
```sql
SELECT
  COUNT(*) FILTER (
    WHERE reopen__retroactivo_tema_diferente = 'Nueva consulta'
       OR ticket_reabierto__wf = 'Nueva consulta'
  ) AS reaperturas,
  COUNT(*) AS volumen
FROM tickets
WHERE pipeline IN (lista_pipelines_soporte)
  AND createdate >= 1-ene-[año];
```
`Reopen (%) = (reaperturas ÷ Volumen) × 100`

### Resolución en primer contacto (FCR)
Corrección de Estefanía: la condición NO es que las propiedades estén vacías — es que ninguna diga `'Nueva consulta'`. Un ticket con la propiedad poblada como `'Cierre agradecimiento'` o `'Ambiguo'` sigue siendo un ticket resuelto en primer contacto; solo `'Nueva consulta'` lo saca del numerador (es el mismo criterio que ya se usa para contar reaperturas).
```sql
SELECT
  COUNT(*) FILTER (
    WHERE closed_date IS NOT NULL
      AND COALESCE(reopen__retroactivo_tema_diferente, '') != 'Nueva consulta'
      AND COALESCE(ticket_reabierto__wf, '') != 'Nueva consulta'
  ) AS resueltos_1er_contacto,
  COUNT(*) FILTER (WHERE closed_date IS NOT NULL) AS total_cerrados
FROM tickets
WHERE pipeline IN (lista_pipelines_soporte)
  AND createdate >= 1-ene-[año];
```
`FCR (%) = (resueltos_1er_contacto ÷ total_cerrados) × 100`

### Satisfacción (CSAT)
Propiedad de HubSpot: **`clasificacion_encuesta_ces_csat`** (nombre interno confirmado en Configuración → Propiedades → Tickets, 27-ago-2026). Los valores que guarda esta propiedad están en inglés: `Promoter`, `Passive`, `Detractor`.
```sql
SELECT AVG(csat_property) AS csat_pct
FROM tickets
WHERE pipeline IN (lista_pipelines_soporte)
  AND csat_property IS NOT NULL
  AND fecha_ultima_encuesta_csat >= 1-ene-[año];
```
`CSAT (%) = Promoter ÷ (Promoter + Passive + Detractor) × 100`

### Distribución CSAT
Gráfico de barras **verticales**. El eje X siempre en este orden fijo, de izquierda a derecha: **Detractor, Neutro (Passive), Promotor** (no alfabético, no por tamaño de barra). Las etiquetas del eje se muestran en español; el valor almacenado en HubSpot es el inglés (`Detractor`, `Passive`, `Promoter`).
```sql
SELECT csat_classification, COUNT(*) AS total
FROM tickets
WHERE pipeline IN (lista_pipelines_soporte)
  AND csat_property IS NOT NULL
  AND fecha_ultima_encuesta_csat >= 1-ene-[año]
GROUP BY csat_classification
ORDER BY CASE csat_classification
  WHEN 'Detractor' THEN 1
  WHEN 'Passive' THEN 2
  WHEN 'Promoter' THEN 3
END;
```
`% categoría = COUNT(categoría) ÷ COUNT(total respuestas) × 100`

### Distribución por versión
```sql
SELECT hd_version AS version, COUNT(*) AS tickets,
  AVG(closed_date - createdate) AS cierre_promedio
FROM tickets
WHERE pipeline IN (lista_pipelines_soporte)
  AND createdate >= 1-ene-[año]
GROUP BY hd_version;
```
`Tickets(versión) = COUNT(tickets WHERE hd_version = v)`

### Tendencia semanal
```sql
SELECT DATE_TRUNC('week', createdate) AS semana,
  COUNT(*) AS volumen,
  AVG(closed_date - createdate) AS cierre_promedio
FROM tickets
WHERE pipeline IN (lista_pipelines_soporte)
  AND createdate >= 1-ene-[año]
GROUP BY 1 ORDER BY 1;
```
`Volumen(semana) = COUNT(tickets)` — `Cierre(semana) = AVG(closed_date − createdate)`

---

## Notas de construcción

- Tiempo de cierre: fuente única HubSpot (`createdate`/`closed_date`), ya no Metabase.
- CSAT: se calcula sobre encuestas con clasificación conocida ("CSAT es conocido"), filtrado por fecha de la encuesta.
- Distribución por versión: fuente `hd_version` a nivel de ticket.
