# Métricas sacadas en vivo por HubSpot MCP

Registro acumulativo, sin deduplicar — cada corte queda con su fecha/hora de consulta y el rango usado. Fuente: HubSpot MCP (`query_crm_data`), objeto TICKET, con el filtro común de pipelines de soporte (18 nombres + 2 IDs "alguna vez ha sido", ver `MAPEO_CAMPOS_TABLA.md`).

---

## Corte 1 — 27-ago-2026, rango 2026-01-01 a 2026-08-27 (año actual a la fecha)

| Métrica | Valor |
|---|---|
| Volumen de tickets | 45.240 |
| Reaperturas (reopen) | 1.438 → **3,18%** |
| Cerrados | 43.406 |
| Cerrados que reabrieron | 1.391 |
| FCR (cerrados − cerrados reabiertos) | 42.015 → **96,8%** |
| Tiempo de cierre promedio (excl. reabiertos) | 775.842.724,50 ms → 215,51 h → **≈ 8,98 días** |
| CSAT — Promoter | 2.054 |
| CSAT — Passive | 100 |
| CSAT — Detractor | 302 |
| CSAT total respuestas | 2.456 |
| CSAT % (Promoter/total) | **83,63%** — coincide exacto con el panel oficial "Satisfacción" de HubSpot |

### Distribución por "versión" (`version` / HD - Versión) — hallazgo: en realidad es país

| Valor | Tickets |
|---|---|
| Colombia (colombia) | 25.012 |
| República Dominicana (republicaDominicana) | 6.784 |
| México (mexico) | 4.364 |
| Costa Rica (costaRica) | 2.845 |
| Panamá (panama) | 1.834 |
| Argentina (argentina) | 1.333 |
| Perú (peru) | 1.055 |
| Unassigned | 1.006 |
| España (spain) | 776 |
| Otro (other) | 261 |
| Estados Unidos (usa) | 92 |
| Chile (chile) | 39 |
| Venezuela (venezuela) | 12 |

**Nota:** la propiedad `version` no contiene versiones de producto sino nombres de país. Esto contradice la premisa original de "no hay ninguna propiedad de país confiable en HubSpot" que llevó a eliminar el corte por país del tablero — de hecho sí existe, con este nombre. Pendiente de decisión: ¿mostrar este corte como "País" en el tablero en vez de (o adicional a) "Versión"?

**Propiedades reales usadas en este corte** (corregidas 27-ago-2026 vía HubSpot MCP, después de que el código tenía nombres equivocados):
- Pipeline: `hs_pipeline` (no `pipeline`) — valores son IDs numéricos, no nombres.
- CSAT: `clasificacion_encuesta_ces_csat` (valores en inglés: Promoter/Passive/Detractor).
- Fecha última encuesta CSAT: `fecha_de_la_ultima_encuestra_ces_csat` (no `fecha_ultima_encuesta_csat`).
- "Versión"/país: `version` (no `hd_version`).

---

## Corte 2 — 27-ago-2026, desglose mes por mes (2026-01-01 a 2026-08-27)

Motivo: el filtro de período del tablero ahora permite elegir un solo mes o un rango de meses (ver `index.html`, selector "Entre dos meses…"); con un solo total para todo el corte, cualquier mes mostraba siempre el mismo número. Este corte trae cada métrica agrupada por mes para que el hardcode temporal (`HARDCODE_TEMPORAL` en `lib/metrics.mjs`) sume solo los meses que caen en el rango pedido.

**OJO con los dos ejes de tiempo distintos:**
- Volumen, reopen, cerrados, cerrados-reabiertos y tiempo de cierre están agrupados por `createdate` (cuándo se **creó** el ticket).
- CSAT está agrupado por `fecha_de_la_ultima_encuestra_ces_csat` (cuándo se **contestó** la encuesta) — un ticket creado en julio puede aparecer en el corte de agosto si la encuesta se respondió ese mes. Por eso los totales de CSAT no coinciden mes a mes con los de volumen/cerrados.

| Mes | Volumen (creados) | Cerrados | Reopen | Cerrados reabiertos | Tiempo cierre prom. (ms) | Tiempo cierre prom. (h) |
|---|---|---|---|---|---|---|
| Ene 2026 | 5.954 | 5.933 | 226 | 226 | 913.864.945,76 | 253,9 |
| Feb 2026 | 5.280 | 5.240 | 178 | 173 | 887.995.754,46 | 246,7 |
| Mar 2026 | 6.468 | 6.427 | 240 | 238 | 888.700.709,29 | 246,9 |
| Abr 2026 | 6.230 | 6.172 | 253 | 249 | 781.313.608,98 | 217,0 |
| May 2026 | 6.022 | 5.957 | 183 | 180 | 784.777.405,29 | 217,99 |
| Jun 2026 | 5.339 | 5.239 | 182 | 171 | 719.023.582,62 | 199,73 |
| Jul 2026 | 5.563 | 5.396 | 144 | 132 | 605.121.294,82 | 168,09 |
| Ago 2026 (parcial, hasta 27-ago) | 4.566 | 3.056 | 32 | 23 | 460.964.709,37 | 128,05 |

Suma de reopen (1.438), cerrados-reabiertos (1.392 ≈ 1.391) y CSAT Passive (100, exacto) y Detractor (302, exacto) coinciden con el Corte 1 — valida el desglose.

| Mes (por fecha de encuesta contestada) | CSAT Promoter | CSAT Passive | CSAT Detractor |
|---|---|---|---|
| Ene 2026 | 265 | 13 | 53 |
| Feb 2026 | 258 | 15 | 39 |
| Mar 2026 | 266 | 22 | 49 |
| Abr 2026 | 283 | 16 | 40 |
| May 2026 | 282 | 6 | 30 |
| Jun 2026 | 260 | 8 | 37 |
| Jul 2026 | 240 | 12 | 39 |
| Ago 2026 (parcial) | 202 | 8 | 15 |

**Pendiente:** la distribución por país/versión no se sacó por mes (implicaría 13 países × 8 meses de consultas adicionales) — la tabla de país en el tablero sigue mostrando el total agregado del corte completo sin importar el mes/rango elegido en el filtro.
