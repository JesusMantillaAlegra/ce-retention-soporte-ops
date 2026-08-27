// GET /api/metrics
//
// Devuelve la foto EN VIVO: consulta HubSpot y Metabase en el momento y
// devuelve el payload con la misma forma que el viejo
// ce_retention_dashboard_data.json. Es lo que llama index.html al abrir.
//
// Se cachea 10 minutos en el CDN de Vercel (s-maxage=600): estos números se
// mueven despacio y así varias personas abriendo el tablero a la vez no
// disparan una consulta cada una. stale-while-revalidate deja servir la
// versión vieja mientras se refresca por detrás, para que nadie espere.

import { buildMetrics, validarMetrics } from '../lib/metrics.mjs';

export default async function handler(req, res) {
  // El dashboard puede abrirse desde file:// (doble clic) además de la URL de
  // Vercel; con origin "null" el navegador igual necesita el header CORS.
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const data = await buildMetrics();
    const problemas = validarMetrics(data);

    if (problemas.length) {
      // Los datos se devuelven igual, pero marcados: es mejor que el tablero
      // muestre algo con una advertencia visible que una pantalla en blanco.
      // Sin cache, para que un arreglo se refleje de inmediato.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ...data, _advertencias: problemas });
    }

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json(data);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ error: 'No se pudieron traer las métricas', detalle: String(e.message ?? e) });
  }
}
