// lib/metrics.mjs
//
// Todo sale de HubSpot en vivo (ver MAPEO_CAMPOS_TABLA.md) — ya no hay
// Metabase, snapshot de respaldo ni valores hardcodeados: si HubSpot falla,
// falla todo el payload, porque no hay una segunda fuente que pueda quedar
// rezagada.
//
// ── (3-sep-2026) Hasta el 31-ago-2026 el tablero servía un valor fijo
// (hardcodeado) porque cada carga hacía 6-8 llamadas directas a la API y
// eso saturaba el límite por segundo de la cuenta (429 RATE_LIMIT) con
// varias personas abriendo el tablero a la vez. Pero api/metrics.mjs ya
// sirve la respuesta con caché de CDN (s-maxage=600,
// stale-while-revalidate=3600), así que ese límite ya no se pisa: como
// mucho una carga real a HubSpot cada 10 minutos, sin importar cuánta
// gente abra el tablero. Con eso resuelto, ya no hace falta ningún valor
// fijo — todo sale en vivo, para cualquier rango de fechas.
import {
  fetchHubspotMetrics,
  fetchTiempoCierre,
  fetchCsat,
  fetchDistribucionVersion,
  fetchTendenciaSemanal,
  fetchDiario,
  fetchAgentes,
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

// ── Meses del rango pedido, calculados dinámicamente (ya no un array fijo
// para 2026) — funciona para cualquier año/rango. Cada mes trae su primer y
// último día (para las consultas por closed_date/createdate) y una
// etiqueta corta para los gráficos.
function mesesEnRango(start, end) {
  const meses = [];
  let cursor = new Date(`${start.slice(0, 10)}T00:00:00.000Z`);
  cursor.setUTCDate(1);
  const limite = new Date(`${end.slice(0, 10)}T00:00:00.000Z`);
  while (cursor <= limite) {
    const anio = cursor.getUTCFullYear();
    const mes = cursor.getUTCMonth();
    const inicio = cursor.toISOString().slice(0, 10);
    const fin = new Date(Date.UTC(anio, mes + 1, 0)).toISOString().slice(0, 10);
    meses.push({ inicio, fin, label: `${MESES[mes]}` });
    cursor = new Date(Date.UTC(anio, mes + 1, 1));
  }
  return meses.length ? meses : [{ inicio: start.slice(0, 10), fin: end.slice(0, 10), label: MESES[new Date(start).getUTCMonth()] }];
}

// "Creados vs Cerrados" y "Tiempo a primera respuesta" a partir del diario
// en vivo (lib/hubspot.mjs::fetchDiario). Si el rango pedido cae en
// exactamente un mes, se desglosa en bloques de 5 días (acumulados, para
// que el último punto llegue al total real del mes) — pedido de Noa,
// 31-ago-2026, para que la línea tenga varios puntos y no uno solo. Con más
// de un mes, se mantiene un punto por mes, igual que antes.
function agregarPorMesODias(meses, diario) {
  const sumaCreados = (desde, hasta) => {
    let n = 0, sumaHoras = 0, nHoras = 0;
    for (const [fecha, f] of diario.creados) {
      if (fecha >= desde && fecha <= hasta) {
        n += f.n;
        sumaHoras += f.sumaHoras;
        nHoras += f.nHoras;
      }
    }
    return { n, horas: nHoras ? sumaHoras / nHoras : 0 };
  };
  const sumaCerrados = (desde, hasta) => {
    let n = 0;
    for (const [fecha, c] of diario.cerrados) {
      if (fecha >= desde && fecha <= hasta) n += c;
    }
    return n;
  };

  if (meses.length === 1) {
    const { inicio, fin } = meses[0];
    const diaFin = Number(fin.slice(8, 10));
    const anioMes = inicio.slice(0, 7);
    const bloques = [];
    for (let d = 1; d <= diaFin; d += 5) {
      bloques.push([d, Math.min(d + 4, diaFin)]);
    }
    const labels = bloques.map(([a, b]) => `${a}-${b}`);
    let accCreados = 0;
    let accCerrados = 0;
    const creados = [];
    const cerrados = [];
    const horas = [];
    for (const [a, b] of bloques) {
      const desde = `${anioMes}-${String(a).padStart(2, '0')}`;
      const hasta = `${anioMes}-${String(b).padStart(2, '0')}`;
      const rc = sumaCreados(desde, hasta);
      accCreados += rc.n;
      accCerrados += sumaCerrados(desde, hasta);
      creados.push(accCreados);
      cerrados.push(accCerrados);
      horas.push(Number(rc.horas.toFixed(1)));
    }
    return {
      creadosVsCerrados: { meses: labels, creados, cerrados },
      primeraRespuesta: { meses: labels, horas },
    };
  }

  const labels = meses.map((m) => m.inicio.slice(0, 7));
  const creados = [];
  const cerrados = [];
  const horas = [];
  for (const m of meses) {
    const rc = sumaCreados(m.inicio, m.fin);
    creados.push(rc.n);
    cerrados.push(sumaCerrados(m.inicio, m.fin));
    horas.push(Number(rc.horas.toFixed(1)));
  }
  return {
    creadosVsCerrados: { meses: labels, creados, cerrados },
    primeraRespuesta: { meses: labels, horas },
  };
}


export async function buildMetrics({ periodStart, periodEnd } = {}) {
  const start = periodStart ?? inicioAnioActual();
  const end = periodEnd ?? new Date().toISOString();
  const token = process.env.HUBSPOT_TOKEN;

  // Todo en vivo, en paralelo — son consultas independientes a la misma
  // fuente (HubSpot). Ya no hay rama hardcodeada: api/metrics.mjs cachea la
  // respuesta en el CDN (s-maxage=600), así que no importa cuánta gente
  // abra el tablero a la vez — como mucho una carga real cada 10 minutos.
  const [hs, tiempoCierre, csat, version, tendencia, diario, agentes] = await Promise.all([
    fetchHubspotMetrics({ token, periodStart: start, periodEnd: end }),
    fetchTiempoCierre({ token, periodStart: start, periodEnd: end }),
    fetchCsat({ token, periodStart: start, periodEnd: end }),
    fetchDistribucionVersion({ token, periodStart: start, periodEnd: end }),
    fetchTendenciaSemanal({ token, periodStart: start, periodEnd: end }),
    fetchDiario({ token, periodStart: start, periodEnd: end }),
    fetchAgentes({ token, periodStart: start, periodEnd: end }),
  ]);

  const meses = mesesEnRango(start, end);
  const { creadosVsCerrados, primeraRespuesta } = agregarPorMesODias(meses, diario);
  const histogramaCierre = tiempoCierre.histograma;

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
      // OJO (31-ago-2026): el reopen ya NO se calcula sobre la cohorte de
      // createdate (hs.reopen / hs.volumen). Ese cálculo entendía por
      // "reopen del mes" los tickets CREADOS ese mes que después
      // reabrieron -- y para el mes en curso (o cualquier mes muy
      // reciente) la mayoría de esos tickets todavía no tuvieron los 3
      // días de maduración para reabrirse, así que salía artificialmente
      // bajo (agosto daba 0,7% cuando en realidad es ~3,2%). Se cambia a
      // la misma cohorte cerrada+madura que usa FCR (closed_date + 3 días)
      // -- así Reopen y FCR son complementarios (reopen% + fcr% = 100%)
      // en cualquier mes y en el global, sin el sesgo del mes en curso.
      reopen: {
        valor_pct: pct(hs.fcrCerradosReabiertos, hs.cerrados, 2),
        reopen: hs.fcrCerradosReabiertos,
        volumen: hs.cerrados,
        fuente: 'hubspot',
        nota: 'Casos cerrados que el cliente reabrió con una solicitud nueva, al menos 3 días después del cierre (sobre el universo cerrado+maduro, mismo que FCR)',
      },
      // FCR "(no re-open)" (pedido de Lauren, 31-ago-2026): la fórmula es
      // 1 − %reopen. OJO: el %reopen que se usa acá NO es el del KPI de
      // Reopen de arriba (ese es por cohorte de createdate, sirve para medir
      // demanda y está validado con Estefanía en 3,3% global) — es el %
      // reopen sobre el propio universo de FCR (closed_date + ventana de
      // maduración de 3 días: hs.fcrCerradosReabiertos / hs.cerrados). Si se
      // usara el reopen por createdate, el mes en curso (o cualquier mes muy
      // reciente) sale artificialmente bajo — todavía no tuvo tiempo de
      // maduar — e infla el FCR de ese mes de forma incoherente frente a los
      // demás. Con el universo cerrado+maduro, FCR es coherente mes a mes y
      // con el global (verificado 31-ago-2026).
      fcr: {
        valor_pct: Number((100 - pct(hs.fcrCerradosReabiertos, hs.cerrados, 2)).toFixed(2)),
        gestionados_primer_contacto: hs.fcr,
        cerrados: hs.cerrados,
        fuente: 'hubspot',
        nota: 'FCR (no re-open): 1 − % de reopen sobre el universo cerrado+maduro de FCR',
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
    creados_vs_cerrados: creadosVsCerrados ? { fuente: 'hubspot', ...creadosVsCerrados } : null,
    primera_respuesta: primeraRespuesta ? { fuente: 'hubspot', ...primeraRespuesta } : null,
    histograma_cierre: histogramaCierre ? { fuente: 'hubspot', ...histogramaCierre } : null,
    agentes: agentes ?? null,
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
