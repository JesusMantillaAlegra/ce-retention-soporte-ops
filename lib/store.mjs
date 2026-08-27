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

function kvConfig() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      'Falta la integración de Vercel KV (no hay KV_REST_API_URL / KV_REST_API_TOKEN). ' +
      'Crear el store en el dashboard de Vercel: Storage → KV → conectar al proyecto.'
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
