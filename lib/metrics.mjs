// lib/metrics.mjs
//
// Todo sale de HubSpot en vivo (ver MAPEO_CAMPOS_TABLA.md) — ya no hay
// Metabase, snapshot de respaldo ni valores hardcodeados: si HubSpot falla,
// falla todo el payload, porque no hay una segunda fuente que pueda quedar
// rezagada.
//
// ── (3-sep-2026) Hasta el 31-ago-2026 el tablero servía un valor fijo
// (hardcodeado). Se intentó reemplazarlo pidiéndole a HubSpot TODO el
// rango filtrado en vivo en cada carga -- funcionaba para un mes, pero
// probado localmente una sola función ya tardaba 25-30 segundos, y el año
// completo dispara varias de esas funciones por cada uno de sus 8 meses:
// varios minutos, chocando con los límites de la Search API y con el
// timeout de las funciones de Vercel.
//
// Ahora buildMetrics() no le pregunta nada a HubSpot directamente: lee
// (o manda a calcular, si falta) un "cubo" ya agregado por cada mes
// calendario del rango pedido (lib/cubos.mjs, guardado en el mismo KV que
// el histórico semanal) y los combina en memoria. Leer cubos ya
// calculados es instantáneo; la parte lenta (consultar HubSpot) corre por
// separado, por cron, solo para los meses que todavía pueden cambiar
// (api/cubos-refrescar.mjs).
import { fetchNombresOwners } from './hubspot.mjs';
import { mesesEnRango } from './fechas.mjs';
import { obtenerCubo } from './cubos.mjs';

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

// mesesEnRango() vive en lib/fechas.mjs (compartida con lib/cubos.mjs).

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

  // Un cubo por mes calendario del rango pedido -- de KV si ya está
  // calculado (instantáneo), o calculado en vivo ahí mismo si falta (ver
  // lib/cubos.mjs). El refresco periódico de los meses recientes corre
  // aparte, por cron (api/cubos-refrescar.mjs) -- acá solo se lee.
  const meses = mesesEnRango(start, end);
  const cubos = await Promise.all(meses.map((mes) => obtenerCubo(mes, token)));

  // ── Fusión de los cubos mensuales en los mismos agregados que antes
  // salían de una sola consulta en vivo a todo el rango.
  const hs = { volumen: 0, reopen: 0, cerrados: 0, fcr: 0, fcrCerradosReabiertos: 0 };
  let sumaHorasCierre = 0;
  let nCierre = 0;
  const histograma = { menos_1: 0, de_1_a_3: 0, de_3_a_7: 0, de_7_a_14: 0, de_14_a_30: 0, mas_30: 0 };
  const porVersion = new Map();
  const porSemana = new Map();
  const diarioCreados = new Map();
  const diarioCerrados = new Map();
  const porAgente = new Map();
  let promoter = 0;
  let passive = 0;
  let detractor = 0;

  for (const cubo of cubos) {
    hs.volumen += cubo.hs.volumen;
    hs.reopen += cubo.hs.reopen;
    hs.cerrados += cubo.hs.cerrados;
    hs.fcr += cubo.hs.fcr;
    hs.fcrCerradosReabiertos += cubo.hs.fcrCerradosReabiertos;

    sumaHorasCierre += cubo.tiempoCierre.suma_horas;
    nCierre += cubo.tiempoCierre.tickets_base;
    for (const k of Object.keys(histograma)) histograma[k] += cubo.tiempoCierre.histograma?.[k] ?? 0;

    for (const v of cubo.version) {
      if (!porVersion.has(v.version)) porVersion.set(v.version, { tickets: 0, sumaHoras: 0, nCierre: 0 });
      const f = porVersion.get(v.version);
      f.tickets += v.tickets;
      f.sumaHoras += v.suma_horas;
      f.nCierre += v.n_cierre;
    }

    // Una semana puede quedar repartida entre dos cubos si cruza el fin de
    // mes (ej. semana que arranca el 29-ene) -- se suma por clave de
    // semana, así que el resultado combinado es el mismo que si se hubiera
    // pedido de una sola vez.
    for (let i = 0; i < cubo.tendencia.weeks.length; i++) {
      const semana = cubo.tendencia.weeks[i];
      if (!porSemana.has(semana)) porSemana.set(semana, { volumen: 0, sumaHoras: 0, nCierre: 0 });
      const f = porSemana.get(semana);
      f.volumen += cubo.tendencia.volumes[i];
      f.sumaHoras += cubo.tendencia.suma_horas[i];
      f.nCierre += cubo.tendencia.n_cierre[i];
    }

    for (const d of cubo.diario.creados) diarioCreados.set(d.fecha, d);
    for (const d of cubo.diario.cerrados) diarioCerrados.set(d.fecha, d.n);

    for (const a of cubo.agentes) {
      if (!porAgente.has(a.owner_id)) porAgente.set(a.owner_id, { volumen: 0, reopens: 0, sumaDias: 0, nCierre: 0 });
      const f = porAgente.get(a.owner_id);
      f.volumen += a.volumen;
      f.reopens += a.reopens;
      f.sumaDias += a.suma_dias;
      f.nCierre += a.n_cierre;
    }

    if (cubo.csat) {
      promoter += cubo.csat.promoter;
      passive += cubo.csat.passive;
      detractor += cubo.csat.detractor;
    }
  }

  const tiempoCierre = {
    horas_promedio: nCierre ? Number((sumaHorasCierre / nCierre).toFixed(1)) : 0,
    tickets_base: nCierre,
    histograma,
  };
  const histogramaCierre = histograma;

  const version = [...porVersion.entries()]
    .map(([v, f]) => ({
      version: v,
      tickets: f.tickets,
      pct_total: hs.volumen ? Number(((f.tickets / hs.volumen) * 100).toFixed(2)) : 0,
      cierre_horas: f.nCierre ? Number((f.sumaHoras / f.nCierre).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.tickets - a.tickets);

  const semanas = [...porSemana.keys()].sort();
  const tendencia = {
    weeks: semanas,
    volumes: semanas.map((s) => porSemana.get(s).volumen),
    close_hours: semanas.map((s) => {
      const f = porSemana.get(s);
      return f.nCierre ? Number((f.sumaHoras / f.nCierre).toFixed(1)) : 0;
    }),
    // Crudos (no promediados) -- el frontend los necesita para agrupar
    // semanas en meses (vista de año completo) sin perder precisión: un
    // promedio de promedios semanales no es lo mismo que sumar horas y
    // tickets cerrados y dividir al final.
    suma_horas: semanas.map((s) => porSemana.get(s).sumaHoras),
    n_cierre: semanas.map((s) => porSemana.get(s).nCierre),
  };

  const { creadosVsCerrados, primeraRespuesta } = agregarPorMesODias(meses, { creados: diarioCreados, cerrados: diarioCerrados });

  // Umbral y nombres se resuelven UNA vez, sobre el total ya combinado de
  // todos los meses -- no mes por mes (un agente puede no llegar a 100
  // tickets en un solo mes pero sí en el rango completo).
  const volumenMinimoAgente = 100;
  const agentesFiltrados = [...porAgente.entries()].filter(([, f]) => f.volumen >= volumenMinimoAgente);
  const nombresAgentes = await fetchNombresOwners(token, agentesFiltrados.map(([id]) => id));
  const agentes = agentesFiltrados
    .map(([id, f]) => ({
      nombre: nombresAgentes.get(id) ?? `Owner ${id}`,
      volumen: f.volumen,
      reopens: f.reopens,
      reopen_pct: f.volumen ? Number(((f.reopens / f.volumen) * 100).toFixed(1)) : 0,
      ttc_dias: f.nCierre ? Number((f.sumaDias / f.nCierre).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.volumen - a.volumen);

  const totalRespuestasCsat = promoter + passive + detractor;
  const csat = {
    csat_pct: totalRespuestasCsat ? Number(((promoter / totalRespuestasCsat) * 100).toFixed(1)) : 0,
    promoter,
    passive,
    detractor,
    total_respuestas: totalRespuestasCsat,
  };

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
