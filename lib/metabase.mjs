// lib/metabase.mjs
//
// Trae de Metabase los KPIs que salen de ahí: tiempo de cierre promedio,
// CSAT, tickets y horas de cierre por país, y tendencia semanal.
//
// Variables de entorno requeridas:
//   METABASE_URL      → ej. https://metabase.alegra.com (sin barra final)
//   METABASE_API_KEY  → API key de Metabase (Settings → Authentication → API keys)
//
// ── POR QUÉ ESTE CÓDIGO SE VE MÁS COMPLICADO DE LO ESPERADO ────────────────
//
// 1) No se usa SQL. El usuario de Metabase de este portal NO tiene permiso
//    para correr queries nativas ("You do not have permission to run native
//    queries against this database"), así que todo va en MBQL, el formato de
//    query estructurada de Metabase, vía POST /api/dataset.
//
// 2) MBQL identifica tablas y columnas por ID NUMÉRICO, no por nombre. Esos
//    IDs son propios de cada instancia de Metabase y pueden cambiar si la
//    tabla se re-sincroniza. Por eso este módulo los resuelve en tiempo de
//    ejecución a partir de los nombres (base "Viz" → schema
//    dm_customer_experience → tabla bi_ce_interactions) y los cachea en
//    memoria del proceso. Hardcodearlos sería más corto pero se rompería en
//    silencio, devolviendo datos de otra tabla o un error opaco.

const TABLE = {
  database: 'Viz',
  schema: 'dm_customer_experience',
  table: 'bi_ce_interactions',
};

// Cache de IDs a nivel de módulo. Vercel reutiliza el proceso entre
// invocaciones cercanas (warm start), así que esto evita repetir las llamadas
// de metadata en cada request.
let schemaCache = null;

function baseUrl() {
  const url = process.env.METABASE_URL;
  if (!url) throw new Error('Falta METABASE_URL');
  return url.replace(/\/+$/, '');
}

// ── Autenticación ──────────────────────────────────────────────────────────
//
// Metabase soporta dos formas y no todas las instancias tienen las dos:
//
//   1) API key (header x-api-key). Es lo preferible, no expira. Solo existe
//      desde Metabase 0.49, y esas keys siempre empiezan con "mb_".
//   2) Sesión (header X-Metabase-Session), que se obtiene haciendo login con
//      usuario y contraseña contra POST /api/session. El token expira (por
//      defecto a los 14 días), así que hay que renovarlo.
//
// Se usa la que esté configurada: si hay METABASE_API_KEY va por API key; si
// hay METABASE_USER + METABASE_PASSWORD va por sesión. Si están las dos, gana
// la API key.
let sessionTokenCache = null;

async function obtenerSessionToken() {
  if (sessionTokenCache) return sessionTokenCache;

  const username = process.env.METABASE_USER;
  const password = process.env.METABASE_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'Metabase no tiene credenciales utilizables: definí METABASE_API_KEY (una key que empiece con "mb_"), ' +
      'o bien METABASE_USER y METABASE_PASSWORD para autenticar por sesión.'
    );
  }

  const res = await fetch(`${baseUrl()}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new Error(`Login en Metabase falló (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const { id } = await res.json();
  if (!id) throw new Error('Metabase no devolvió token de sesión');
  sessionTokenCache = id;
  return id;
}

async function authHeaders() {
  const key = process.env.METABASE_API_KEY;
  if (key) return { 'x-api-key': key };
  return { 'X-Metabase-Session': await obtenerSessionToken() };
}

async function mbFetch(path, init = {}, reintento = false) {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()), ...(init.headers ?? {}) },
  });

  // Un 401 con sesión suele significar que el token expiró: se descarta y se
  // reintenta una vez con uno nuevo. Con API key no tiene sentido reintentar.
  if (res.status === 401 && !process.env.METABASE_API_KEY && !reintento) {
    sessionTokenCache = null;
    return mbFetch(path, init, true);
  }

  if (!res.ok) {
    const detalle = (await res.text()).slice(0, 300);
    const pista = res.status === 401
      ? ' — credencial rechazada. Si estás usando METABASE_API_KEY, verificá que sea una API key de Metabase (empiezan con "mb_") y que tu instancia sea 0.49 o superior; si no, usá METABASE_USER + METABASE_PASSWORD.'
      : res.status === 403
        ? ' — autenticó bien pero al usuario le faltan permisos sobre esta base o tabla.'
        : '';
    throw new Error(`Metabase ${init.method ?? 'GET'} ${path} falló (${res.status}): ${detalle}${pista}`);
  }
  return res.json();
}

const mbGet = (path) => mbFetch(path);
const mbPost = (path, body) => mbFetch(path, { method: 'POST', body: JSON.stringify(body) });

// Resuelve database_id, table_id y los field_id de las columnas que usamos.
export async function resolveSchema() {
  if (schemaCache) return schemaCache;

  const databases = await mbGet('/api/database');
  const dbList = Array.isArray(databases) ? databases : (databases.data ?? []);
  const db = dbList.find((d) => d.name === TABLE.database);
  if (!db) {
    throw new Error(`No se encontró la base "${TABLE.database}" en Metabase. Bases visibles: ${dbList.map((d) => d.name).join(', ')}`);
  }

  // include=tables trae las tablas junto con la metadata de la base.
  const meta = await mbGet(`/api/database/${db.id}/metadata`);
  const table = (meta.tables ?? []).find(
    (t) => t.name === TABLE.table && (!t.schema || t.schema === TABLE.schema)
  );
  if (!table) {
    throw new Error(`No se encontró la tabla ${TABLE.schema}.${TABLE.table} en la base "${TABLE.database}".`);
  }

  const fieldByName = {};
  for (const f of table.fields ?? []) fieldByName[f.name] = f.id;

  const required = ['channel', 'created_at', 'closed_at', 'time_to_close_seconds', 'country', 'csat_classification'];
  const missing = required.filter((n) => !fieldByName[n]);
  if (missing.length) {
    throw new Error(`Faltan columnas en ${TABLE.table}: ${missing.join(', ')}`);
  }

  schemaCache = { databaseId: db.id, tableId: table.id, fields: fieldByName };
  return schemaCache;
}

// ── Helpers para construir MBQL ────────────────────────────────────────────
const field = (id, opts) => (opts ? ['field', id, opts] : ['field', id, null]);

function baseFilters(f, periodStart, periodEnd) {
  return [
    'and',
    ['=', field(f.channel), 'ticket'],
    ['>=', field(f.created_at), periodStart],
    ['<=', field(f.created_at), periodEnd],
  ];
}

async function runQuery({ databaseId, tableId, query }) {
  const payload = {
    database: databaseId,
    type: 'query',
    query: { 'source-table': tableId, ...query },
  };
  const result = await mbPost('/api/dataset', payload);
  if (result.status === 'failed') {
    throw new Error(`Consulta de Metabase falló: ${result.error ?? 'sin detalle'}`);
  }
  return result.data?.rows ?? [];
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fechaCorta = (iso) => {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MESES[d.getUTCMonth()]}`;
};

// Códigos de país → nombres que usa el dashboard. Los que no están acá
// (USA, ESP, null...) se ignoran a propósito: no aparecen en el tablero.
const PAISES = {
  COL: 'Colombia',
  DOM: 'Rep. Dominicana',
  MEX: 'México',
  CRI: 'Costa Rica',
  ARG: 'Argentina',
  PAN: 'Panamá',
  PER: 'Perú',
};

export async function fetchMetabaseMetrics({ periodStart, periodEnd }) {
  const { databaseId, tableId, fields: f } = await resolveSchema();
  const ctx = { databaseId, tableId };
  const filtro = baseFilters(f, periodStart, periodEnd);

  // Las 4 consultas son independientes → en paralelo.
  const [cierreRows, csatRows, paisRows, semanaRows] = await Promise.all([
    // a) Tiempo de cierre promedio (solo tickets ya cerrados)
    runQuery({
      ...ctx,
      query: {
        filter: [...filtro, ['not-null', field(f.closed_at)]],
        aggregation: [['count'], ['avg', field(f.time_to_close_seconds)]],
      },
    }),

    // b) CSAT, desglosado por clasificación
    runQuery({
      ...ctx,
      query: {
        filter: [...filtro, ['not-null', field(f.csat_classification)]],
        aggregation: [['count']],
        breakout: [field(f.csat_classification)],
      },
    }),

    // c) País: tickets y horas de cierre en una sola pasada
    runQuery({
      ...ctx,
      query: {
        filter: filtro,
        aggregation: [['count'], ['avg', field(f.time_to_close_seconds)]],
        breakout: [field(f.country)],
      },
    }),

    // d) Tendencia semanal (temporal-unit week agrupa por semana)
    runQuery({
      ...ctx,
      query: {
        filter: filtro,
        aggregation: [['count'], ['avg', field(f.time_to_close_seconds)]],
        breakout: [field(f.created_at, { 'temporal-unit': 'week' })],
      },
    }),
  ]);

  // ── a) tiempo de cierre
  const [cierreCount, cierreAvgSeg] = cierreRows[0] ?? [0, 0];
  const tiempo_cierre = {
    horas_promedio: cierreAvgSeg ? Number((cierreAvgSeg / 3600).toFixed(1)) : 0,
    tickets_base: cierreCount ?? 0,
  };

  // ── b) CSAT
  const csat = { promoter: 0, passive: 0, detractor: 0 };
  for (const [clasificacion, n] of csatRows) {
    const k = String(clasificacion ?? '').toLowerCase();
    if (k === 'promoter') csat.promoter = n;
    else if (k === 'passive') csat.passive = n;
    else if (k === 'detractor') csat.detractor = n;
  }

  // ── c) país
  const por_pais_tickets = {};
  const por_pais_horas = {};
  for (const [codigo, n, avgSeg] of paisRows) {
    const nombre = PAISES[codigo];
    if (!nombre) continue; // ignora países fuera del tablero y los NULL
    por_pais_tickets[nombre] = n;
    por_pais_horas[nombre] = avgSeg ? Number((avgSeg / 3600).toFixed(1)) : 0;
  }

  // ── d) tendencia semanal
  const semanas = semanaRows
    .filter((r) => r[0])
    .map(([semana, n, avgSeg]) => ({
      week: fechaCorta(semana),
      volume: n ?? 0,
      close_hours: avgSeg ? Number((avgSeg / 3600).toFixed(1)) : 0,
    }));

  // Las últimas semanas suelen estar incompletas: los tickets recién creados
  // todavía no han tenido tiempo de cerrarse, así que su "horas hasta cierre"
  // se ve artificialmente bajo y su volumen incompleto. Se marcan para que el
  // dashboard las pinte en gris, en vez de leerse como una mejora real.
  // Criterio: una semana reciente con menos del 40% del volumen promedio de
  // las anteriores está incompleta.
  let censured_from_index = semanas.length;
  if (semanas.length >= 4) {
    const previas = semanas.slice(0, -3);
    const promedio = previas.reduce((a, s) => a + s.volume, 0) / (previas.length || 1);
    for (let i = Math.max(0, semanas.length - 3); i < semanas.length; i++) {
      if (semanas[i].volume < promedio * 0.4) {
        censured_from_index = i;
        break;
      }
    }
  }

  return {
    tiempo_cierre,
    csat,
    por_pais_tickets,
    por_pais_horas,
    tendencia_semanal: {
      weeks: semanas.map((s) => s.week),
      volumes: semanas.map((s) => s.volume),
      close_hours: semanas.map((s) => s.close_hours),
      censured_from_index,
    },
  };
}
