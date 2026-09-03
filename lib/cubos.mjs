// lib/cubos.mjs
//
// Cubos mensuales pre-calculados (3-sep-2026). Antes, cada carga del
// tablero le pedía a HubSpot TODOS los tickets del rango filtrado en vivo
// -- probado localmente, una sola función para un solo mes ya tardaba
// 25-30 segundos, y el año completo dispara varias de esas funciones por
// cada uno de sus 8 meses: varios minutos, chocando con los límites de la
// Search API y con el timeout de las funciones de Vercel.
//
// La idea (Noa, 3-sep-2026): no volver a pedir TODO cada vez. Se calcula
// un "cubo" por mes calendario -- ya agregado, listo para sumarlo con el
// de otros meses -- y se guarda en el mismo store de KV que ya usa el
// histórico semanal (lib/store.mjs). Leer un cubo ya calculado es
// instantáneo (un GET a Redis). Solo se vuelve a consultar HubSpot en
// vivo cuando el mes puede seguir cambiando: los tickets casi nunca se
// reabren o cierran más de un par de meses después de creados, así que
// alcanza con re-calcular los últimos MES_ESTABLE_DIAS de meses en cada
// refresco (ver api/cubos-refrescar.mjs, que corre por cron) y dejar los
// meses más viejos tal cual quedaron calculados una vez.
import {
  fetchHubspotMetrics,
  fetchTiempoCierre,
  fetchCsat,
  fetchDistribucionVersion,
  fetchTendenciaSemanal,
  fetchDiario,
  fetchAgentesRaw,
} from './hubspot.mjs';
import { obtenerCubo as kvObtenerCubo, guardarCubo as kvGuardarCubo } from './store.mjs';

const MES_ESTABLE_DIAS = 60;

// Un mes es "estable" (ya no va a cambiar) cuando terminó hace más de
// MES_ESTABLE_DIAS días. api/cubos-refrescar.mjs usa esto para decidir a
// qué meses vale la pena volver a preguntarle a HubSpot en cada corrida.
export function mesEstable(finMesISO) {
  const fin = new Date(`${finMesISO.slice(0, 10)}T23:59:59.999Z`);
  return Date.now() - fin.getTime() > MES_ESTABLE_DIAS * 24 * 3_600_000;
}

async function construirCubo({ id, inicio, fin }, token) {
  const periodStart = `${inicio}T00:00:00.000Z`;
  const periodEnd = `${fin}T23:59:59.999Z`;

  const [hs, tiempoCierre, version, tendencia, diario, agentes, csat] = await Promise.all([
    fetchHubspotMetrics({ token, periodStart, periodEnd }),
    fetchTiempoCierre({ token, periodStart, periodEnd }),
    fetchDistribucionVersion({ token, periodStart, periodEnd }),
    fetchTendenciaSemanal({ token, periodStart, periodEnd }),
    fetchDiario({ token, periodStart, periodEnd }),
    fetchAgentesRaw({ token, periodStart, periodEnd }),
    // CSAT depende de HUBSPOT_CSAT_PROPERTY -- si falta o falla, el resto
    // del cubo sigue siendo válido para ese mes, solo sin CSAT.
    fetchCsat({ token, periodStart, periodEnd }).catch((e) => {
      console.error(`cubo ${id}: fetchCsat falló: ${e.message}`);
      return null;
    }),
  ]);

  return {
    mes: id,
    calculado_en: new Date().toISOString(),
    hs,
    tiempoCierre,
    version,
    tendencia,
    // Mapas de diario.mjs no se pueden guardar en JSON tal cual -- se
    // convierten a arrays de {fecha, ...}.
    diario: {
      creados: [...diario.creados.entries()].map(([fecha, f]) => ({ fecha, ...f })),
      cerrados: [...diario.cerrados.entries()].map(([fecha, n]) => ({ fecha, n })),
    },
    agentes,
    csat,
  };
}

// Trae el cubo de un mes: del KV si ya existe (rápido, sin tocar HubSpot),
// o calculándolo en vivo y guardándolo si falta o si forzar=true (lo usa
// el cron de refresco para los meses que todavía pueden cambiar).
export async function obtenerCubo(mes, token, { forzar = false } = {}) {
  if (!forzar) {
    const cacheado = await kvObtenerCubo(mes.id);
    if (cacheado) return cacheado;
  }
  const cubo = await construirCubo(mes, token);
  await kvGuardarCubo(mes.id, cubo);
  return cubo;
}
