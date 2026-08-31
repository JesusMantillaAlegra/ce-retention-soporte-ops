# Prompt para Breeze (asistente de IA de HubSpot)

Copia y pega esto en el chat de Breeze dentro de HubSpot. Está armado para que Breeze pueda comparar contra la configuración real del portal (pipelines, propiedades, reportes) y decir si hay una forma mejor/más simple de sacar cada dato.

---

Estoy auditando cómo un tablero externo de soporte (ticketing) calcula sus métricas contra este portal de HubSpot, para confirmar que estamos usando las mejores propiedades y filtros disponibles — o si hay una forma más simple, más precisa, o un reporte/propiedad nativa que ya haga esto y que no estemos aprovechando.

**Contexto general:** el tablero trabaja sobre el objeto Ticket, filtrado a 18 pipelines de soporte (por `hs_pipeline`, IDs numéricos) más 2 pipelines legacy ("alguna vez ha sido"), dentro de un rango de fechas de creación (`createdate`), excluyendo tickets con email de contacto `mailer-daemon@amazonses.com` (bounces) y excluyendo los tickets gestionados por un owner específico (asistente automatizada "Lucía").

Para cada una de estas métricas, quiero que revises si la propiedad/lógica que estoy usando es correcta y la mejor disponible, o si hay algo mejor:

1. **Volumen de tickets** — `COUNT(*)` de tickets que cumplen el filtro base, por `createdate`.

2. **Cerrados** — tickets donde `closed_date` está poblado.

3. **Tasa de reapertura (reopen)** — cuento como reopen cualquier ticket donde `reopen__retroactivo_tema_diferente = 'Nueva consulta'` O `ticket_reabierto__wf = 'Nueva consulta'` (los valores `'Cierre agradecimiento'`, `'Cierre o agradecimiento'` y `'Ambiguo'` NO cuentan como reopen). ¿Es esta la forma correcta de detectar reaperturas, o hay una propiedad nativa de HubSpot (tipo `hs_ticket_reopened_at`, o algo del historial de pipeline stage) que sea más confiable que estas dos propiedades custom?

4. **FCR (resolución en primer contacto)** — lo calculo como `cerrados − cerrados_que_reabrieron` (usando la misma definición de reopen del punto 3, pero solo sobre tickets cerrados). Hay una duda abierta internamente sobre si el filtro debería ser por `createdate` (cuándo se creó el ticket) o por `closed_date` con un buffer de unos días (para dar tiempo a que se detecte una reapertura antes de contar el ticket como "resuelto en primer contacto" definitivamente). ¿Cuál es la práctica recomendada para esto en HubSpot? ¿Existe algún reporte o propiedad estándar de HubSpot para FCR que debería estar usando en vez de este cálculo custom?

5. **Tiempo de cierre promedio** — uso la propiedad `time_to_close` (ya viene calculada por HubSpot en milisegundos), promediada sobre tickets cerrados excluyendo los que reabrieron. ¿Es `time_to_close` la propiedad correcta para esto, o hay otra más apropiada (ej. que excluya tiempo en espera del cliente, o que solo cuente horas hábiles)?

6. **CSAT (satisfacción)** — uso la propiedad `clasificacion_encuesta_ces_csat` (valores `Promoter`/`Passive`/`Detractor`), filtrando por la fecha en que se contestó la encuesta (`fecha_de_la_ultima_encuestra_ces_csat`), no por la fecha de creación del ticket. `CSAT % = Promoter / (Promoter + Passive + Detractor) × 100`. ¿Esto coincide con cómo HubSpot calcula el CSAT en sus reportes nativos de "Satisfacción"? ¿Hay algún reporte de encuestas nativo que ya traiga este cálculo listo, con más detalle o mejor precisión que armarlo a mano sobre el objeto Ticket?

7. **Distribución por país** — encontramos que la propiedad `version` (label "HD - Versión") en realidad contiene nombres de país (`colombia`, `mexico`, etc.), no versiones de producto. ¿Existe alguna otra propiedad de Ticket o de Contacto/Empresa asociada que sea la fuente "oficial" de país, en caso de que esta no sea la intención original de esa propiedad?

8. **Filtro de pipelines** — uso `hs_pipeline IN (lista de 20 IDs)` para limitar a soporte. ¿Hay alguna forma de referenciar "todos los pipelines de tipo Soporte/Tickets" sin tener que mantener una lista fija de IDs a mano (por ejemplo si se crea un pipeline nuevo, hoy no se refleja automáticamente en el tablero)?

Para cada punto, dime: (a) si la propiedad/lógica que uso es la correcta y recomendada, (b) si hay una alternativa mejor disponible en este portal específicamente, y (c) si hay algún reporte nativo de HubSpot que ya resuelva esto sin necesidad de armarlo manualmente.
