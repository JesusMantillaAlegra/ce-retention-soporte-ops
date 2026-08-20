# Instructivo — Dashboard Soporte (CE-Retention)

Este documento explica de dónde sale cada métrica del dashboard `index.html`, cómo se transforma, y cómo actualizarlo. Sigue el mismo patrón que `CE-luciaBot` (ver ese `INSTRUCTIVO.md` como referencia general del mecanismo).

## 1. Cómo funciona el dashboard

`index.html` no trae datos "quemados": cuando abre, lee los datos y con eso pinta los KPIs, gráficos y tabla. **El HTML nunca se toca** — solo se regeneran los archivos de datos.

```
index.html                          → la interfaz (no cambia salvo que se rediseñe)
ce_retention_dashboard_data.js      → los datos que realmente carga el navegador (window.CE_RETENTION_DATA = {...})
ce_retention_dashboard_data.json    → los mismos datos en JSON plano (para el script de sync, no lo lee el navegador directo)
sync_hubspot.mjs                    → script que llama a HubSpot y regenera los dos archivos de datos de arriba
```

**¿Por qué dos archivos de datos?** Este dashboard se abre con doble clic desde el explorador de Windows (`file:///C:/Users/...`), y Chrome bloquea por seguridad que una página local (`file://`) haga `fetch()` de otro archivo local — falla en silencio, sin ningún error visible, y la página se queda cargando para siempre. Por eso `index.html` carga `ce_retention_dashboard_data.js` con una etiqueta `<script src="...">` (eso sí funciona desde `file://`), y ese archivo simplemente asigna el mismo contenido a `window.CE_RETENTION_DATA`. `ce_retention_dashboard_data.json` es el formato "limpio" que edita `sync_hubspot.mjs`; al final del proceso ese JSON se envuelve en `window.CE_RETENTION_DATA = <json>;` para producir el `.js`.

## 2. Qué se sincroniza vía API y qué se queda manual

Decisión explícita (20-ago-2026): **lo que sale de HubSpot se sincroniza vía API. Lo que sale de Metabase, no.**

| Métrica | Fuente | ¿Se sincroniza? | Cómo |
|---|---|---|---|
| Volumen de tickets | HubSpot (`tickets`) | Sí | `sync_hubspot.mjs` — Search API, filtro por `createdate` |
| Reopen rate | HubSpot (`hs_ticket_reopened_at`) | Sí | `sync_hubspot.mjs` |
| FCR (proxy) | HubSpot (`hs_num_times_contacted=1` sobre cerrados) | Sí | `sync_hubspot.mjs` |
| Tickets por país | HubSpot (property de país) | Sí | `sync_hubspot.mjs` |
| Tiempo de cierre promedio | Metabase (`bi_ce_interactions`) | No | Manual — ver sección 4 |
| CSAT | Metabase (`bi_ce_interactions`) | No | Manual |
| Horas de cierre por país | Metabase (`bi_ce_interactions`) | No | Manual |
| Tendencia semanal (volumen + horas de cierre) | Metabase | No | Manual |

`sync_hubspot.mjs` solo toca los campos marcados "Sí" — preserva intactos los campos de Metabase que ya estén en el JSON.

## 3. Cómo correr la sincronización con HubSpot

```
HUBSPOT_TOKEN=pat-... node sync_hubspot.mjs
```

El token es un Private App de HubSpot (Settings → Integrations → Private Apps) con scope de lectura `crm.objects.tickets.read`. **Nunca hardcodear el token en el script** — pasarlo como variable de entorno.

El script hace una serie de llamadas a la Search API de HubSpot pidiendo solo el conteo total (`total`) de cada búsqueda — no descarga los 100k+ tickets uno por uno, así que es rápido incluso con este volumen.

Antes de sobrescribir el JSON, valida que el volumen esté en un rango razonable (por si la API cambió o un filtro dejó de aplicar bien) — si algo se ve raro, avisa y no toca los archivos.

## 4. Cómo actualizar la parte de Metabase manualmente

1. Correr de nuevo la consulta en Metabase sobre `bi_ce_interactions` (tiempo de cierre, CSAT, horas de cierre por país, tendencia semanal).
2. Editar `ce_retention_dashboard_data.json` con los valores nuevos, manteniendo la misma estructura de campos (los objetos con `"fuente": "metabase"`).
3. Copiar ese mismo contenido dentro de `ce_retention_dashboard_data.js`, reemplazando lo que está después de `window.CE_RETENTION_DATA = ` (o pedirle a Claude que lo regenere a partir del JSON — es una envoltura trivial, igual que en Lucía).
4. Guardar y abrir `index.html` con doble clic — el dashboard recarga automáticamente los datos nuevos.

## 5. Pendientes antes de confiar en los números en vivo de HubSpot

Estos son placeholders en `sync_hubspot.mjs` que dependen de configuración específica de este portal de HubSpot y que no quedaron registrados en el cálculo original del dashboard (mismo problema que documentó el instructivo de Lucía: "antes de escribir el script de automatización, pedirle a quien construyó estos reportes el filtro exacto"):

1. **Exclusión de rebotes de mailer-daemon** (caso REVOPS-1324, ~7,900 tickets): no está replicada todavía — falta saber con qué property/valor se identificaban en la consulta original.
2. **Definición de "cerrado"** para el denominador de FCR: el filtro actual (`hs_pipeline_stage HAS_PROPERTY`) es demasiado amplio — probablemente cuenta tickets abiertos también. Falta el/los stage IDs reales de "Closed" en el pipeline de tickets.
3. **Property de país**: `COUNTRY_PROPERTY = 'country'` es una suposición — confirmar el nombre real en este portal.

Sin resolver esto, los números en vivo pueden no calzar exactamente con el snapshot original (102,855 / 2.53% / 39.4%).

## 6. Automatización (próximo paso, no implementado)

Igual que en Lucía: la idea es que `sync_hubspot.mjs` corra solo, con alguna periodicidad, sin depender de que alguien tenga una sesión abierta. Opciones:
- Un cron real en un servidor/máquina de Alegra.
- Una tarea programada de Claude que llame a los conectores de HubSpot ya disponibles y escriba los archivos de datos en esta misma carpeta.

Por ahora se corre a mano cuando se necesite un refresh.
