// lib/metrics.mjs
//
// Todo sale de HubSpot ahora (ver MAPEO_CAMPOS_TABLA.md) — ya no hay
// Metabase ni respaldo de snapshot para "datos desactualizados": si HubSpot
// falla, falla todo el payload, porque ya no hay una segunda fuente que
// pueda quedar rezagada.
//
// ── TEMPORAL (27-ago-2026): mientras se construyen los "cubos" semanales
// (PLAN_IMPLEMENTACION.md, para que cambiar el filtro de fecha no dispare
// una consulta en vivo a HubSpot), cada carga del tablero hacía 6-8 llamadas
// directas a la API de HubSpot — eso saturó el límite por segundo de la
// cuenta (429 RATE_LIMIT) mientras varias personas lo abrían a la vez.
// Por pedido explícito: por ahora se sirve un valor fijo (hardcodeado),
// sacado en vivo por HubSpot MCP el 27-ago-2026 para el rango 2026-01-01 a
// 2026-08-27 (ver METRICAS_MCP.md, "Corte 1"). Cuando se construya el
// sistema de cubos, esto se reemplaza por la suma real desde KV.
const HARDCODE_TEMPORAL = true;

import {
  fetchHubspotMetrics,
  fetchTiempoCierre,
  fetchCsat,
  fetchDistribucionVersion,
  fetchTendenciaSemanal,
} from './hubspot.mjs';

// Por defecto el rango es el año en curso completo — antes arrancaba fijo en
// 01-may-2026; ahora cada año arranca en 1-ene y se puede consultar el
// histórico moviendo el filtro (ver PLAN_IMPLEMENTACION.md).
function inicioAnioActual() {
  return `${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`;
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function etiquetaFecha(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MESES[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

// Fecha de hoy en zona Bogotá, formato YYYY-MM-DD. Se usa como snapshot_id.
export function hoyBogota() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Bogota' });
}

const pct = (num, den, decimals = 1) =>
  den ? Number(((num / den) * 100).toFixed(decimals)) : 0;

// Corte 1 de METRICAS_MCP.md, sacado en vivo por HubSpot MCP el 27-ago-2026
// para 2026-01-01 a 2026-08-27, agrupado por mes (pedido explícito: mensual,
// no semanal). Ver HARDCODE_TEMPORAL arriba.
const MESES_HARDCODE = [
  '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01',
  '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01',
];
const VOLUMENES_HARDCODE = [5954, 5280, 6468, 6230, 6022, 5339, 5563, 4566];
// No se tiene el tiempo de cierre mes por mes desde MCP — se usa el promedio
// general (8,98 días ≈ 215,5 h) como aproximación temporal en todos los
// meses, solo para que el gráfico de tendencia no quede vacío.
const CIERRE_HORAS_HARDCODE = MESES_HARDCODE.map(() => 215.5);

function hardcodeMetrics(start, end) {
  const hs = { volumen: 45240, reopen: 1438, cerrados: 43406, fcr: 42015 };
  const tiempoCierre = { horas_promedio: 215.5, tickets_base: 42021 };
  const csat = { csat_pct: 83.6, promoter: 2054, passive: 100, detractor: 302, total_respuestas: 2456 };
  const version = [
    { version: 'Colombia (colombia)', tickets: 25012 },
    { version: 'República Dominicana (republicaDominicana)', tickets: 6784 },
    { version: 'México (mexico)', tickets: 4364 },
    { version: 'Costa Rica (costaRica)', tickets: 2845 },
    { version: 'Panamá (panama)', tickets: 1834 },
    { version: 'Argentina (argentina)', tickets: 1333 },
    { version: 'Perú (peru)', tickets: 1055 },
    { version: 'Unassigned', tickets: 1006 },
    { version: 'España (spain)', tickets: 776 },
    { version: 'Otro (other)', tickets: 261 },
    { version: 'Estados Unidos (usa)', tickets: 92 },
    { version: 'Chile (chile)', tickets: 39 },
    { version: 'Venezuela (venezuela)', tickets: 12 },
  ].map((v) => ({ ...v, pct_total: pct(v.tickets, hs.volumen, 2), cierre_horas: 215.5 }));
  const tendencia = { weeks: MESES_HARDCODE, volumes: VOLUMENES_HARDCODE, close_hours: CIERRE_HORAS_HARDCODE };

  return { hs, tiempoCierre, csat, version, tendencia };
}

export async function buildMetrics({ periodStart, periodEnd } = {}) {
  const start = periodStart ?? inicioAnioActual();
  const end = periodEnd ?? new Date().toISOString();
  const token = process.env.HUBSPOT_TOKEN;

  const { hs, tiempoCierre, csat, version, tendencia } = HARDCODE_TEMPORAL
    ? hardcodeMetrics(start, end)
    // Todo en paralelo — son consultas independientes a la misma fuente.
    : await Promise.all([
        fetchHubspotMetrics({ token, periodStart: start, periodEnd: end }),
        fetchTiempoCierre({ token, periodStart: start, periodEnd: end }),
        fetchCsat({ token, periodStart: start, periodEnd: end }),
        fetchDistribucionVersion({ token, periodStart: start, periodEnd: end }),
        fetchTendenciaSemanal({ token, periodStart: start, periodEnd: end }),
      ]).then(([hs, tiempoCierre, csat, version, tendencia]) => ({ hs, tiempoCierre, csat, version, tendencia }));

  return {
    meta: {
      generado: etiquetaFecha(end),
      periodo: {
        inicio: start.slice(0, 10),
        fin: end.slice(0, 10),
        label: `${etiquetaFecha(start)} — ${etiquetaFecha(end)}`,
      },
    },
    kpis: {
      volumen: {
        valor: hs.volumen,
        fuente: 'hubspot',
        nota: 'No incluye correos automáticos de rebote (no son casos reales de soporte)',
      },
      tiempo_cierre_horas: {
        valor: tiempoCierre.horas_promedio,
        fuente: 'hubspot',
        base_tickets: tiempoCierre.tickets_base,
        periodo: `${etiquetaFecha(start).slice(0, 6)}—${etiquetaFecha(end).slice(0, 6)}`,
        nota: 'Promedio de horas hasta el cierre, sin contar tickets reabiertos',
      },
      reopen: {
        valor_pct: pct(hs.reopen, hs.volumen, 2),
        reopen: hs.reopen,
        volumen: hs.volumen,
        fuente: 'hubspot',
        nota: 'Casos cerrados que el cliente reabrió con una solicitud nueva, al menos 3 días después del cierre',
      },
      fcr: {
        valor_pct: pct(hs.fcr, hs.cerrados),
        gestionados_primer_contacto: hs.fcr,
        cerrados: hs.cerrados,
        fuente: 'hubspot',
        nota: 'Casos resueltos en el primer contacto, sobre el total de casos cerrados',
      },
      csat: {
        valor_pct: csat.csat_pct,
        promoter: csat.promoter,
        passive: csat.passive,
        detractor: csat.detractor,
        total_respuestas: csat.total_respuestas,
        tasa_respuesta_pct: pct(csat.total_respuestas, hs.volumen),
        fuente: 'hubspot',
        nota: 'Solo refleja a quienes respondieron la encuesta de satisfacción, no al total de casos',
      },
    },
    tendencia_semanal: { fuente: 'hubspot', ...tendencia },
    por_version: version.map((v) => ({ ...v, fuente: 'hubspot' })),
  };
}

// ── Validación de cordura. Se corre ANTES de guardar un snapshot o de
// devolver datos, para no publicar una foto obviamente rota. Devuelve la
// lista de problemas encontrados; vacía = todo bien.
export function validarMetrics(data) {
  const problemas = [];
  const k = data?.kpis ?? {};

  const v = k.volumen?.valor;
  if (!(v > 0 && v < 500000)) problemas.push(`volumen fuera de rango: ${v}`);

  const cierre = k.tiempo_cierre_horas?.valor;
  if (!(cierre > 0 && cierre < 2000)) problemas.push(`tiempo de cierre fuera de rango: ${cierre}`);

  // Actualizado 27-ago-2026: con la definición confirmada en vivo con
  // Estefanía (REVPYME-732, contando 'Nueva consulta' en cualquiera de las
  // dos propiedades), la tasa real ronda 3%–3.5% (validado en 3,3% =
  // 1.510/45.321, y de nuevo en 3,18% = 1.438/45.240). El techo se sube a 8%
  // — sigue disparando si algo vuelve a contar con hs_ticket_reopened_at
  // directo (que daba ~2.53% con una definición distinta, o mucho más si se
  // cuentan reaperturas no deduplicadas).
  const reopenPct = k.reopen?.valor_pct;
  if (!(reopenPct >= 0 && reopenPct < 8)) {
    problemas.push(
      `reopen fuera de rango: ${reopenPct}% (con la métrica oficial debería rondar 3%–3.5%)`
    );
  }

  const fcrPct = k.fcr?.valor_pct;
  if (!(fcrPct >= 0 && fcrPct <= 100)) problemas.push(`FCR fuera de rango: ${fcrPct}%`);

  const csatPct = k.csat?.valor_pct;
  if (!(csatPct >= 0 && csatPct <= 100)) problemas.push(`CSAT fuera de rango: ${csatPct}%`);

  if (!data?.tendencia_semanal?.weeks?.length) problemas.push('tendencia semanal vacía');

  return problemas;
}
