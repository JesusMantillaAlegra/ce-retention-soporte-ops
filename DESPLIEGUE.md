# Despliegue en Vercel — pasos, en orden

Este dashboard ya no depende de archivos generados ni de que ningún computador esté encendido. Los datos se traen en vivo de HubSpot y Metabase desde funciones serverless, y el histórico lo acumula solo un cron de Vercel.

## Qué reemplaza a qué

| Antes | Ahora |
|---|---|
| Tarea programada de Claude (miércoles 8:30) | Cron nativo de Vercel → `/api/snapshot` |
| `push_dashboard.bat` + Programador de tareas de Windows | Nada — ya no hace falta |
| `sync_hubspot.mjs` / `merge_metabase.mjs` / `append_history.mjs` corriendo a mano | `/api/metrics`, que consulta las dos fuentes en vivo |
| `ce_retention_dashboard_data.js` / `.json` | `/api/metrics` |
| `ce_retention_dashboard_history.js` / `.json` | `/api/history` (guardado en Vercel KV) |
| Depender de que la app de escritorio de Claude estuviera abierta | Nada — corre en la nube de Vercel |

Los archivos viejos se pueden borrar del repo una vez que esto quede andando (ver el último paso).

## 1. Crear el store del histórico

En el dashboard de Vercel, dentro del proyecto: **Storage → Create Database → KV**, y conectarlo a este proyecto.

Al conectarlo, Vercel inyecta solo las variables `KV_REST_API_URL` y `KV_REST_API_TOKEN`. No hay que copiarlas a mano.

## 2. Cargar las variables de entorno

**Settings → Environment Variables.** Las cuatro van en los tres entornos (Production, Preview, Development):

| Variable | Qué es | Dónde se saca |
|---|---|---|
| `HUBSPOT_TOKEN` | Token del Private App de HubSpot | HubSpot → Settings → Integrations → Private Apps. Necesita el scope `crm.objects.tickets.read` |
| `METABASE_URL` | URL base de la instancia, **sin barra al final** (ej. `https://metabase.alegra.com`) | La URL con la que entras a Metabase |
| `METABASE_API_KEY` | API key de Metabase | Metabase → Settings → Authentication → API keys |
| `CRON_SECRET` | Una cadena aleatoria que inventes | Cualquier string largo. Protege `/api/snapshot` para que no lo pueda llamar cualquiera |

Sobre `CRON_SECRET`: Vercel manda ese valor como header `Authorization: Bearer ...` en las llamadas de su propio cron. Sin él definido, `/api/snapshot` se niega a correr a propósito — es preferible que falle visible antes que quedar abierto.

**Importante:** después de agregar variables hay que **re-desplegar**; Vercel no las inyecta en un deploy que ya existe.

## 3. Verificar que todo quedó conectado

Abrir en el navegador:

```
https://<tu-proyecto>.vercel.app/api/diagnostico
```

Revisa las 4 piezas una por una y dice exactamente cuál falla y por qué. Si devuelve `"listo": true`, ya está. Este es el primer sitio a mirar si algo no anda — un 500 en `/api/metrics` no dice cuál de las 4 cosas se rompió, este sí.

No expone el valor de ningún secreto, solo si está presente y si funciona.

## 4. Sembrar el histórico que ya existía

El histórico arranca vacío. Para no perder la foto del 20-ago que ya estaba en el repo, correr una vez (reemplazando `<CRON_SECRET>` por el valor real):

```
curl -X POST https://<tu-proyecto>.vercel.app/api/seed \
  -H "Authorization: Bearer <CRON_SECRET>"
```

Requiere que `ce_retention_dashboard_history.json` siga estando en el repo. Se niega a correr si el histórico ya tiene snapshots, salvo que se agregue `?forzar=1`.

## 5. Probar el snapshot a mano

Sin esperar al miércoles:

```
curl -X POST https://<tu-proyecto>.vercel.app/api/snapshot \
  -H "Authorization: Bearer <CRON_SECRET>"
```

Devuelve el resumen de los números que guardó. Si los datos no pasan la validación de cordura, responde 422 y **no guarda nada** — a propósito: un snapshot es permanente y ensuciaría todas las comparaciones futuras. Es mejor saltarse una semana que guardar una foto rota.

## 6. El cron

Ya está configurado en `vercel.json`:

```json
{ "path": "/api/snapshot", "schedule": "30 13 * * 3" }
```

`30 13 * * 3` = miércoles 13:30 UTC = **8:30 AM hora Bogotá**. Se activa solo al desplegar; se puede ver en **Settings → Cron Jobs**.

Ojo con el plan: en el plan Hobby de Vercel los cron jobs corren **una vez al día como máximo** y no garantizan el minuto exacto (pueden correr dentro de la hora). Para este caso (un snapshot semanal) da igual. Si se necesitara más precisión, hay que pasar a Pro.

## 7. Endpoints

| Endpoint | Método | Para qué |
|---|---|---|
| `/api/metrics` | GET | Foto en vivo. Es lo que llama el dashboard al abrir. Cacheado 10 min en el CDN |
| `/api/history` | GET | Los snapshots acumulados, para el filtro de fecha |
| `/api/snapshot` | POST | Guarda la foto de hoy en el histórico. Lo llama el cron. Requiere `CRON_SECRET` |
| `/api/seed` | POST | Siembra el histórico desde el archivo del repo. Una sola vez. Requiere `CRON_SECRET` |
| `/api/diagnostico` | GET | Revisa la configuración pieza por pieza |

## 8. Limpieza (después de confirmar que funciona)

Ya no se usan y se pueden borrar del repo:

- `sync_hubspot.mjs`, `merge_metabase.mjs`, `append_history.mjs` — su lógica está ahora en `lib/`
- `ce_retention_dashboard_data.js` y `.json`
- `push_dashboard.bat`
- `_descartado_nextjs/`

**Dejar** `ce_retention_dashboard_history.json` hasta después de correr `/api/seed` (es la semilla). Después de eso también se puede borrar, aunque no molesta tenerlo como respaldo del arranque.

También conviene **eliminar la tarea programada de Claude** (trigger `trig_01Y4CFewYtSfxNMpQodpsMYe`), que quedó obsoleta — si se deja activa va a intentar escribir archivos que ya nadie lee.

## Si algo falla

1. `/api/diagnostico` — dice cuál de las 4 piezas está mal.
2. **Vercel → Logs** — los errores de las funciones quedan ahí con el detalle completo.
3. Si `/api/metrics` responde con un campo `_advertencias`, los datos llegaron pero algún número se ve fuera de rango. El dashboard los pinta igual (mejor que una pantalla en blanco) y deja el aviso en la consola del navegador.
