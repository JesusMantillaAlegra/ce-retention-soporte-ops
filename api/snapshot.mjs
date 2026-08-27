// POST/GET /api/snapshot
//
// Calcula las métricas y guarda la foto de hoy en el histórico. Lo dispara el
// cron de Vercel cada miércoles 8:30 AM Bogotá (ver vercel.json) — reemplaza
// por completo a la tarea programada de Claude y al .bat local: ya no depende
// de que ningún computador esté encendido.
//
// También se puede llamar a mano para forzar un snapshot fuera de horario.
//
// SEGURIDAD: este endpoint ESCRIBE, así que exige el header
// Authorization: Bearer <CRON_SECRET>. Vercel manda ese header solo en las
// llamadas de su cron si la env var CRON_SECRET está definida en el proyecto.
// Sin CRON_SECRET configurado, el endpoint se niega a correr — a propósito:
// preferimos que falle visiblemente antes que quedar abierto a cualquiera.

import { buildMetrics, validarMetrics, hoyBogota } from '../lib/metrics.mjs';
import { guardarSnapshot } from '../lib/store.mjs';

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

  try {
    const data = await buildMetrics();
    const problemas = validarMetrics(data);

    // Acá sí se corta: un snapshot es permanente y va a quedar en el
    // histórico para siempre. Es mucho peor guardar una foto rota (que después
    // ensucia todas las comparaciones mes a mes) que saltarse una semana.
    if (problemas.length) {
      return res.status(422).json({
        error: 'Los datos no pasaron la validación — NO se guardó el snapshot',
        problemas,
        datos_calculados: data.kpis,
      });
    }

    const snapshotId = hoyBogota();
    const resultado = await guardarSnapshot({ snapshotId, data });

    return res.status(200).json({
      ok: true,
      snapshot_id: snapshotId,
      reemplazado: resultado.reemplazado,
      total_snapshots: resultado.total,
      resumen: {
        volumen: data.kpis.volumen.valor,
        reopen_pct: data.kpis.reopen.valor_pct,
        fcr_pct: data.kpis.fcr.valor_pct,
        tiempo_cierre_horas: data.kpis.tiempo_cierre_horas.valor,
        csat_pct: data.kpis.csat.valor_pct,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: 'Falló el snapshot', detalle: String(e.message ?? e) });
  }
}
