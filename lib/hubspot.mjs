// lib/hubspot.mjs
//
// Todo el tablero sale de aquí ahora — HubSpot es la única fuente (ver
// MAPEO_CAMPOS_TABLA.md). Ya no se usa Metabase para nada: tiempo de cierre,
// CSAT y distribución por versión se calculan directo sobre el objeto
// Tickets.
//
// Variables de entorno:
//   HUBSPOT_TOKEN     — Private App con scope crm.objects.tickets.read
//   HUBSPOT_OWNER_LUCIA — id del propietario de los tickets gestionados por
//                         la asistente automatizada Lucía (opcional: si no
//                         está seteada, no se excluye nada — nunca falla).
//   HUBSPOT_CSAT_PROPERTY_VAR — nombre técnico (internal name) de la propiedad
//                         de CSAT vigente en HubSpot. Hay dos propiedades de
//                         CSAT y una está obsoleta — sin esta variable, CSAT
//                         y su distribución no se pueden calcular.

const HS_SEARCH_URL = 'https://api.hubapi.com/crm/v3/objects/tickets/search';

// ── Filtro base — MAPEO_CAMPOS_TABLA.md, "Filtro común a todas las métricas".
// Los 18 pipelines de soporte confirmados en el panel oficial de HubSpot,
// más el filtro "alguna vez ha sido" que trae ese mismo panel (dos pipelines
// por ID que ya no aparecen por nombre pero siguen relevantes para el
// histórico). Se toma tal cual viene del panel — no es una lista armada de
// memoria.
//
// OJO (corregido 27-ago-2026, vía HubSpot MCP): la propiedad de pipeline en
// el objeto Ticket es 'hs_pipeline', NO 'pipeline' (esa no existe). Y sus
// valores son los IDs numéricos del pipeline, no el nombre — filtrar por el
// nombre ('MEX_Sup', etc.) nunca iba a matchear nada. Los IDs de abajo se
// sacaron 1:1 de las opciones reales de 'hs_pipeline' en este portal.
const PIPELINES_SOPORTE = [
  '1857352', // MEX_Sup
  '2238445', // Acrecer_Sup
  '1857341', // COL_Sup
  '2236512', // Premium Sup (No transferir)
  '1940485', // Nómina_Sup
  '1940463', // Alianza de Pagos y Fintech
  '1940496', // Dentalink
  '1857358', // DOM_Sup
  '1855951', // Payments Sup
  '1940490', // POS_Sup
  '1936983', // Innpulsa_Sup
  '38406328', // Consultas API_Sup
  '97373833', // Solicitudes Partners_Sup
  '745378666', // Customer support
  '1940479', // Contador Sup
  '1940502', // Plan Fundaciones y Educación
  '2236244', // Alegra Tienda_Sup
  '99256347', // Integraciones_Sup
];
const PIPELINES_EVER_IN = ['2302067', '1857375'];

// ── Exclusión de rebotes (caso REVOPS-1324, confirmado 20-ago-2026).
const BOUNCE_EXCLUSION = {
  propertyName: 'hs_all_associated_contact_emails',
  operator: 'NEQ',
  value: 'mailer-daemon@amazonses.com',
};

// ── "Cerrado" = closed_date poblado (confirmado 21-ago-2026).
const CLOSED_FILTER = { propertyName: 'closed_date', operator: 'HAS_PROPERTY' };

// ── REOPEN — REVPYME-732 (Estefanía Messa). Solo cuenta 'Nueva consulta' en
// cualquiera de las dos propiedades ('Cierre agradecimiento' y 'Ambiguo' NO
// cuentan como reopen — confirmado en la sesión del 27-ago-2026, revisada en
// vivo con Estefanía y validada en 3,3% = 1.510/45.321).
const REOPEN_RETRO = { propertyName: 'reopen__retroactivo_tema_diferente', operator: 'EQ', value: 'Nueva consulta' };
const REOPEN_WF = { propertyName: 'ticket_reabierto__wf', operator: 'EQ', value: 'Nueva consulta' };

// ── Filtro base común a todas las consultas: pipelines de soporte (por
// nombre O por el filtro histórico "alguna vez ha sido"), rango de fecha de
// creación, exclusión de rebotes y exclusión de Lucía si está configurada.
function baseFilters(periodStart, periodEnd) {
  const filtros = [
    { propertyName: 'createdate', operator: 'GTE', value: periodStart },
    { propertyName: 'createdate', operator: 'LTE', value: periodEnd },
    BOUNCE_EXCLUSION,
  ];
  if (process.env.HUBSPOT_OWNER_LUCIA) {
    filtros.push({
      propertyName: 'hubspot_owner_id',
      operator: 'NEQ',
      value: process.env.HUBSPOT_OWNER_LUCIA,
    });
  }
  return filtros;
}

// El filtro de pipeline (por nombre O "alguna vez ha sido" por id) es un OR
// sobre la MISMA propiedad ('pipeline'), así que se expresa como un solo
// filtro IN con ambas listas juntas — no hace falta un filterGroup por
// alternativa. Esto es clave: HubSpot limita el total de filtros combinados
// en una sola consulta (visto en producción: máx. 18), y duplicar cada grupo
// por cada alternativa de pipeline se comía ese límite enseguida.
const PIPELINE_FILTER = { propertyName: 'hs_pipeline', operator: 'IN', values: [...PIPELINES_SOPORTE, ...PIPELINES_EVER_IN] };

// Un solo filterGroup: filtro base + pipeline + lo que se pida extra.
function pipelineFilterGroups(periodStart, periodEnd, extra = []) {
  const base = baseFilters(periodStart, periodEnd);
  return [{ filters: [...base, PIPELINE_FILTER, ...extra] }];
}

// Varios filterGroups, uno por cada alternativa en extraCombos (para el OR
// entre alternativas que no comparten la misma propiedad, ej. "el ticket
// reabrió por la propiedad retro O por la propiedad wf").
function pipelineFilterGroupsMulti(periodStart, periodEnd, extraCombos) {
  const base = baseFilters(periodStart, periodEnd);
  return extraCombos.map((combo) => ({ filters: [...base, PIPELINE_FILTER, ...combo] }));
}

// ── Freno de velocidad (3-sep-2026): con todo en vivo, un solo buildMetrics()
// dispara decenas/cientos de llamadas a la Search API (una por página de
// 100 tickets, por cada fetch* que corre en paralelo) — eso saturaba el
// límite POR SEGUNDO de la cuenta (429 RATE_LIMIT, "secondly limit"), no un
// límite total. La solución no es pedir menos datos, es pedirlos más
// despacio: TODAS las llamadas a HubSpot (search y owners) pasan por esta
// cola, que las espacía a un ritmo seguro y reintenta con espera creciente
// si de todos modos llega un 429. Es a propósito más lento — se prioriza
// que cargue bien sobre que cargue rápido.
// 3-sep-2026: bajado de 350 a 130ms (de ~3/seg a ~7.7/seg) -- el freno
// original era para el caso viejo de pedir TODO un rango en vivo (miles de
// llamadas casi simultáneas, ahí sí se pisaba el límite por segundo). Con
// los cubos, cada corrida de api/cubos-refrescar.mjs procesa un mes a la
// vez, así que hay margen para ir más rápido y aun así quedar bien por
// debajo del límite real de la cuenta (con el reintento de más abajo como
// red de seguridad si de todos modos llega un 429).
const HS_INTERVALO_MIN_MS = 130;
let hsUltimaLlamada = 0;
let hsCadena = Promise.resolve();

function hsEncolar(tarea) {
  const resultado = hsCadena.then(async () => {
    const espera = HS_INTERVALO_MIN_MS - (Date.now() - hsUltimaLlamada);
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    hsUltimaLlamada = Date.now();
    return tarea();
  });
  // Si una tarea falla, no debe trabar la cola para las que siguen.
  hsCadena = resultado.catch(() => {});
  return resultado;
}

async function hsFetchConReintento(hacerFetch, intentos = 0) {
  const res = await hacerFetch();
  if (res.status === 429 && intentos < 6) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const espera = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** intentos;
    await new Promise((r) => setTimeout(r, espera));
    return hsFetchConReintento(hacerFetch, intentos + 1);
  }
  return res;
}

async function hsSearch(token, body) {
  const res = await hsEncolar(() =>
    hsFetchConReintento(() =>
      fetch(HS_SEARCH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  );
  if (!res.ok) {
    // 3-sep-2026: HubSpot a veces devuelve un 400 sin detalle útil ("There
    // was a problem with the request"). Se adjunta el body exacto que se
    // mandó (sin el token) para poder ver, en el mismo mensaje de error que
    // ya se muestra en el tablero, cuál filtro/página lo causó -- sin eso,
    // cada intento de diagnóstico es una adivinanza más.
    const detalle = await res.text();
    const bodyLog = JSON.stringify({ ...body }).slice(0, 1500);
    throw new Error(`HubSpot search falló (${res.status}): ${detalle} — body: ${bodyLog}`);
  }
  return res.json();
}

async function searchTotal(token, filterGroups) {
  const data = await hsSearch(token, { limit: 1, filterGroups });
  return data.total ?? 0;
}

// Trae TODOS los tickets del rango con las propiedades pedidas, paginado
// (100 por página, límite real de la Search API). Necesario para tiempo de
// cierre, CSAT y distribución por versión: HubSpot no agrega en el servidor
// como Metabase, así que el promedio/agrupación se hace acá.
async function searchAll(token, filterGroups, properties) {
  const registros = [];
  let after;
  do {
    const body = { limit: 100, filterGroups, properties };
    if (after) body.after = after;
    const data = await hsSearch(token, body);
    registros.push(...(data.results ?? []));
    after = data.paging?.next?.after;
  } while (after);
  return registros;
}

// ── Límite duro de la Search API de HubSpot (3-sep-2026): no se puede
// paginar más allá de 10.000 resultados totales por consulta -- pasado ese
// techo, HubSpot responde 400 "There was a problem with the request" (sin
// más detalle). Con el tablero en vivo, traer TODO un año (40k+ tickets)
// de una sola consulta lo pisa siempre. La solución no es la Search API
// (no tiene forma de paginar más allá de eso) sino partir el rango pedido
// en trozos de un mes calendario -- cada mes de este tablero trae unos
// 5-6k tickets, bien por debajo del techo -- y juntar los resultados de
// cada trozo. searchAllPorMeses() es el reemplazo de searchAll() para
// cualquier consulta que pueda traer volumen alto en rangos amplios.
function trozosMensuales(periodStart, periodEnd) {
  const trozos = [];
  const inicioTotal = new Date(periodStart);
  const finTotal = new Date(periodEnd);
  let cursor = new Date(`${periodStart.slice(0, 10)}T00:00:00.000Z`);
  cursor.setUTCDate(1);
  while (cursor <= finTotal) {
    const anio = cursor.getUTCFullYear();
    const mes = cursor.getUTCMonth();
    const inicioMes = new Date(Date.UTC(anio, mes, 1));
    const finMes = new Date(Date.UTC(anio, mes + 1, 1) - 1);
    const inicio = (inicioMes > inicioTotal ? inicioMes : inicioTotal).toISOString();
    const fin = (finMes < finTotal ? finMes : finTotal).toISOString();
    trozos.push([inicio, fin]);
    cursor = new Date(Date.UTC(anio, mes + 1, 1));
  }
  return trozos.length ? trozos : [[periodStart, periodEnd]];
}

async function searchAllPorMeses(token, construirFilterGroups, properties, periodStart, periodEnd) {
  const trozos = trozosMensuales(periodStart, periodEnd);
  const porTrozo = await Promise.all(
    trozos.map(([inicio, fin]) => searchAll(token, construirFilterGroups(inicio, fin), properties))
  );
  return porTrozo.flat();
}

// Grupos (OR) para "el ticket reabrió": la propiedad retro dice 'Nueva
// consulta' O la propiedad wf dice 'Nueva consulta'. Se usa tanto para el
// KPI de reopen como, restándolo de cerrados, para FCR y tiempo de cierre —
// evita el combo NOT_HAS_PROPERTY/NEQ (que multiplicaba los filtros y hacía
// que HubSpot rechazara la consulta por exceso, "too many total filters").
function reabrioFilterGroups(periodStart, periodEnd, extra = []) {
  return pipelineFilterGroupsMulti(periodStart, periodEnd, [
    [...extra, REOPEN_RETRO],
    [...extra, REOPEN_WF],
  ]);
}

// ── FCR — anclado a closed_date (no a createdate), con ventana de maduración
// de 3 días (ajuste del 28-ago-2026, a raíz de la pregunta de Lauren Pacheco
// y confirmado por Breeze: anclar FCR a createdate mezcla tickets creados en
// el período con cierres/reaperturas que pueden ocurrir mucho después, lo
// que hace el indicador menos estable). La DEFINICIÓN de reopen no cambia —
// sigue siendo exactamente la de Estefanía (REOPEN_RETRO/REOPEN_WF,
// 'Nueva consulta' únicamente) — solo cambia el eje temporal y se agrega la
// ventana de maduración: un ticket cerrado hace menos de 3 días todavía no
// se cuenta como "resuelto en primer contacto" definitivo, porque podría
// reabrirse. 3 días porque es la misma ventana que ya usa la definición de
// reopen ("al menos 3 días después del cierre", ver MAPEO_CAMPOS_TABLA.md).
const FCR_VENTANA_MADURACION_DIAS = 3;

function baseFiltersClosedDate(periodStart, periodEnd) {
  const filtros = [
    { propertyName: 'closed_date', operator: 'GTE', value: periodStart },
    { propertyName: 'closed_date', operator: 'LTE', value: periodEnd },
    BOUNCE_EXCLUSION,
  ];
  if (process.env.HUBSPOT_OWNER_LUCIA) {
    filtros.push({
      propertyName: 'hubspot_owner_id',
      operator: 'NEQ',
      value: process.env.HUBSPOT_OWNER_LUCIA,
    });
  }
  return filtros;
}

function closedDateFilterGroupsMulti(periodStart, periodEnd, extraCombos) {
  const base = baseFiltersClosedDate(periodStart, periodEnd);
  return extraCombos.map((combo) => ({ filters: [...base, PIPELINE_FILTER, ...combo] }));
}

function closedDateFilterGroups(periodStart, periodEnd, extra = []) {
  const base = baseFiltersClosedDate(periodStart, periodEnd);
  return [{ filters: [...base, PIPELINE_FILTER, ...extra] }];
}

function closedDateReabrioFilterGroups(periodStart, periodEnd, extra = []) {
  return closedDateFilterGroupsMulti(periodStart, periodEnd, [
    [...extra, REOPEN_RETRO],
    [...extra, REOPEN_WF],
  ]);
}

// Recorta periodEnd a "hoy − 3 días" si el período pedido llega hasta hoy o
// más allá, para no contar como definitivos cierres demasiado recientes.
function finMaduro(periodEnd) {
  const madurez = new Date(Date.now() - FCR_VENTANA_MADURACION_DIAS * 24 * 3_600_000).toISOString();
  return periodEnd < madurez ? periodEnd : madurez;
}

export async function fetchHubspotMetrics({ token, periodStart, periodEnd }) {
  if (!token) throw new Error('Falta HUBSPOT_TOKEN');

  const finFcr = finMaduro(periodEnd);

  const [volumen, reopen, cerradosFcr, cerradosReabiertosFcr] = await Promise.all([
    searchTotal(token, pipelineFilterGroups(periodStart, periodEnd)),
    searchTotal(token, reabrioFilterGroups(periodStart, periodEnd)),
    // FCR: cerrados por closed_date (no createdate), solo hasta la fecha de
    // maduración — ver comentario arriba.
    searchTotal(token, closedDateFilterGroups(periodStart, finFcr)),
    // Cerrados que además reabrieron (mismo criterio de Estefanía), sobre el
    // mismo universo de closed_date. FCR = cerrados - cerradosReabiertos.
    searchTotal(token, closedDateReabrioFilterGroups(periodStart, finFcr)),
  ]);

  return {
    volumen,
    reopen,
    cerrados: cerradosFcr,
    fcr: Math.max(0, cerradosFcr - cerradosReabiertosFcr),
    fcrCerradosReabiertos: cerradosReabiertosFcr,
  };
}

// Tiempo de cierre promedio, en horas, excluyendo tickets reabiertos.
// Ya no sale de Metabase — se calcula acá con createdate/closed_date.
// Para excluir los reabiertos sin repetir el combo de filtros que HubSpot
// rechazaba, se traen los cerrados y, por separado, los ids de los cerrados
// que reabrieron, y se restan en memoria (ver fetchHubspotMetrics/FCR).
export async function fetchTiempoCierre({ token, periodStart, periodEnd }) {
  if (!token) throw new Error('Falta HUBSPOT_TOKEN');

  // OJO (3-sep-2026): el CLOSED_FILTER extra en la consulta de reabiertos
  // se quitó -- sumado a la base (createdate+rebote+Lucía) + pipeline +
  // reopen pasaba de los 6 filtros que permite HubSpot por grupo (error 400
  // "too many filters"). No hace falta: acá solo se usan los ids para
  // restarlos de 'cerrados' (que ya viene filtrado por cerrado+pipeline),
  // así que traer también reabiertos que no están cerrados no cambia el
  // resultado -- simplemente no van a matchear ningún id de 'cerrados'.
  const [cerrados, reabiertos] = await Promise.all([
    searchAllPorMeses(token, (i, f) => pipelineFilterGroups(i, f, [CLOSED_FILTER]), ['createdate', 'closed_date'], periodStart, periodEnd),
    searchAllPorMeses(token, (i, f) => reabrioFilterGroups(i, f), [], periodStart, periodEnd),
  ]);

  const idsReabiertos = new Set(reabiertos.map((t) => t.id));

  // Histograma de tiempo de cierre (en días) — antes salía de un corte fijo
  // de HubSpot MCP; ahora se calcula sobre los mismos tickets ya traídos
  // arriba, así que ya no hace falta una consulta aparte ni se limita al
  // corte completo: varía con el filtro de período como todo lo demás.
  const histograma = { menos_1: 0, de_1_a_3: 0, de_3_a_7: 0, de_7_a_14: 0, de_14_a_30: 0, mas_30: 0 };

  let sumaHoras = 0;
  let n = 0;
  for (const t of cerrados) {
    if (idsReabiertos.has(t.id)) continue;
    const inicio = t.properties?.createdate;
    const fin = t.properties?.closed_date;
    if (!inicio || !fin) continue;
    const horas = (new Date(fin) - new Date(inicio)) / 3_600_000;
    if (horas >= 0) {
      sumaHoras += horas;
      n += 1;
      const dias = horas / 24;
      if (dias < 1) histograma.menos_1 += 1;
      else if (dias < 3) histograma.de_1_a_3 += 1;
      else if (dias < 7) histograma.de_3_a_7 += 1;
      else if (dias < 14) histograma.de_7_a_14 += 1;
      else if (dias < 30) histograma.de_14_a_30 += 1;
      else histograma.mas_30 += 1;
    }
  }

  return { horas_promedio: n ? Number((sumaHoras / n).toFixed(1)) : 0, tickets_base: n, histograma, suma_horas: sumaHoras };
}

// CSAT — directo de HubSpot, ya no de Metabase. Requiere HUBSPOT_CSAT_PROPERTY_VAR
// (el nombre técnico exacto de la propiedad vigente — hay dos, una obsoleta).
// Filtro: la propiedad tiene valor ("CSAT es conocido") + fecha de la última
// encuesta dentro del rango. Ver MAPEO_CAMPOS_TABLA.md.
export async function fetchCsat({ token, periodStart, periodEnd }) {
  if (!token) throw new Error('Falta HUBSPOT_TOKEN');
  const csatProp = process.env.HUBSPOT_CSAT_PROPERTY_VAR;
  if (!csatProp) {
    throw new Error(
      'Falta HUBSPOT_CSAT_PROPERTY_VAR: el nombre técnico (internal name) de la propiedad de CSAT vigente en ' +
      'HubSpot. Se saca entrando a la configuración del reporte "Satisfacción" en HubSpot.'
    );
  }

  // OJO (corregido 27-ago-2026, vía HubSpot MCP): el nombre interno real es
  // 'fecha_de_la_ultima_encuestra_ces_csat' (con esa "r" de más) — no
  // 'fecha_ultima_encuesta_csat' como se había asumido.
  //
  // OJO (3-sep-2026): a propósito NO se usa pipelineFilterGroups() acá —
  // ese filtra además por createdate del ticket, y CSAT debe filtrarse
  // solo por cuándo se RESPONDIÓ la encuesta (ver METRICAS_TABLERO_SOPORTE.md:
  // "un ticket creado en julio puede aparecer en agosto si respondió la
  // encuesta ese mes"). Sumarle el filtro de createdate además del de la
  // encuesta también pasaba de 6 filtros en el mismo grupo (el máximo que
  // permite HubSpot), que era la causa del error 400 "too many filters".
  const filtrosBase = [BOUNCE_EXCLUSION];
  if (process.env.HUBSPOT_OWNER_LUCIA) {
    filtrosBase.push({ propertyName: 'hubspot_owner_id', operator: 'NEQ', value: process.env.HUBSPOT_OWNER_LUCIA });
  }
  const groups = [{
    filters: [
      ...filtrosBase,
      PIPELINE_FILTER,
      { propertyName: csatProp, operator: 'HAS_PROPERTY' },
      { propertyName: 'fecha_de_la_ultima_encuestra_ces_csat', operator: 'GTE', value: periodStart },
      { propertyName: 'fecha_de_la_ultima_encuestra_ces_csat', operator: 'LTE', value: periodEnd },
    ],
  }];

  const tickets = await searchAll(token, groups, [csatProp]);

  // Los valores reales de la propiedad en HubSpot están en inglés
  // (Promoter/Passive/Detractor) — confirmado en Configuración → Propiedades
  // → "Clasificación Encuesta CES-CSAT" → Descripciones de opciones, 27-ago-2026.
  const conteo = { Promoter: 0, Passive: 0, Detractor: 0 };
  for (const t of tickets) {
    const valor = t.properties?.[csatProp];
    if (valor && conteo[valor] !== undefined) conteo[valor] += 1;
  }
  const total = conteo.Promoter + conteo.Passive + conteo.Detractor;

  return {
    promoter: conteo.Promoter,
    passive: conteo.Passive,
    detractor: conteo.Detractor,
    total_respuestas: total,
    csat_pct: total ? Number(((conteo.Promoter / total) * 100).toFixed(1)) : 0,
  };
}

// Distribución por versión — hd_version, a nivel de ticket. Reemplaza al
// corte por país (ver MAPEO_CAMPOS_TABLA.md y PLAN_IMPLEMENTACION.md
// sección 6: ninguna propiedad de HubSpot cubre país de forma confiable
// para todos los tickets, así que ese corte se elimina del tablero).
export async function fetchDistribucionVersion({ token, periodStart, periodEnd }) {
  if (!token) throw new Error('Falta HUBSPOT_TOKEN');

  // OJO (corregido 27-ago-2026, vía HubSpot MCP): el nombre interno real es
  // 'version' ("HD - Versión") — 'hd_version' no existe como propiedad.
  const tickets = await searchAllPorMeses(token, (i, f) => pipelineFilterGroups(i, f), ['version', 'createdate', 'closed_date'], periodStart, periodEnd);

  const porVersion = new Map();
  for (const t of tickets) {
    const version = t.properties?.version || 'Sin versión';
    if (!porVersion.has(version)) porVersion.set(version, { tickets: 0, sumaHoras: 0, nCierre: 0 });
    const fila = porVersion.get(version);
    fila.tickets += 1;
    const inicio = t.properties?.createdate;
    const fin = t.properties?.closed_date;
    if (inicio && fin) {
      const horas = (new Date(fin) - new Date(inicio)) / 3_600_000;
      if (horas >= 0) {
        fila.sumaHoras += horas;
        fila.nCierre += 1;
      }
    }
  }

  const totalTickets = tickets.length;
  return [...porVersion.entries()]
    .map(([version, f]) => ({
      version,
      tickets: f.tickets,
      pct_total: totalTickets ? Number(((f.tickets / totalTickets) * 100).toFixed(1)) : 0,
      cierre_horas: f.nCierre ? Number((f.sumaHoras / f.nCierre).toFixed(1)) : 0,
      suma_horas: f.sumaHoras,
      n_cierre: f.nCierre,
    }))
    .sort((a, b) => b.tickets - a.tickets);
}

// Tendencia semanal — mismos campos que volumen y tiempo de cierre,
// agrupados por semana de createdate. Ya no sale de Metabase.
export async function fetchTendenciaSemanal({ token, periodStart, periodEnd }) {
  if (!token) throw new Error('Falta HUBSPOT_TOKEN');

  const tickets = await searchAllPorMeses(token, (i, f) => pipelineFilterGroups(i, f), ['createdate', 'closed_date'], periodStart, periodEnd);

  const porSemana = new Map(); // clave: lunes de la semana, formato YYYY-MM-DD
  for (const t of tickets) {
    const inicio = t.properties?.createdate;
    if (!inicio) continue;
    const d = new Date(inicio);
    const lunes = new Date(d);
    const dow = (d.getUTCDay() + 6) % 7; // 0 = lunes
    lunes.setUTCDate(d.getUTCDate() - dow);
    const clave = lunes.toISOString().slice(0, 10);

    if (!porSemana.has(clave)) porSemana.set(clave, { volumen: 0, sumaHoras: 0, nCierre: 0 });
    const fila = porSemana.get(clave);
    fila.volumen += 1;

    const fin = t.properties?.closed_date;
    if (fin) {
      const horas = (new Date(fin) - new Date(inicio)) / 3_600_000;
      if (horas >= 0) {
        fila.sumaHoras += horas;
        fila.nCierre += 1;
      }
    }
  }

  const semanas = [...porSemana.keys()].sort();
  return {
    weeks: semanas,
    volumes: semanas.map((s) => porSemana.get(s).volumen),
    close_hours: semanas.map((s) => {
      const f = porSemana.get(s);
      return f.nCierre ? Number((f.sumaHoras / f.nCierre).toFixed(1)) : 0;
    }),
    suma_horas: semanas.map((s) => porSemana.get(s).sumaHoras),
    n_cierre: semanas.map((s) => porSemana.get(s).nCierre),
  };
}

// ── Diario — usado por "Creados vs Cerrados" y "Tiempo a primera
// respuesta" (antes hardcodeado por HubSpot MCP, 31-ago-2026). Trae los
// tickets creados en el rango (con time_to_first_agent_reply) y los
// cerrados en el rango (por closed_date, sin ventana de maduración — acá
// interesa el cierre real de cada día, no si es "definitivo"), y los deja
// agrupados por día para que lib/metrics.mjs decida si mostrar un punto por
// mes o, si el rango cae en un solo mes, un desglose en bloques de 5 días.
export async function fetchDiario({ token, periodStart, periodEnd }) {
  if (!token) throw new Error('Falta HUBSPOT_TOKEN');

  const [creadosTickets, cerradosTickets] = await Promise.all([
    searchAllPorMeses(token, (i, f) => pipelineFilterGroups(i, f), ['createdate', 'time_to_first_agent_reply'], periodStart, periodEnd),
    searchAllPorMeses(token, (i, f) => closedDateFilterGroups(i, f), ['closed_date'], periodStart, periodEnd),
  ]);

  const creados = new Map(); // YYYY-MM-DD -> { n, sumaHoras, nHoras }
  for (const t of creadosTickets) {
    const fecha = t.properties?.createdate?.slice(0, 10);
    if (!fecha) continue;
    if (!creados.has(fecha)) creados.set(fecha, { n: 0, sumaHoras: 0, nHoras: 0 });
    const fila = creados.get(fecha);
    fila.n += 1;
    const msRespuesta = Number(t.properties?.time_to_first_agent_reply);
    if (msRespuesta > 0) {
      fila.sumaHoras += msRespuesta / 3_600_000;
      fila.nHoras += 1;
    }
  }

  const cerrados = new Map(); // YYYY-MM-DD -> n
  for (const t of cerradosTickets) {
    const fecha = t.properties?.closed_date?.slice(0, 10);
    if (!fecha) continue;
    cerrados.set(fecha, (cerrados.get(fecha) ?? 0) + 1);
  }

  return { creados, cerrados };
}

// ── Variación de desempeño por agente (antes hardcodeado por HubSpot MCP +
// search_owners, 30-ago-2026). reopens usa la misma definición de Estefanía
// (REOPEN_RETRO/REOPEN_WF, 'Nueva consulta' únicamente) sobre la cohorte de
// createdate, igual que el hardcode que reemplaza. ttc_dias = tiempo de
// cierre promedio de ese agente, en días.
export async function fetchNombresOwners(token, ownerIds) {
  const mapa = new Map();
  if (!ownerIds.length) return mapa;
  try {
    let after;
    do {
      const url = new URL('https://api.hubapi.com/crm/v3/owners');
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after', after);
      const res = await hsEncolar(() =>
        hsFetchConReintento(() => fetch(url, { headers: { Authorization: `Bearer ${token}` } }))
      );
      if (!res.ok) throw new Error(`Owners API falló (${res.status})`);
      const data = await res.json();
      for (const o of data.results ?? []) {
        const nombre = [o.firstName, o.lastName].filter(Boolean).join(' ').trim();
        mapa.set(String(o.id), nombre || o.email || `Owner ${o.id}`);
      }
      after = data.paging?.next?.after;
    } while (after);
  } catch {
    // Sin permiso/scope para la Owners API: se degrada a "Owner <id>" en vez
    // de tumbar todo el tablero.
    return new Map();
  }
  return mapa;
}

// Versión "cruda" -- sin filtrar por volumen mínimo ni resolver nombres --
// para que lib/cubos.mjs pueda guardar el aporte de UN mes por agente y
// sumarlo con el de otros meses antes de decidir quién pasa el umbral o
// pedir los nombres (eso se hace una sola vez, sobre el total ya
// combinado, en lib/metrics.mjs).
export async function fetchAgentesRaw({ token, periodStart, periodEnd }) {
  if (!token) throw new Error('Falta HUBSPOT_TOKEN');

  const [tickets, reabiertos] = await Promise.all([
    searchAllPorMeses(token, (i, f) => pipelineFilterGroups(i, f), ['hubspot_owner_id', 'createdate', 'closed_date'], periodStart, periodEnd),
    searchAllPorMeses(token, (i, f) => reabrioFilterGroups(i, f), [], periodStart, periodEnd),
  ]);
  const idsReabiertos = new Set(reabiertos.map((t) => t.id));

  const porAgente = new Map();
  for (const t of tickets) {
    const ownerId = t.properties?.hubspot_owner_id;
    if (!ownerId) continue;
    if (!porAgente.has(ownerId)) porAgente.set(ownerId, { volumen: 0, reopens: 0, sumaDias: 0, nCierre: 0 });
    const fila = porAgente.get(ownerId);
    fila.volumen += 1;
    if (idsReabiertos.has(t.id)) fila.reopens += 1;
    const inicio = t.properties?.createdate;
    const fin = t.properties?.closed_date;
    if (inicio && fin) {
      const dias = (new Date(fin) - new Date(inicio)) / 86_400_000;
      if (dias >= 0) {
        fila.sumaDias += dias;
        fila.nCierre += 1;
      }
    }
  }

  return [...porAgente.entries()].map(([ownerId, f]) => ({
    owner_id: ownerId,
    volumen: f.volumen,
    reopens: f.reopens,
    suma_dias: f.sumaDias,
    n_cierre: f.nCierre,
  }));
}

// Wrapper directo (sin pasar por cubos) -- se mantiene por si algo necesita
// pedirlo en vivo para un solo rango, con nombres ya resueltos.
export async function fetchAgentes({ token, periodStart, periodEnd, volumenMinimo = 100 }) {
  const crudo = await fetchAgentesRaw({ token, periodStart, periodEnd });
  const filtrados = crudo.filter((a) => a.volumen >= volumenMinimo);
  const nombres = await fetchNombresOwners(token, filtrados.map((a) => a.owner_id));

  return filtrados
    .map((a) => ({
      nombre: nombres.get(a.owner_id) ?? `Owner ${a.owner_id}`,
      volumen: a.volumen,
      reopens: a.reopens,
      reopen_pct: a.volumen ? Number(((a.reopens / a.volumen) * 100).toFixed(1)) : 0,
      ttc_dias: a.n_cierre ? Number((a.suma_dias / a.n_cierre).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.volumen - a.volumen);
}
