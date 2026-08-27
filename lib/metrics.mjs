// lib/metrics.mjs
//
// Todo sale de HubSpot ahora (ver MAPEO_CAMPOS_TABLA.md) — ya no hay
// Metabase ni respaldo de snapshot para "datos desactualizados": si HubSpot
// falla, falla todo el payload, porque ya no hay una segunda fuente que
// pueda quedar rezagada.

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

export async function buildMetrics({ periodStart, periodEnd } = {}) {
  const start = periodStart ?? inicioAnioActual();
  const end = periodEnd ?? new Date().toISOString();
  const token = process.env.HUBSPOT_TOKEN;

  // Todo en paralelo — son consultas independientes a la misma fuente.
  const [hs, tiempoCierre, csat, version, tendencia] = await Promise.all([
    fetchHubspotMetrics({ token, periodStart: start, periodEnd: end }),
    fetchTiempoCierre({ token, periodStart: start, periodEnd: end }),
    fetchCsat({ token, periodStart: start, periodEnd: end }),
    fetchDistribucionVersion({ token, periodStart: start, periodEnd: end }),
    fetchTendenciaSemanal({ token, periodStart: start, periodEnd: end }),
  ]);

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

  // Con la métrica oficial (REVPYME-732) la tasa ronda 0.5%–1%. El techo está
  // deliberadamente bajo (2%) para que dispare si algo vuelve a contar con
  // hs_ticket_reopened_at, que daba 2.53%.
  const reopenPct = k.reopen?.valor_pct;
  if (!(reopenPct >= 0 && reopenPct < 2)) {
    problemas.push(
      `reopen fuera de rango: ${reopenPct}% (con la métrica oficial debería rondar 0.5%–1%; ` +
      `un valor cercano a 2.5% sugiere que se está contando con hs_ticket_reopened_at otra vez)`
    );
  }

  const fcrPct = k.fcr?.valor_pct;
  if (!(fcrPct >= 0 && fcrPct <= 100)) problemas.push(`FCR fuera de rango: ${fcrPct}%`);

  const csatPct = k.csat?.valor_pct;
  if (!(csatPct >= 0 && csatPct <= 100)) problemas.push(`CSAT fuera de rango: ${csatPct}%`);

  if (!data?.tendencia_semanal?.weeks?.length) problemas.push('tendencia semanal vacía');

  return problemas;
}
