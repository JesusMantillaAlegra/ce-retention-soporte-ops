// POST /api/seed
//
// Siembra el histórico en KV con los snapshots que ya existían como archivo
// en el repo antes de mover esto a Vercel. Sirve una sola vez, al desplegar:
// sin esto el histórico arrancaría vacío y se perdería la foto del 20-ago.
//
// Requiere el mismo CRON_SECRET que /api/snapshot (escribe en el store).
// Es idempotente en el sentido de que siempre deja el histórico igual al
// archivo semilla, pero PISA lo que haya — por eso se niega a correr si ya
// hay snapshots, salvo que se pase ?forzar=1.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { leerHistorico, reemplazarHistorico } from '../lib/store.mjs';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'Falta CRON_SECRET' });
  if (req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const existente = await leerHistorico();
    const forzar = req.query?.forzar === '1';
    if (existente.length && !forzar) {
      return res.status(409).json({
        error: `El histórico ya tiene ${existente.length} snapshots. Si de verdad querés reemplazarlos, llamar con ?forzar=1`,
        snapshots_actuales: existente.map((h) => h.snapshot_id),
      });
    }

    const ruta = join(process.cwd(), 'ce_retention_dashboard_history.json');
    const semilla = JSON.parse(await readFile(ruta, 'utf8'));
    if (!Array.isArray(semilla)) {
      return res.status(500).json({ error: 'El archivo semilla no es un array de snapshots' });
    }

    const { total } = await reemplazarHistorico(semilla);
    return res.status(200).json({
      ok: true,
      total_snapshots: total,
      snapshots: semilla.map((h) => h.snapshot_id),
    });
  } catch (e) {
    return res.status(500).json({ error: 'Falló la siembra', detalle: String(e.message ?? e) });
  }
}
