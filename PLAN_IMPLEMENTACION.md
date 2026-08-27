# Plan de implementación — Ajuste del tablero al nuevo mapeo

Base: `MAPEO_CAMPOS_TABLA.md`. Objetivo: año actual como período por defecto, año anterior disponible y precargado, y que cualquier cambio de fecha actualice todos los KPIs/gráficos/tablas sin botón "Aplicar".

---

## 1. Por qué no se puede calcular todo en vivo (y qué cambia por eso)

HubSpot no agrupa/suma en el servidor como Metabase — no hay `GROUP BY` nativo en su API de búsqueda. Para sacar tendencia semanal o distribución por versión hay que traer los tickets uno por uno (100 por página) y sumar en código. Con ~45.000 tickets al año, eso son cientos de llamadas — nada que se pueda repetir cada vez que alguien mueve el selector de fecha sin botón, porque tardaría segundos y golpearía los límites de la API de HubSpot.

**Solución: precalcular por semana, no en vivo.** En vez de que `/api/metrics` le pregunte a HubSpot en cada carga, se arma un histórico de "cubos" semanales (volumen, reaperturas, cerrados, cerrados-sin-reopen, suma de tiempos de cierre, CSAT, conteos por versión) guardado en el almacenamiento (KV). Cuando alguien cambia el rango de fechas, el tablero solo suma los cubos de las semanas que caen en ese rango — es aritmética en memoria, no una consulta nueva a HubSpot. Así el filtro puede reaccionar al instante, sin "Aplicar".

---

## 2. Cambios en las consultas a HubSpot (`lib/hubspot.mjs`)

- Reemplazar la lista de pipelines actual por los 18 confirmados en el panel oficial, más la condición `OR pipeline_ever_in IN (2302067, 1857375)`.
- Agregar la exclusión `hubspot_owner_id != owner_lucia` a todas las consultas (volumen, reopen, FCR, tiempo de cierre, CSAT, versión, tendencia).
- Tiempo de cierre: dejar de usarlo de Metabase. Se calcula con `createdate`/`closed_date` propios de HubSpot, excluyendo tickets con `reopen__retroactivo_tema_diferente` o `ticket_reabierto__wf` poblados.
- FCR: cambiar la fórmula actual (`hs_num_times_contacted`) por la nueva definición — cerrados sobre total de cerrados, excluyendo solo los que tengan alguna de las dos propiedades de reopen marcada como `'Nueva consulta'`. **Ojo (corrección de Estefanía):** la condición no es que las propiedades estén vacías — un ticket con `'Cierre agradecimiento'` o `'Ambiguo'` sigue contando como resuelto en primer contacto. Solo `'Nueva consulta'` lo excluye.
- CSAT: mover de Metabase a HubSpot. Antes de programar esto, un paso técnico obligatorio es entrar a la configuración del reporte "Satisfacción" en HubSpot y copiar el **nombre interno** (internal name) de la propiedad de CSAT — el nombre visible ("Clasificación Encuesta CES-CSAT") no sirve para la API, se necesita el slug técnico. Se filtra por `csat_property IS NOT NULL` y `fecha_ultima_encuesta_csat` dentro del rango.
- Distribución por versión: nueva consulta agrupando por `hd_version` (ya no `country`, ya no Metabase).

## 3. Retirar Metabase del todo

Con tiempo de cierre, CSAT y versión movidos a HubSpot, ya no queda ningún indicador que dependa de Metabase. Se puede:
- Eliminar `lib/metabase.mjs` y las variables de entorno `METABASE_*` de Vercel.
- Simplifica también `lib/metrics.mjs`: ya no hace falta el `Promise.all` con manejo de fallo de Metabase ni el respaldo con el último snapshot — todo sale de una sola fuente.

## 4. Cubos semanales y almacenamiento histórico (`lib/store.mjs`, nuevo `lib/buckets.mjs`)

- Nuevo job de backfill (una sola vez, manual): recorre HubSpot paginado para **el año actual completo y el año anterior completo**, con todos los filtros ya mencionados, y arma un cubo por semana con: volumen, reaperturas, cerrados, cerrados-sin-reopen, suma de `(closed_date - createdate)` en segundos + conteo (para el promedio), suma de CSAT + conteo, conteo por `hd_version`.
- Esos cubos se guardan en KV, uno por semana (`bucket:2025-W01`, `bucket:2026-W33`, etc.), o un blob por año para simplificar.
- El cron semanal (`/api/snapshot`, ya existe) se actualiza para recalcular solo el cubo de la semana en curso (y la anterior, por si llegaron cierres tardíos) — ya no arma un "snapshot acumulado", arma o reemplaza cubos semanales.

## 5. `/api/metrics` — de consulta en vivo a suma de cubos

- Recibe `desde`/`hasta` como hoy.
- En vez de llamar a HubSpot/Metabase, lee los cubos de KV que caen en ese rango y sea cual sea el rango (año actual, año anterior, un mes suelto, lo que pidan), simplemente suma los campos numéricos de los cubos correspondientes y recalcula los porcentajes finales (reopen %, FCR %, CSAT %) sobre esas sumas.
- Por defecto (sin `desde`/`hasta` en la URL): rango = 1-ene-[año actual] hasta hoy.
- Queda mucho más rápido (suma en memoria de unas ~52-104 filas, no cientos de llamadas a HubSpot), lo que habilita el punto 6.

## 6. Eliminar el corte por país

Ninguna propiedad de HubSpot cubre país de forma confiable para todos los tickets (la property de HubSpot ya se probó y no cuadraba; solo 3 de los 18 pipelines traen el país en el nombre). Con la regla de "todo lo que no esté en HS se elimina": se quita del `index.html` el gráfico "Horas promedio hasta cierre" por país y la tabla "Detalle por país" completa (incluida la fila "Sin país" y el semáforo de esa columna), junto con el código que los alimenta en `lib/metrics.mjs` (`filasPais`, `por_pais_tickets`, `por_pais_horas`). Queda "Distribución por versión" (`hd_version`) como el único corte de segmentación restante — es un indicador nuevo, no un reemplazo 1:1 de país.

## 7. Frontend (`index.html`) — quitar "Aplicar", reaccionar al cambio

- Quitar el botón `btnAplicarFiltro` y su listener.
- Los dos `<input type="date">` (Desde/Hasta) llaman `cargar(desde, hasta)` directamente en su evento `change` (con un pequeño debounce, ~300ms, para no disparar la consulta mientras el usuario todavía está escribiendo/seleccionando en el date picker).
- Valor por defecto al cargar la página: Desde = 1-ene-[año actual], Hasta = hoy (ya no hace falta pedirle nada a nadie, sale del mismo cálculo del backend).
- Para que el año anterior esté "poblado" y disponible de inmediato (no que se calcule la primera vez que alguien lo pide), el backfill del punto 4 ya lo deja listo desde el día 1 — seleccionar el año pasado en el filtro de fecha es tan inmediato como el año actual, porque ambos ya están en KV como cubos.

## 8. Pruebas antes de publicar

Con Playwright + mocks (como se ha hecho en todo este proyecto):
- Validar que la condición `OR pipeline_ever_in IN (...)` no duplique tickets al combinarla con el `IN` de pipelines por nombre.
- Validar que la exclusión de Lucía no rompe el conteo cuando `owner_lucia` no está seteado (debe degradar a "no excluir nada", no a error).
- Validar la suma de cubos contra un cálculo directo en HubSpot para un rango de prueba, para confirmar que sumar cubos da el mismo resultado que consultar en vivo.
- Validar que cambiar de año en el frontend no dispara ninguna llamada a HubSpot (todo debe salir de KV).

## 9. Orden de trabajo sugerido

1. Confirmar el nombre técnico de la propiedad de CSAT en HubSpot (bloqueante para el punto 2).
2. Reescribir `lib/hubspot.mjs` con los filtros y fórmulas nuevas.
3. Construir `lib/buckets.mjs` y el script de backfill; correrlo para año actual + año anterior.
4. Reescribir `/api/metrics` para sumar cubos en vez de consultar en vivo.
5. Actualizar `/api/snapshot`/cron para mantener los cubos de la semana en curso.
6. Quitar Metabase del código y de las variables de entorno.
7. Quitar del `index.html` el gráfico y la tabla de país.
8. Ajustar `index.html`: quitar Aplicar, reactividad por `change` con debounce, valores por defecto.
9. Probar todo con mocks antes de desplegar.
