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
//   HUBSPOT_CSAT_PROPERTY — nombre técnico (internal name) de la propiedad
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

async function hsSearch(token, body) {
  const res = await fetch(HS_SEARCH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`HubSpot search falló (${res.status}): ${await res.text()}`);
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

  const [cerrados, reabiertos] = await Promise.all([
    searchAll(token, pipelineFilterGroups(periodStart, periodEnd, [CLOSED_FILTER]), ['createdate', 'closed_date']),
    searchAll(token, reabrioFilterGroups(periodStart, periodEnd, [CLOSED_FILTER]), []),
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

  return { horas_promedio: n ? Number((sumaHoras / n).toFixed(1)) : 0, tickets_base: n, histograma };
}

// CSAT — directo de HubSpot, ya no de Metabase. Requiere HUBSPOT_CSAT_PROPERTY
// (el nombre técnico exacto de la propiedad vigente — hay dos, una obsoleta).
// Filtro: la propiedad tiene valor ("CSAT es conocido") + fecha de la última
// encuesta dentro del rango. Ver MAPEO_CAMPOS_TABLA.md.
export async function fetchCsat({ token, periodStart, periodEnd }) {
  if (!token) throw new Error('Falta HUBSPOT_TOKEN');
  const csatProp = process.env.HUBSPOT_CSAT_PROPERTY;
  if (!csatProp) {
    throw new Error(
      'Falta HUBSPOT_CSAT_PROPERTY: el nombre técnico (internal name) de la propiedad de CSAT vigente en ' +
      'HubSpot. Se saca entrando a la configuración del reporte "Satisfacción" en HubSpot.'
    );
  }

  // OJO (corregido 27-ago-2026, vía HubSpot MCP): el nombre interno real es
  // 'fecha_de_la_ultima_encuestra_ces_csat' (con esa "r" de más) — no
  // 'fecha_ultima_encuesta_csat' como se había asumido.
  const groups = pipelineFilterGroups(periodStart, periodEnd, [
    { propertyName: csatProp, operator: 'HAS_PROPERTY' },
    { propertyName: 'fecha_de_la_ultima_encuestra_ces_csat', operator: 'GTE', value: periodStart },
    { propertyName: 'fecha_de_la_ultima_encuestra_ces_csat', operator: 'LTE', value: periodEnd },
  ]);

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
  const groups = pipelineFilterGroups(periodStart, periodEnd);
  const tickets = await searchAll(token, groups, ['version', 'createdate', 'closed_date']);

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
    }))
    .sort((a, b) => b.tickets - a.tickets);
}

// Tendencia semanal — mismos campos que volumen y tiempo de cierre,
// agrupados por semana de createdate. Ya no sale de Metabase.
export async function fetchTendenciaSemanal({ token, periodStart, periodEnd }) {
  if (!token) throw new Error('Falta HUBSPOT_TOKEN');

  const groups = pipelineFilterGroups(periodStart, periodEnd);
  const tickets = await searchAll(token, groups, ['createdate', 'closed_date']);

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
    searchAll(token, pipelineFilterGroups(periodStart, periodEnd), ['createdate', 'time_to_first_agent_reply']),
    searchAll(token, closedDateFilterGroups(periodStart, periodEnd), ['closed_date']),
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
async function fetchNombresOwners(token, ownerIds) {
  const mapa = new Map();
  if (!ownerIds.length) return mapa;
  try {
    let after;
    do {
      const url = new URL('https://api.hubapi.com/crm/v3/owners');
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after', after);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
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

export async function fetchAgentes({ token, periodStart, periodEnd, volumenMinimo = 100 }) {
  if (!token) throw new Error('Falta HUBSPOT_TOKEN');

  const [tickets, reabiertos] = await Promise.all([
    searchAll(token, pipelineFilterGroups(periodStart, periodEnd), ['hubspot_owner_id', 'createdate', 'closed_date']),
    searchAll(token, reabrioFilterGroups(periodStart, periodEnd), []),
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

  const ownerIds = [...porAgente.keys()].filter((id) => porAgente.get(id).volumen >= volumenMinimo);
  const nombres = await fetchNombresOwners(token, ownerIds);

  return ownerIds
    .map((id) => {
      const f = porAgente.get(id);
      return {
        nombre: nombres.get(id) ?? `Owner ${id}`,
        volumen: f.volumen,
        reopens: f.reopens,
        reopen_pct: f.volumen ? Number(((f.reopens / f.volumen) * 100).toFixed(1)) : 0,
        ttc_dias: f.nCierre ? Number((f.sumaDias / f.nCierre).toFixed(1)) : 0,
      };
    })
    .sort((a, b) => b.volumen - a.volumen);
}
