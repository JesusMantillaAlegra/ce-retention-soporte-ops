// lib/store.mjs
//
// Guarda y lee el histórico de snapshots. Vercel no tiene disco persistente
// (cada invocación arranca en limpio), así que el histórico vive en Vercel KV
// (Redis) bajo una sola clave con el array completo de snapshots.
//
// Por qué KV y no Postgres: el patrón de uso es "leer todo, agregar uno", un
// snapshot por semana (~50 al año, unos pocos KB cada uno). No hace falta SQL
// ni esquema. Si algún día se necesita cruzar el histórico con otras tablas,
// migrar de acá a Postgres es directo.
//
// Requiere la integración de KV en el proyecto de Vercel, que inyecta sola
// las variables KV_REST_API_URL y KV_REST_API_TOKEN.

const KEY = 'ce-retention:history';

// Los nombres de las variables dependen del proveedor de Redis que se conecte
// desde el Marketplace de Vercel: la integración clásica de Vercel KV inyecta
// KV_REST_API_*, mientras que conectar Upstash directamente inyecta
// UPSTASH_REDIS_REST_*. Ambas exponen la misma API REST (/get/clave y
// /set/clave), así que se acepta cualquiera de las dos y el resto del código
// no se enteran de la diferencia.
function kvConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      'No hay store de Redis conectado. Faltan KV_REST_API_URL / KV_REST_API_TOKEN ' +
      '(o UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN). ' +
      'Conectarlo en Vercel: pestaña Storage → Create Database → un proveedor de Redis → Connect al proyecto. ' +
      'Después hay que re-desplegar para que las variables entren.'
    );
  }
  return { url: url.replace(/\/+$/, ''), token };
}

async function kvFetch(path, init = {}) {
  const { url, token } = kvConfig();
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Vercel KV ${path} falló (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

export async function leerHistorico() {
  const out = await kvFetch(`/get/${encodeURIComponent(KEY)}`);
  if (!out?.result) return [];
  try {
    // KV devuelve el valor como string; puede venir doblemente serializado
    // según cómo se haya escrito, así que se maneja ambos casos.
    const parsed = typeof out.result === 'string' ? JSON.parse(out.result) : out.result;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function escribirHistorico(historico) {
  await kvFetch(`/set/${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(historico),
  });
}

// Agrega un snapshot al histórico. Nunca borra snapshots de días anteriores;
// si ya existe uno con el mismo snapshot_id (misma fecha), lo REEMPLAZA — así
// correr el proceso dos veces el mismo día no duplica la entrada.
export async function guardarSnapshot({ snapshotId, data }) {
  const historico = await leerHistorico();
  const snapshot = { snapshot_id: snapshotId, capturado_en: new Date().toISOString(), ...data };

  const i = historico.findIndex((h) => h.snapshot_id === snapshotId);
  if (i >= 0) historico[i] = snapshot;
  else historico.push(snapshot);

  historico.sort((a, b) => String(a.snapshot_id).localeCompare(String(b.snapshot_id)));
  await escribirHistorico(historico);

  return { total: historico.length, reemplazado: i >= 0 };
}

// Reemplaza el histórico completo. Solo se usa para sembrar los snapshots que
// ya existían en el repo antes de mover esto a Vercel (ver /api/seed).
export async function reemplazarHistorico(historico) {
  await escribirHistorico(historico);
  return { total: historico.length };
}

// ── Cubos mensuales (3-sep-2026, ver lib/cubos.mjs) — un cubo por mes
// calendario, guardado bajo su propia clave ('ce-retention:cubo:YYYY-MM')
// en vez de un solo array grande como el histórico: así leer/escribir un
// mes no toca los demás.
const PREFIJO_CUBO = 'ce-retention:cubo:';

export async function obtenerCubo(mesId) {
  try {
    const out = await kvFetch(`/get/${encodeURIComponent(PREFIJO_CUBO + mesId)}`);
    if (!out?.result) return null;
    return typeof out.result === 'string' ? JSON.parse(out.result) : out.result;
  } catch {
    // KV no conectado o clave corrupta: se trata como "no hay cubo todavía"
    // y lib/cubos.mjs lo recalcula en vivo -- nunca tumba el tablero.
    return null;
  }
}

export async function guardarCubo(mesId, data) {
  await kvFetch(`/set/${encodeURIComponent(PREFIJO_CUBO + mesId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}
