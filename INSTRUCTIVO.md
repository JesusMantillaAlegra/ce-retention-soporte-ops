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

Decisión actualizada (21-ago-2026): **ya no hay nada manual — HubSpot y Metabase se sincronizan automáticamente**, cada uno con su propio script, ver sección 8.

| Métrica | Fuente | ¿Se sincroniza? | Cómo |
|---|---|---|---|
| Volumen de tickets | HubSpot (`tickets`) | Sí | `sync_hubspot.mjs` — Search API, filtro por `createdate` |
| Reopen rate | HubSpot (`hs_ticket_reopened_at`) | Sí | `sync_hubspot.mjs` |
| FCR (proxy) | HubSpot (`hs_num_times_contacted=1` sobre cerrados) | Sí | `sync_hubspot.mjs` |
| Tiempo de cierre promedio | Metabase (`bi_ce_interactions`) | Sí | `merge_metabase.mjs`, alimentado por consultas MBQL vía Claude (ver sección 8) |
| CSAT | Metabase (`bi_ce_interactions`) | Sí | `merge_metabase.mjs` |
| Tickets y horas de cierre por país | Metabase (`bi_ce_interactions.country`) | Sí | `merge_metabase.mjs` — se movió aquí desde HubSpot el 21-ago-2026 porque `country_form` de HubSpot no calzaba bien (ver sección 5) |
| Tendencia semanal (volumen + horas de cierre) | Metabase (`bi_ce_interactions`) | Sí (desde 21-ago-2026) | `merge_metabase.mjs`, alimentado por una 4ª consulta MBQL (ver sección 8.2) — era el último campo manual |

`sync_hubspot.mjs` solo toca volumen/reopen/FCR. `merge_metabase.mjs` solo toca tiempo de cierre/CSAT/país. `append_history.mjs` corre al final y guarda el resultado combinado como snapshot nuevo — ver secciones 7 y 8.

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

### Resuelto

1. **Exclusión de rebotes de mailer-daemon** (caso REVOPS-1324) — CONFIRMADO 20-ago-2026. `mailer-daemon@amazonses.com` es el remitente automático de notificaciones de rebote de Amazon SES (el servicio de correo que usa el sistema de facturación electrónica de Alegra) — no es un cliente ni un caso de soporte real. Ese tráfico entraba como tickets normales al pipeline, inflando volumen/reopen/FCR con picos de miles de tickets de un día a otro. Filtro implementado en `sync_hubspot.mjs`: coincidencia **exacta** (`NEQ`) sobre `hs_all_associated_contact_emails` = `mailer-daemon@amazonses.com`. A propósito no se usa `CONTAINS_TOKEN` — esa comparación fragmenta el email por los puntos y genera conteos inflados/falsos positivos. Aplica antes de calcular volumen, reopen, FCR y tiempo de cierre.
2. **Definición de "cerrado"** para el denominador de FCR — CONFIRMADO 21-ago-2026: `closed_date HAS_PROPERTY` (tickets con fecha de cierre poblada). Reemplaza el placeholder anterior (`hs_pipeline_stage HAS_PROPERTY`), que era demasiado amplio. Implementado en `sync_hubspot.mjs` (`CLOSED_FILTER`). Validado contra el snapshot original (99,096 vs. 98,378 esperado).
3. **Property de país en HubSpot**: quedó descartada — ver sección 2, ahora país sale de Metabase (`bi_ce_interactions.country`), que calzó mucho mejor que la property de HubSpot.
4. **FCR como métrica oficial** — CONFIRMADO 21-ago-2026 con Agustín: el proxy (`hs_num_times_contacted = 1` sobre tickets cerrados) queda adoptado como la definición del KPI mientras se reactiva `hs_is_one_touch_ticket` (el campo nativo, que sigue sin poblarse desde mayo).

No quedan pendientes abiertos sobre la definición de los números — todos ya están validados y confirmados.

## 6. Automatización (implementada 21-ago-2026)

Ya no es manual. Arquitectura final:

1. **Cada miércoles 8:30 AM (hora Bogotá)** una tarea programada de Claude (trigger `trig_01Y4CFewYtSfxNMpQodpsMYe`) corre sola, sin que nadie tenga que abrir una sesión: llama a HubSpot (vía `sync_hubspot.mjs`) y a Metabase (vía las consultas MBQL de la sección 8), fusiona todo con `merge_metabase.mjs`, guarda el snapshot con `append_history.mjs`, y escribe los 4 archivos de datos resultantes de vuelta en esta carpeta (vía el puente al equipo — requiere que la app de escritorio de Claude esté abierta en ese momento; si no lo está, esa semana no corre y hay que lanzarla a mano después).
2. **Unos minutos después (sugerido 8:45 AM)**, `push_dashboard.bat` — registrado en el Programador de tareas de Windows por el usuario — hace `git add` / `git commit` / `git push` de lo que haya cambiado. Así el push no depende de que la sesión de Claude siga abierta ni de que el equipo del usuario esté encendido exactamente a las 8:30.
3. Índice/`.gitignore` sin cambios — el histórico (`ce_retention_dashboard_history.json/.js`) también se versiona en git, así que cada push deja el histórico completo respaldado en GitHub.

Ver sección 8 para el detalle exacto de qué hace cada script y las 3 consultas MBQL, y el mensaje final de esta conversación para el comando de registro de `push_dashboard.bat` en el Programador de tareas.

## 7. Histórico — cómo se acumulan los snapshots (20-ago-2026)

**Importante:** ya no se pisa solo la foto actual. Cada corrida completa (`sync_hubspot.mjs` → `merge_metabase.mjs` → `append_history.mjs`) agrega un snapshot nuevo a `ce_retention_dashboard_history.json` (y su `.js` gemelo) — los snapshots anteriores nunca se borran. Esto es a propósito: la idea es poder comparar un período contra otro más adelante (ej. "¿cómo estuvo Soporte en agosto vs. septiembre?"), no solo ver la última foto.

```
ce_retention_dashboard_history.json   → array de snapshots, uno por corrida (nunca se pisan)
ce_retention_dashboard_history.js     → misma info envuelta en window.CE_RETENTION_HISTORY
```

Cada snapshot tiene:
- `snapshot_id`: fecha de la corrida en formato `YYYY-MM-DD` (hora Bogotá). Si corres el sync más de una vez el mismo día, esa corrida **reemplaza** la entrada de hoy (no genera duplicados) — pero cualquier día anterior queda intacto.
- `capturado_en`: timestamp ISO exacto de cuándo se corrió.
- El resto: mismo shape que `ce_retention_dashboard_data.json` (meta/kpis/tendencia_semanal/por_pais) tal como quedó esa corrida.

`index.html` carga el histórico junto con la foto actual y arma una barra de selección arriba de los KPIs (**Ver periodo** / **Comparar con otro periodo**, agrupados por mes) — al cambiar de periodo, el dashboard completo (KPIs, gráficos, tabla) se vuelve a dibujar con los datos de ese snapshot, sin tocar `index.html`. Si se activa "Comparar con otro periodo", cada tarjeta de KPI muestra además una flecha con la diferencia contra el periodo elegido para comparar (↑/↓/→, en verde si mejoró, rojo si empeoró, gris si es solo informativo — ej. volumen).

**Importante sobre "comparar" en este dashboard en particular:** cada snapshot de `ce_retention_dashboard_history.json` es una **foto acumulada** desde el inicio del período (no una semana suelta) — así que comparar dos periodos compara dos fotos en el tiempo (¿el promedio/tasa mejoró o empeoró entre una fecha y otra?), NO suma actividad semana por semana. Esto es distinto al mecanismo de `CE-luciaBot` (ver abajo), donde cada snapshot sí es una semana independiente y por eso ahí se pueden sumar rangos de semanas.

**Cadencia esperada:** correr el pipeline semanalmente (ya automatizado, sección 6) para que el histórico se vaya construyendo de forma consistente — entre más regular la cadencia, más útil la comparación mes a mes.

**Ya implementado (21-ago-2026):**
- Selector de periodo con comparación de dos snapshots (ver arriba) — cubre el caso de uso principal ("¿cómo estuvo agosto vs. septiembre?").
- `CE-luciaBot` ya tiene su propio mecanismo de histórico (`lucia_dashboard_history.json`), con snapshots semanales reales que sí se pueden sumar en un rango libre (Desde/Hasta + botones por mes + comparación) — ver su propio `INSTRUCTIVO.md`.

**Qué podría faltar más adelante:**
- Si se necesita comparar un *rango* de varias semanas seguidas (no solo dos fotos puntuales) en este dashboard, habría que rediseñar `sync_hubspot.mjs`/`merge_metabase.mjs` para capturar deltas semanales en vez de acumulados — cambio más grande, no trivial.

## 8. Pipeline semanal completo — scripts y consultas MBQL exactas (21-ago-2026)

### 8.1 Orden de ejecución

```
1. HUBSPOT_TOKEN=pat-... node sync_hubspot.mjs
   → actualiza volumen / reopen / FCR en ce_retention_dashboard_data.json(.js)

2. (Claude corre 4 consultas MBQL contra Metabase, arma metabase_result.json — ver 8.2)

3. node merge_metabase.mjs metabase_result.json
   → fusiona tiempo de cierre / CSAT / país en el mismo data.json(.js)

4. node append_history.mjs
   → guarda el data.json ya completo (HubSpot + Metabase) como snapshot nuevo
     en ce_retention_dashboard_history.json(.js)
```

`sync_hubspot.mjs` y `merge_metabase.mjs` NUNCA tocan el histórico directamente — por diseño, para que el snapshot que se guarda siempre tenga las dos fuentes ya fusionadas, nunca solo la mitad.

### 8.2 Las 4 consultas MBQL (tabla `bi_ce_interactions`, database `Viz`, schema `dm_customer_experience`)

Todas usan el mismo rango de fechas que `sync_hubspot.mjs` (`PERIOD_START`/`PERIOD_END`, por defecto 01-may-2026 hasta hoy), filtrando por `created_at`, vía `mcp__Metabase__construct_query` / `mcp__Metabase__query` (la búsqueda nativa SQL está bloqueada por permisos — solo MBQL funciona).

**a) Tiempo de cierre promedio** — agregación `avg` de `time_to_close_seconds` (convertir a horas: `/3600`), filtrando `closed_at` no nulo (`HAS_PROPERTY`-equivalente en MBQL: `not-null`) y `created_at` en rango. También pedir el conteo (`count`) para `tickets_base`.

**b) CSAT** — `count` con `breakout` en `csat_classification` (filtrado a `created_at` en rango) → da 3 filas: Detractor / Passive / Promoter. Esos 3 números van a `metabase.csat.{detractor,passive,promoter}`.

**c) País** — dos cosas en una sola consulta o dos: (i) `count` con `breakout` en `country` → `metabase.por_pais_tickets`; (ii) `avg` de `time_to_close_seconds/3600` con `breakout` en `country` → `metabase.por_pais_horas`. Filtrar `created_at` en rango; los `NULL` de `country` (~20% de las filas) quedan fuera del breakout — `merge_metabase.mjs` calcula "Sin país" restando del volumen total de HubSpot, no hace falta pedirlo aparte.

**d) Tendencia semanal** (agregada 21-ago-2026 — antes era el único campo manual) — `count` y `avg` de `time_to_close_seconds/3600`, con `breakout` semanal sobre `created_at` (usar `["field",{"temporal-unit":"week"},[...,"created_at"]]` en vez del campo plano). Da una fila por semana con [semana, count, avg_horas]. Formatear cada semana como `DD-mmm` (ej. `26-abr`) para `metabase.tendencia_semanal.weeks`, los conteos para `.volumes`, las horas para `.close_hours`. Las últimas 1-2 semanas (con muy pocos tickets aún cerrados) van en `.censured_from_index` — ese índice pinta esas barras en gris en el dashboard para no confundir "poco volumen" con "semana floja".

Con los 4 resultados arriba se arma `metabase_result.json` con la forma documentada en la cabecera de `merge_metabase.mjs`.

### 8.3 Tarea programada de Claude

- Trigger ID: `trig_01Y4CFewYtSfxNMpQodpsMYe`, cron `30 13 * * 3` (UTC) = miércoles 8:30 AM hora Bogotá.
- Requiere el puente al equipo activo (`requires_local_device: true`) — si la app de escritorio de Claude no está abierta esa mañana, esa corrida no pasa nada; se puede lanzar a mano después (`mcp__claude-code-remote__fire_trigger`) o esperar a la siguiente semana.
- El prompt de la tarea es autocontenido (no depende de esta conversación) y cubre los 4 pasos de 8.1 más una validación de rango razonable antes de escribir, y explícitamente NO hace ningún `git` — eso lo hace `push_dashboard.bat` por separado (sección 6).

### 8.4 `push_dashboard.bat` — autenticación no interactiva

El Programador de tareas de Windows corre el `.bat` sin que haya una sesión interactiva donde `git` pueda pedir usuario/contraseña — por eso hace falta que el remoto `origin` ya tenga las credenciales guardadas de antemano (una sola vez, a mano) usando un **Personal Access Token de GitHub** (fine-grained, con permiso de escritura sobre este repo). Comando (correr una sola vez en PowerShell, dentro de la carpeta del repo):

```
git remote set-url origin https://<TU_USUARIO_GITHUB>:<TU_TOKEN>@github.com/JesusMantillaAlegra/ce-retention-soporte-ops.git
```

Esto queda guardado en `.git/config`, que es local a este equipo y no se sube a GitHub (no está en el histórico de commits ni en `.gitignore` porque `.git/` nunca se versiona a sí mismo). Después de correr esto una vez, `push_dashboard.bat` puede hacer `git push` sin pedir nada, corra quien lo corra (Task Scheduler incluido).
