# CE-Retention — Soporte Ops

Dashboard de métricas operativas de Soporte (reopen, FCR, tiempos de cierre, CSAT, país).

**Los datos se traen en vivo desde funciones serverless en Vercel** — ya no hay archivos de datos generados a mano, ni tareas programadas que dependan de que un computador esté encendido.

```
index.html            → la interfaz (llama a /api/metrics y /api/history)
api/metrics           → foto en vivo: consulta HubSpot + Metabase en el momento
api/history           → snapshots acumulados (Vercel KV), alimenta el filtro de fecha
api/snapshot          → guarda la foto de hoy; lo dispara el cron de Vercel cada miércoles
api/seed              → siembra el histórico desde el archivo del repo (una sola vez)
api/diagnostico       → revisa la configuración pieza por pieza; primer sitio a mirar si algo falla
lib/                  → clientes de HubSpot y Metabase, y armado del payload
test/mock-test.mjs    → pruebas contra servidores simulados (node test/mock-test.mjs)
```

## Documentación

- **`DESPLIEGUE.md`** — cómo desplegar: variables de entorno, KV, cron, y qué archivos viejos borrar. Empezar acá.
- **`INSTRUCTIVO.md`** — de dónde sale cada métrica y cómo se calcula. La sección 9 explica la métrica oficial de reopen (REVPYME-732).
- **`CONTEXTO_DASHBOARD.md`** — cómo se construyó el dashboard originalmente.

## Restos por borrar

Estos archivos son de arquitecturas anteriores y ya no se usan:

- `sync_hubspot.mjs`, `merge_metabase.mjs`, `append_history.mjs` — su lógica está ahora en `lib/`
- `ce_retention_dashboard_data.js` y `.json`
- `push_dashboard.bat` — el push a git ya no hace falta, Vercel despliega solo
- `_descartado_nextjs/`

Mantener `ce_retention_dashboard_history.json` hasta después de correr `/api/seed` (es la semilla del histórico).
