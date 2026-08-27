// GET /api/metrics
//
// Devuelve la foto EN VIVO: consulta HubSpot en el momento y devuelve el
// payload que lee index.html. Ya no hay Metabase (ver MAPEO_CAMPOS_TABLA.md).
//
// Por defecto el rango es el año en curso completo (1-ene hasta hoy) — se
// puede pedir el año anterior u otro rango cualquiera con ?desde=&hasta=.
//
// Se cachea 10 minutos en el CDN de Vercel (s-maxage=600): estos números se
// mueven despacio y así varias personas abriendo el tablero a la vez no
// disparan una consulta cada una. stale-while-revalidate deja servir la
// versión vieja mientras se refresca por detrás, para que nadie espere.

import { buildMetrics, validarMetrics } from '../lib/metrics.mjs';

function inicioAnioActual() {
  return `${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`;
}

// Valida una fecha del querystring. Acepta solo YYYY-MM-DD para no dejar que
// el rango del tablero se convierta en una vía para meter cualquier string en
// los filtros de HubSpot.
function parseFecha(valor, nombre) {
  if (valor === undefined || valor === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    throw new Error(`El parámetro "${nombre}" debe tener el formato YYYY-MM-DD (recibido: "${valor}")`);
  }
  const d = new Date(`${valor}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`"${nombre}" no es una fecha válida: "${valor}"`);
  return valor;
}

export default async function handler(req, res) {
  // El dashboard puede abrirse desde file:// (doble clic) además de la URL de
  // Vercel; con origin "null" el navegador igual necesita el header CORS.
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // ── Validación del rango, ANTES del try principal.
  // Va separada a propósito: un parámetro mal formado es culpa de quien llama
  // (400, con el motivo), no una falla del servicio (500 genérico). Metidas en
  // el mismo try, ambas terminaban como "No se pudieron traer las métricas",
  // que no le dice nada a nadie.
  let periodStart, periodEnd;
  try {
    const desde = parseFecha(req.query?.desde, 'desde');
    const hasta = parseFecha(req.query?.hasta, 'hasta');

    if (desde && hasta && desde > hasta) {
      throw new Error(
        `El rango está invertido: "desde" (${desde}) es posterior a "hasta" (${hasta}).`
      );
    }

    periodStart = desde ? `${desde}T00:00:00.000Z` : inicioAnioActual();
    // El fin incluye el día completo, no se corta a medianoche.
    periodEnd = hasta ? `${hasta}T23:59:59.999Z` : new Date().toISOString();
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: String(e.message ?? e) });
  }

  try {
    const data = await buildMetrics({ periodStart, periodEnd });
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
