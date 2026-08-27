# Prompt — Replicar el ajuste del tablero de Soporte en el tablero de Lucía

Usa este prompt completo (pégalo tal cual) para pedir que se haga con el tablero de Lucía (CE-luciaBot) el mismo trabajo que ya se hizo con el tablero de Soporte (CE-Retention). El objetivo es el mismo: que cada KPI, gráfico y tabla quede documentado con su propiedad real de HubSpot, su filtro exacto, su SQL y su fórmula matemática — y que todo lo que no se pueda sacar de una fuente confiable y verificada se elimine, no se deje "por si acaso".

---

## Prompt

"Necesito que hagas con el tablero de Lucía exactamente el mismo trabajo que ya se hizo con el tablero de Soporte (CE-Retention). Esto implica auditar CADA KPI, CADA gráfico y CADA tabla que hoy se muestra en el tablero de Lucía, uno por uno, sin dejar ninguno sin revisar.

Para cada elemento del tablero (cada tarjeta de KPI, cada gráfico, cada columna de cada tabla) necesito:

1. **La propiedad real de HubSpot** que lo alimenta — el nombre técnico (internal name), no el nombre visible. Si el dato no viene de una propiedad de HubSpot sino de otra fuente (Eleven Labs para llamadas, por ejemplo), decirlo explícito.
2. **Los filtros exactos aplicados** — pipeline, fecha, propietario del ticket, canal, cualquier condición. Si hay un filtro común a varios indicadores (como el filtro de pipelines de soporte que usamos en CE-Retention), indicarlo una sola vez arriba y no repetirlo en cada fila.
3. **La consulta SQL equivalente** de cada indicador, para que cualquiera pueda reproducir el número sin adivinar.
4. **La fórmula matemática** exacta (qué se divide entre qué, qué se suma, qué se excluye).

Reglas que hay que seguir, las mismas que se usaron en CE-Retention:

- **Todo lo que no esté en HubSpot se elimina.** Si algo depende de una fuente que no se puede validar o reproducir de forma confiable (como pasó con el corte por país en CE-Retention, que dependía de una propiedad de HubSpot que ya se había probado que no cuadraba), no se deja como aproximación — se saca del tablero.
- **Nada de asumir cómo está calculado un indicador si no se puede confirmar con la propiedad real.** Si hay dudas genuinas sobre una definición de negocio (por ejemplo, si algo debe incluir o excluir cierta gestión), se resuelve con quien tenga la respuesta antes de escribirlo como definitivo — pero si el dato ya existe y es solo cuestión de tomarlo, se toma, sin dejarlo como pregunta abierta en la documentación final.
- **Usar paneles oficiales de HubSpot como fuente de verdad cuando existan.** En CE-Retention encontramos que el panel oficial de "Satisfacción" en HubSpot ya tenía los filtros correctos configurados y validados — eso fue más confiable que reconstruir la lógica de memoria. Buscar si existen paneles equivalentes para los indicadores de Lucía (correos gestionados, tiempos de respuesta, lo que sea que se esté midiendo) antes de armar la consulta desde cero.
- **Todo se construye sobre el objeto correcto de HubSpot** (Tickets, o el que corresponda para Lucía — probablemente también Tickets, filtrado por el propietario/bot de Lucía) — no mezclar con otros objetos salvo que sea estrictamente necesario.

Con esa auditoría completa, necesito dos documentos, con la misma estructura que ya usamos en CE-Retention:

**Documento 1 — Mapeo de campos**, con esta estructura:
- Una sección de "Filtro común a todas las métricas" (si aplica), con el SQL del filtro compartido.
- Una tabla de 3 columnas: Métrica | Propiedad(es) de HubSpot | Filtros específicos (sin meter SQL ni fórmula adentro de la tabla, para que no se rompa el formato al abrirlo).
- Una sección aparte, debajo, con "SQL y fórmula por métrica" — un bloque de código SQL y la fórmula matemática para cada indicador, uno debajo del otro.
- Nada de preguntas abiertas ni advertencias tipo '⚠ pendiente' en la versión final — si el dato existe, se toma y se documenta como definitivo.

**Documento 2 — Plan de implementación**, con esta estructura:
- Qué cambia en las consultas actuales (filtros, propiedades, fórmulas nuevas vs. las viejas).
- Qué se elimina y por qué (todo lo que no tenga fuente confiable en HubSpot).
- Cómo se resuelve el histórico — si Lucía necesita comparar meses o años anteriores, aplicar el mismo patrón de 'cubos' precalculados (por semana o por período que tenga sentido) en vez de consultar todo en vivo cada vez, para que el tablero pueda reaccionar a cambios de filtro sin necesidad de un botón 'Aplicar' y sin sobrecargar la API de HubSpot.
- Orden de trabajo sugerido, paso a paso, marcando cuál paso es bloqueante (por ejemplo, conseguir un nombre técnico de propiedad antes de poder programar algo).

Al final necesito confirmación de: cuántos KPIs tiene hoy el tablero de Lucía, cuántos gráficos, cuántas tablas y cuántas columnas por tabla — un inventario completo, para saber que no se quedó nada sin mapear, igual que se hizo al final con el tablero de Soporte."

---

## Contexto de referencia (adjuntar junto con el prompt)

Al usar este prompt, adjuntar también:
- `MAPEO_CAMPOS_TABLA.md` (de CE-Retention) — como ejemplo del formato exacto que se espera para el Documento 1.
- `PLAN_IMPLEMENTACION.md` (de CE-Retention) — como ejemplo del formato exacto que se espera para el Documento 2.
- El archivo `index.html` actual del tablero de Lucía, o una captura de cada sección, para que la auditoría parta de lo que realmente existe hoy en pantalla y no de memoria.
