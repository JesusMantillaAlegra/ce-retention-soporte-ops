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
