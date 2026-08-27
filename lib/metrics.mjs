// lib/metrics.mjs
//
// Junta HubSpot + Metabase y arma el payload con EXACTAMENTE la misma forma
// que tenía ce_retention_dashboard_data.json en la versión de archivos
// estáticos. Eso es a propósito: index.html no tuvo que cambiar su lógica de
// render, solo de dónde lee los datos.

import { fetchHubspotMetrics } from './hubspot.mjs';
import { fetchMetabaseMetrics } from './metabase.mjs';

// El período del dashboard arranca el 01-may-2026 y va hasta hoy. Se puede
// sobrescribir con la env var PERIOD_START si algún día cambia el arranque.
export const PERIOD_START = process.env.PERIOD_START ?? '2026-05-01T00:00:00.000Z';

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

export async function buildMetrics({ periodEnd } = {}) {
  const end = periodEnd ?? new Date().toISOString();

  // HubSpot y Metabase son independientes → en paralelo. Si una falla, falla
  // todo a propósito: es mejor devolver un error visible que una foto a
  // medias que se lea como si estuviera completa.
  const [hs, mb] = await Promise.all([
    fetchHubspotMetrics({
      token: process.env.HUBSPOT_TOKEN,
      periodStart: PERIOD_START,
      periodEnd: end,
    }),
    fetchMetabaseMetrics({ periodStart: PERIOD_START.slice(0, 10), periodEnd: end.slice(0, 10) }),
  ]);

  const totalCsat = mb.csat.promoter + mb.csat.passive + mb.csat.detractor;

  // "Sin país" se calcula restando: Metabase solo agrupa los que TIENEN país,
  // y el resto (~88% hoy) queda fuera del breakout.
  const ticketsConPais = Object.values(mb.por_pais_tickets).reduce((a, b) => a + b, 0);
  const sinPais = Math.max(hs.volumen - ticketsConPais, 0);

  const filasPais = [
    { pais: 'Sin país', tickets: sinPais, cierre_horas: mb.tiempo_cierre.horas_promedio },
    ...Object.keys(mb.por_pais_tickets)
      .map((pais) => ({
        pais,
        tickets: mb.por_pais_tickets[pais],
        cierre_horas: mb.por_pais_horas[pais] ?? 0,
      }))
      .sort((a, b) => b.tickets - a.tickets),
  ].map((r) => ({
    ...r,
    pct_total: pct(r.tickets, hs.volumen),
    fuente_tickets: 'metabase',
    fuente_cierre: 'metabase',
  }));

  return {
    meta: {
      generado: etiquetaFecha(end),
      periodo: {
        inicio: PERIOD_START.slice(0, 10),
        fin: end.slice(0, 10),
        label: `${etiquetaFecha(PERIOD_START).slice(0, 6)} — ${etiquetaFecha(end)}`,
      },
    },
    kpis: {
      volumen: {
        valor: hs.volumen,
        fuente: 'hubspot',
        nota: 'No incluye correos automáticos de rebote (no son casos reales de soporte)',
      },
      tiempo_cierre_horas: {
        valor: mb.tiempo_cierre.horas_promedio,
        fuente: 'metabase',
        base_tickets: mb.tiempo_cierre.tickets_base,
        periodo: `${PERIOD_START.slice(8, 10)}-${MESES[new Date(PERIOD_START).getUTCMonth()]}—${etiquetaFecha(end).slice(0, 6)}`,
        nota: 'Promedio de horas hasta el cierre; no incluye los últimos días (aún no han tenido tiempo de cerrarse)',
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
        fuente: 'hubspot_proxy',
        nota: 'Casos resueltos en el primer contacto, sobre el total de casos cerrados',
      },
      csat_promoter: {
        valor_pct: pct(mb.csat.promoter, totalCsat),
        promoter: mb.csat.promoter,
        passive: mb.csat.passive,
        detractor: mb.csat.detractor,
        total_respuestas: totalCsat,
        tasa_respuesta_pct: pct(totalCsat, hs.volumen),
        fuente: 'metabase',
        nota: 'Solo refleja a quienes respondieron la encuesta de satisfacción, no al total de casos',
      },
    },
    tendencia_semanal: { fuente: 'metabase', ...mb.tendencia_semanal },
    por_pais: filasPais,
  };
}

// ── Validación de cordura. Se corre ANTES de guardar un snapshot o de
// devolver datos, para no publicar una foto obviamente rota (API caída, un
// filtro que dejó de aplicar, una property renombrada). Devuelve la lista de
// problemas encontrados; vacía = todo bien.
export function validarMetrics(data) {
  const problemas = [];
  const k = data?.kpis ?? {};

  const v = k.volumen?.valor;
  if (!(v > 1000 && v < 500000)) problemas.push(`volumen fuera de rango: ${v}`);

  const cierre = k.tiempo_cierre_horas?.valor;
  if (!(cierre > 1 && cierre < 500)) problemas.push(`tiempo de cierre fuera de rango: ${cierre}`);

  // Con la métrica oficial (REVPYME-732) la tasa ronda 0.5%–1%. El techo está
  // deliberadamente bajo (2%) para que dispare si algo vuelve a contar con
  // hs_ticket_reopened_at, que daba 2.53% — un techo más alto dejaría pasar
  // justo el error que esta métrica vino a corregir.
  const reopenPct = k.reopen?.valor_pct;
  if (!(reopenPct >= 0 && reopenPct < 2)) {
    problemas.push(
      `reopen fuera de rango: ${reopenPct}% (con la métrica oficial debería rondar 0.5%–1%; ` +
      `un valor cercano a 2.5% sugiere que se está contando con hs_ticket_reopened_at otra vez)`
    );
  }

  const fcrPct = k.fcr?.valor_pct;
  if (!(fcrPct > 0 && fcrPct <= 100)) problemas.push(`FCR fuera de rango: ${fcrPct}%`);

  const csatPct = k.csat_promoter?.valor_pct;
  if (!(csatPct > 0 && csatPct <= 100)) problemas.push(`CSAT fuera de rango: ${csatPct}%`);

  if (!data?.tendencia_semanal?.weeks?.length) problemas.push('tendencia semanal vacía');

  return problemas;
}
