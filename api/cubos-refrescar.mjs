// GET/POST /api/cubos-refrescar
//
// Recalcula en vivo (contra HubSpot) los cubos mensuales que todavía
// pueden cambiar, y de paso rellena cualquier cubo viejo que falte -- ver
// lib/cubos.mjs para la explicación completa de por qué existen los cubos.
// Lo dispara el cron diario de Vercel (ver vercel.json). También se puede
// llamar a mano para forzar un refresco fuera de horario.
//
// Por defecto solo el mes en curso se re-calcula cada corrida -- pedido de
// Noa, 3-sep-2026: los tickets casi nunca se reabren o cierran más de un
// par de meses después de creados, así que no hace falta volver a
// preguntarle a HubSpot por meses que ya "cerraron" hace rato
// (mesEstable() en lib/cubos.mjs, 60 días de margen). Los meses estables
// se leen del KV si ya existen, o se calculan una sola vez si faltan
// (primer arranque / backfill del histórico).
//
// SEGURIDAD: igual que /api/snapshot -- exige Authorization: Bearer
// <CRON_SECRET>, y se niega a correr si esa variable no está configurada.

import { mesesEnRango } from '../lib/fechas.mjs';
import { obtenerCubo, mesEstable } from '../lib/cubos.mjs';

function inicioAnioActual() {
  return `${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(500).json({
      error: 'Falta CRON_SECRET en las variables de entorno del proyecto. Este endpoint no corre sin él.',
    });
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'Falta HUBSPOT_TOKEN' });
  }

  const start = inicioAnioActual();
  const end = new Date().toISOString();
  const meses = mesesEnRango(start, end);

  const resultados = [];
  // Secuencial a propósito -- son pocos meses (12 como máximo) y así el
  // log queda ordenado y el tiempo total es predecible; los meses estables
  // ya cacheados son casi instantáneos, solo los 1-2 recientes tardan.
  for (const mes of meses) {
    const forzar = !mesEstable(mes.fin);
    const inicioTarea = Date.now();
    try {
      const cubo = await obtenerCubo(mes, token, { forzar });
      resultados.push({
        mes: mes.id,
        forzado: forzar,
        ok: true,
        ms: Date.now() - inicioTarea,
        volumen: cubo.hs.volumen,
      });
    } catch (e) {
      resultados.push({ mes: mes.id, forzado: forzar, ok: false, ms: Date.now() - inicioTarea, error: String(e.message ?? e) });
    }
  }

  const conError = resultados.filter((r) => !r.ok);
  return res.status(conError.length ? 207 : 200).json({
    ok: conError.length === 0,
    meses_procesados: resultados.length,
    meses_con_error: conError.length,
    resultados,
  });
}
