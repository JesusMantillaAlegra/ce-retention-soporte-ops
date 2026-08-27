// GET /api/diagnostico
//
// Revisa una por una las piezas de la configuración y dice cuál falla y por
// qué. Ya no depende de Metabase (ver MAPEO_CAMPOS_TABLA.md) — todo sale de
// HubSpot, así que las piezas externas son: token de HubSpot, propiedad de
// CSAT, y el store de KV para el histórico.
//
// Es el primer endpoint a abrir después de desplegar.
//
// No expone valores de secretos, solo si están presentes y si funcionan.

import { fetchHubspotMetrics, fetchCsat } from '../lib/hubspot.mjs';
import { leerHistorico } from '../lib/store.mjs';

const ok = (detalle) => ({ estado: 'ok', detalle });
const falla = (e) => ({ estado: 'falla', detalle: String(e?.message ?? e) });

function inicioAnioActual() {
  return `${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const checks = {};
  const periodStart = inicioAnioActual();
  const periodEnd = new Date().toISOString();

  // 1) ¿Están definidas las variables de entorno?
  const requeridas = ['HUBSPOT_TOKEN', 'CRON_SECRET', 'HUBSPOT_CSAT_PROPERTY'];
  const faltantes = requeridas.filter((v) => !process.env[v]);
  checks.variables_entorno = faltantes.length
    ? { estado: 'falla', detalle: `Faltan: ${faltantes.join(', ')}` }
    : ok('Definidas. HUBSPOT_OWNER_LUCIA es opcional (sin ella, no se excluye la gestión de Lucía).');

  // 2) HubSpot responde y los filtros devuelven algo razonable
  try {
    const hs = await fetchHubspotMetrics({ token: process.env.HUBSPOT_TOKEN, periodStart, periodEnd });
    checks.hubspot = ok(
      `volumen=${hs.volumen}, reopen=${hs.reopen}, cerrados=${hs.cerrados}, fcr=${hs.fcr}`
    );
  } catch (e) {
    checks.hubspot = falla(e);
  }

  // 3) La propiedad de CSAT existe y devuelve datos
  try {
    const csat = await fetchCsat({ token: process.env.HUBSPOT_TOKEN, periodStart, periodEnd });
    checks.csat = ok(`csat=${csat.csat_pct}% sobre ${csat.total_respuestas} respuestas`);
  } catch (e) {
    checks.csat = falla(e);
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
