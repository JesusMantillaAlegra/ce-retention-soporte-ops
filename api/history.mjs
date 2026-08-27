// GET /api/history
//
// Devuelve el array de snapshots acumulados (el histórico), que es lo que
// alimenta el filtro de fecha del dashboard. Cada snapshot es una foto
// completa del tablero tal como estaba ese día.
//
// Si el histórico todavía está vacío (o KV no está configurado) devuelve un
// array vacío en vez de un error: el dashboard tiene que poder mostrar la
// foto en vivo aunque el histórico no exista todavía.

import { leerHistorico } from '../lib/store.mjs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const historico = await leerHistorico();
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json(historico);
  } catch (e) {
    // Degradar con elegancia: sin histórico el tablero sigue sirviendo, solo
    // sin el selector de periodos.
    console.error('No se pudo leer el histórico:', e);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json([]);
  }
}
