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
const PIPELINES_SOPORTE = [
  'MEX_Sup', 'Acrecer_Sup', 'COL_Sup', 'Premium Sup (No transferir)', 'Nómina_Sup',
  'Alianza de Pagos y Fintech', 'Dentalink', 'DOM_Sup', 'Payments Sup', 'POS_Sup',
  'Innpulsa_Sup', 'Consultas API_Sup', 'Solicitudes Partners_Sup', 'Customer support',
  'Contador Sup', 'Plan Fundaciones y Educación', 'Alegra Tienda_Sup', 'Integraciones_Sup',
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

// El filtro de pipeline se combina con el filtro base como filterGroups
// (OR entre "pipeline por nombre" y "pipeline alguna vez ha sido"), cada uno
// con el resto de condiciones repetidas — así HubSpot deduplica solo.
function pipelineFilterGroups(periodStart, periodEnd, extra = []) {
  const base = baseFilters(periodStart, periodEnd);
  return [
    { filters: [...base, { propertyName: 'pipeline', operator: 'IN', values: PIPELINES_SOPORTE }, ...extra] },
    { filters: [...base, { propertyName: 'pipeline', operator: 'IN', values: PIPELINES_EVER_IN }, ...extra] },
  ];
}

// Igual que pipelineFilterGroups, pero cuando la parte "extra" en sí misma
// tiene alternativas OR (ej. "la propiedad está vacía O es distinta de X").
// extraCombos es un array de arrays de filtros; se cruza cada combo con los
// dos pipelines alternativos → cross product completo.
function pipelineFilterGroupsMulti(periodStart, periodEnd, extraCombos) {
  const base = baseFilters(periodStart, periodEnd);
  const pipelines = [
    { propertyName: 'pipeline', operator: 'IN', values: PIPELINES_SOPORTE },
    { propertyName: 'pipeline', operator: 'IN', values: PIPELINES_EVER_IN },
  ];
  const groups = [];
  for (const pipelineFiltro of pipelines) {
    for (const combo of extraCombos) {
      groups.push({ filters: [...base, pipelineFiltro, ...combo] });
    }
  }
  return groups;
}

// Cruce cartesiano de condiciones OR: cada argumento es un array de
// alternativas (arrays de filtros); devuelve todas las combinaciones AND
// posibles entre una alternativa de cada grupo.
function crossFilters(...orGroups) {
  let combos = [[]];
  for (const group of orGroups) {
    const next = [];
    for (const combo of combos) {
      for (const alternativa of group) next.push([...combo, ...alternativa]);
    }
    combos = next;
  }
  return combos;
}

// HubSpot: NEQ no matchea una propiedad vacía (la trata como "no comparable",
// no como "distinta"). Para expresar "no dice 'Nueva consulta'" (que debe
// incluir tanto vacío como cualquier otro valor) hace falta el OR explícito:
// propiedad sin valor, O propiedad con un valor distinto.
const noEsNuevaConsulta = (propertyName) => [
  [{ propertyName, operator: 'NOT_HAS_PROPERTY' }],
  [{ propertyName, operator: 'NEQ', value: 'Nueva consulta' }],
];

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

export async function fetchHubspotMetrics({ token, periodStart, periodEnd }) {
  if (!token) throw new Error('Falta HUBSPOT_TOKEN');

  const groups = (extra = []) => pipelineFilterGroups(periodStart, periodEnd, extra);

  const [volumen, reopen, cerrados, fcr] = await Promise.all([
    searchTotal(token, groups()),

    // REOPEN_RETRO y REOPEN_WF también van como filterGroups separados (OR),
    // multiplicados por el OR de pipeline — HubSpot dedupe todo junto.
    searchTotal(token, [
      ...groups([REOPEN_RETRO]),
      ...groups([REOPEN_WF]),
    ]),

    searchTotal(token, groups([CLOSED_FILTER])),

    // FCR: cerrados donde NINGUNA de las dos propiedades de reopen diga
    // 'Nueva consulta'. Ver MAPEO_CAMPOS_TABLA.md: no es "vacías", es "no
    // dice Nueva consulta" — un 'Cierre agradecimiento' sigue contando como
    // FCR. Usa el combo vacío-o-distinto porque NEQ solo no matchea vacíos.
    searchTotal(token, pipelineFilterGroupsMulti(periodStart, periodEnd,
      crossFilters(
        [[CLOSED_FILTER]],
        noEsNuevaConsulta('reopen__retroactivo_tema_diferente'),
        noEsNuevaConsulta('ticket_reabierto__wf'),
      ),
    )),
  ]);

  return { volumen, reopen, cerrados, fcr };
}

// Tiempo de cierre promedio, en horas, excluyendo tickets reabiertos.
// Ya no sale de Metabase — se calcula acá con createdate/closed_date.
export async function fetchTiempoCierre({ token, periodStart, periodEnd }) {
  if (!token) throw new Error('Falta HUBSPOT_TOKEN');

  const groups = pipelineFilterGroupsMulti(periodStart, periodEnd,
    crossFilters(
      [[CLOSED_FILTER]],
      noEsNuevaConsulta('reopen__retroactivo_tema_diferente'),
      noEsNuevaConsulta('ticket_reabierto__wf'),
    ),
  );

  const tickets = await searchAll(token, groups, ['createdate', 'closed_date']);

  let sumaHoras = 0;
  let n = 0;
  for (const t of tickets) {
    const inicio = t.properties?.createdate;
    const fin = t.properties?.closed_date;
    if (!inicio || !fin) continue;
    const horas = (new Date(fin) - new Date(inicio)) / 3_600_000;
    if (horas >= 0) {
      sumaHoras += horas;
      n += 1;
    }
  }

  return { horas_promedio: n ? Number((sumaHoras / n).toFixed(1)) : 0, tickets_base: n };
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

  const groups = pipelineFilterGroups(periodStart, periodEnd, [
    { propertyName: csatProp, operator: 'HAS_PROPERTY' },
    { propertyName: 'fecha_ultima_encuesta_csat', operator: 'GTE', value: periodStart },
    { propertyName: 'fecha_ultima_encuesta_csat', operator: 'LTE', value: periodEnd },
  ]);

  const tickets = await searchAll(token, groups, [csatProp]);

  const conteo = { Promotor: 0, Neutro: 0, Detractor: 0 };
  for (const t of tickets) {
    const valor = t.properties?.[csatProp];
    if (valor && conteo[valor] !== undefined) conteo[valor] += 1;
  }
  const total = conteo.Promotor + conteo.Neutro + conteo.Detractor;

  return {
    promoter: conteo.Promotor,
    passive: conteo.Neutro,
    detractor: conteo.Detractor,
    total_respuestas: total,
    csat_pct: total ? Number(((conteo.Promotor / total) * 100).toFixed(1)) : 0,
  };
}

// Distribución por versión — hd_version, a nivel de ticket. Reemplaza al
// corte por país (ver MAPEO_CAMPOS_TABLA.md y PLAN_IMPLEMENTACION.md
// sección 6: ninguna propiedad de HubSpot cubre país de forma confiable
// para todos los tickets, así que ese corte se elimina del tablero).
export async function fetchDistribucionVersion({ token, periodStart, periodEnd }) {
  if (!token) throw new Error('Falta HUBSPOT_TOKEN');

  const groups = pipelineFilterGroups(periodStart, periodEnd);
  const tickets = await searchAll(token, groups, ['hd_version', 'createdate', 'closed_date']);

  const porVersion = new Map();
  for (const t of tickets) {
    const version = t.properties?.hd_version || 'Sin versión';
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
