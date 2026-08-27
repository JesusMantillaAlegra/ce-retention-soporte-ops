# Contexto — Dashboard "Métricas operativas de soporte"

Documento de referencia sobre cómo se construyó el dashboard, de dónde salen los datos, qué falta y qué sigue pendiente de confirmación. Última actualización: 20-ago-2026.

## 1. Origen de la tarea

Sprint CE-Retention — Data (05-ago-2026), tarea "Métricas operativas de soporte": reopen, FCR y tiempos de cierre, para complementar el tablero de CSAT/SLA/demanda que ya existía. Diseño de referencia: dashboard interno "Valentina — Alegra" (mismo sistema visual: paleta teal/dark, tipografías Inter/Lexend, Chart.js).

Tarea hermana en el mismo sprint ("Bots de Lucía — mejorar dashboards y agregar métricas") quedó fuera de este entregable: se investigó qué datos existían en Metabase para ese tablero de voz/bots y, al momento de revisar, no había información disponible para construirlo. No se construyó nada de esa parte.

## 2. Cómo me conecté (mapeo de fuentes)

| Fuente | Conector usado | Para qué |
|---|---|---|
| HubSpot CRM | MCP HubSpot (`search_crm_objects`, `get_crm_objects`, `get_properties`) sobre el objeto `tickets` (0-5) | Volumen, reopen, FCR (proxy), país, limpieza de ruido de bounces |
| Metabase (Redshift, base "Viz") | MCP Metabase (`construct_query` / `query`, solo MBQL — SQL nativo bloqueado por permisos) sobre `bi_ce_interactions` | Tiempo de cierre promedio, CSAT |

El conector de Metabase se desconectó a mitad de la construcción del dashboard y no se pudo restablecer en esa sesión. Por eso las cifras de CSAT que están en el tablero son de la primera consulta (05-ago) y no de un refresco reciente — está marcado explícitamente en el tablero.

No hubo llamadas directas a la API de HubSpot ni a Metabase fuera de estos conectores; todo se hizo vía MCP.

## 3. Qué se quería lograr

Un tablero HTML (por ahora estático, sin backend) con:
- KPIs de volumen, tiempo de cierre, reopen, FCR y CSAT.
- Gráfico de tendencia semanal (volumen + tiempo de cierre).
- Corte por país.
- Mismo lenguaje visual que "Valentina" (bordes suaves, paleta teal/dark, solo gráficos de barra — sin dona, por instrucción explícita).
- Idea a futuro (no implementada aún): que se actualice solo, una vez por semana, corriendo los MCP desde tu PC. Por ahora es una foto estática que se reconstruye a mano cuando se pide.

## 4. Cómo se calculó cada métrica

**Volumen de tickets — 102,855.** Conteo de tickets creados en el período (01-may–19-ago), objeto `tickets` de HubSpot, excluyendo ~7,900 tickets de rebote (`mailer-daemon@amazonses.com`) que se descubrieron en paralelo durante la investigación de spam/phishing (caso REVOPS-1324). Sin esa limpieza, el volumen y el reopen habrían quedado inflados artificialmente.

**Tiempo de cierre promedio — 47.2 h.** Promedio de `bi_ce_interactions` en Metabase, sobre 91,785 tickets cerrados (01-may–04-ago). Las últimas 2 semanas del gráfico semanal están censuradas (marcadas en gris) porque los tickets recién creados todavía no cierran, lo que infla artificialmente la "mejora" si no se excluyen.

**Reopen rate — 2.53%.** Campo nativo de HubSpot `hs_ticket_reopened_at` sobre el volumen ya limpio (2,598 de 102,855). Es la definición nativa de HubSpot (evento de reapertura), no una ventana de negocio tipo "mismo cliente contacta de nuevo en 7 días". Si el equipo necesita esa segunda definición, hay que calcularla aparte — no está construida.

**FCR (primer contacto) — 39.4%.** Es un proxy, no el campo oficial. `hs_is_one_touch_ticket` sigue sin poblarse desde mayo, así que se usó `hs_num_times_contacted = 1` sobre tickets cerrados (38,750 de 98,378). Razonable como aproximación, pero no es 100% equivalente a "resuelto en el primer contacto".

**CSAT — 94.7% Promoter.** De Metabase, muestra de 6,256 tickets con encuesta respondida (5,926 Promoter / 88 Passive / 242 Detractor), tasa de respuesta muy baja (6.5% del volumen total) — no representativa del total, solo de quien respondió. Es la cifra de la primera consulta, pendiente de refrescar.

**Corte por país.** Solo 11.4% de los tickets tiene país asignado (88.6% sin dato) — el corte geográfico solo representa esa fracción, no el total.

## 5. Qué falta / qué necesita confirmación

- **CSAT desactualizado**: reconectar Metabase y volver a correr la consulta.
- **FCR como métrica oficial**: confirmar con quien corresponda (mencionado como pendiente con Agustín en las notas del propio tablero) si el proxy `hs_num_times_contacted = 1` se adopta formalmente mientras se repara `hs_is_one_touch_ticket`, o si se prefiere esperar a que el campo real se active.
- **Definición de reopen por ventana de negocio**: no está construida, solo la nativa de HubSpot. Definir si se necesita.
- **Gap de país**: 88.6% de tickets sin país asignado — es un problema de instrumentación que vale la pena escalar, no algo que se arregla desde el dashboard.
- **Automatización semanal**: la idea de que se actualice solo vía MCP desde tu equipo no está implementada; hoy es un archivo estático.
- **Dashboard de Bots de Lucía**: pendiente, sin datos disponibles en Metabase al momento de revisar.
- **Repositorio**: el código está en git local (`ce-retention-soporte-ops`, remoto configurado a `github.com/JesusMantillaAlegra/ce-retention-soporte-ops.git`) pero no se ha hecho push — eso requiere tus credenciales, así que queda pendiente de que lo hagas tú.

## 6. Archivos

- `index.html` — tablero (HTML + Chart.js, un solo archivo, sin dependencias de backend).
- Diseño replicado del dashboard de referencia "Valentina — Alegra" (paleta, tipografía, estructura de tarjetas y tablas).
