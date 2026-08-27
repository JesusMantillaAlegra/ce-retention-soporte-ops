// GET /api/diagnostico
//
// Revisa una por una las piezas de la configuración y dice cuál falla y por
// qué. Existe porque este sistema depende de 4 cosas externas (token de
// HubSpot, URL de Metabase, API key de Metabase, store de KV) y cuando algo
// no anda, un 500 genérico en /api/metrics no dice cuál de las 4 es.
//
// Es el primer endpoint a abrir después de desplegar.
//
// No expone valores de secretos, solo si están presentes y si funcionan.

import { resolveSchema } from '../lib/metabase.mjs';
import { fetchHubspotMetrics } from '../lib/hubspot.mjs';
import { leerHistorico } from '../lib/store.mjs';
import { PERIOD_START } from '../lib/metrics.mjs';

const ok = (detalle) => ({ estado: 'ok', detalle });
const falla = (e) => ({ estado: 'falla', detalle: String(e?.message ?? e) });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const checks = {};

  // 1) ¿Están definidas las variables de entorno?
  const requeridas = ['HUBSPOT_TOKEN', 'METABASE_URL', 'METABASE_API_KEY', 'CRON_SECRET'];
  const faltantes = requeridas.filter((v) => !process.env[v]);
  checks.variables_entorno = faltantes.length
    ? { estado: 'falla', detalle: `Faltan: ${faltantes.join(', ')}` }
    : ok('Las 4 variables están definidas');

  // 2) HubSpot responde y los filtros devuelven algo razonable
  try {
    const hs = await fetchHubspotMetrics({
      token: process.env.HUBSPOT_TOKEN,
      periodStart: PERIOD_START,
      periodEnd: new Date().toISOString(),
    });
    checks.hubspot = ok(
      `volumen=${hs.volumen}, reopen=${hs.reopen}, cerrados=${hs.cerrados}, fcr=${hs.fcr}`
    );
  } catch (e) {
    checks.hubspot = falla(e);
  }

  // 3) Metabase responde y encontramos la tabla y sus columnas
  try {
    const s = await resolveSchema();
    checks.metabase = ok(
      `base id=${s.databaseId}, tabla id=${s.tableId}, ${Object.keys(s.fields).length} columnas resueltas`
    );
  } catch (e) {
    checks.metabase = falla(e);
  }

  // 4) El store del histórico está conectado
  try {
    const h = await leerHistorico();
    checks.historico_kv = ok(
      h.length
        ? `${h.length} snapshots guardados (más reciente: ${h[h.length - 1].snapshot_id})`
        : 'KV conectado, histórico todavía vacío — correr /api/seed o esperar el primer cron'
    );
  } catch (e) {
    checks.historico_kv = falla(e);
  }

  const todoOk = Object.values(checks).every((c) => c.estado === 'ok');
  return res.status(todoOk ? 200 : 503).json({
    listo: todoOk,
    checks,
    siguiente_paso: todoOk
      ? 'Todo conectado. El dashboard ya puede consumir /api/metrics.'
      : 'Revisar los checks en falla. Las variables de entorno se configuran en Vercel → Settings → Environment Variables (y hay que re-desplegar después de agregarlas).',
  });
}
