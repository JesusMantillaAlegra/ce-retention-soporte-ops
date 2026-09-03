// GET/POST /api/cubos-refrescar
//
// Recalcula en vivo (contra HubSpot) los cubos mensuales que todavía
// pueden cambiar, y de paso rellena cualquier cubo viejo que falte -- ver
// lib/cubos.mjs para la explicación completa de por qué existen los cubos.
// Lo dispara el cron diario de Vercel (ver vercel.json). También se puede
// llamar a mano para forzar un refresco fuera de horario.
//
// Solo los meses "inestables" (mesEstable() en lib/cubos.mjs, ~60 días de
// margen desde que terminó el mes) se vuelven a calcular en cada corrida;
// los demás se leen del KV si ya existen, o se calculan una sola vez si
// faltan (primer arranque / backfill del histórico).
//
// PRESUPUESTO DE TIEMPO (3-sep-2026): calcular un mes desde cero tarda
// bastante (varias funciones paginando miles de tickets cada una), y las
// funciones de Vercel tienen un límite de tiempo por invocación —el plan
// del proyecto puede recortar el "maxDuration" pedido en vercel.json—.
// Para no depender de adivinar ese límite, esta corrida se corta sola
// bajo PRESUPUESTO_MS y devuelve qué meses le faltaron en "pendientes":
// llamar al endpoint de nuevo retoma justo donde se quedó (los meses ya
// calculados en esta corrida no se repiten).
//
// ?mes=YYYY-MM fuerza el recálculo de UN mes puntual (sin importar si es
// estable), ignorando el presupuesto -- para pedir a mano el rehágo de un
// mes específico.
//
// SEGURIDAD: igual que /api/snapshot -- exige Authorization: Bearer
// <CRON_SECRET>, y se niega a correr si esa variable no está configurada.

import { mesesEnRango } from '../lib/fechas.mjs';
import { obtenerCubo, mesEstable } from '../lib/cubos.mjs';

function inicioAnioActual() {
  return `${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`;
}

const PRESUPUESTO_MS = 45_000; // deja margen bajo cualquier límite razonable (Hobby: 60s)

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
  const todosLosMeses = mesesEnRango(start, end);

  const mesPedido = req.query?.mes;
  if (mesPedido) {
    const mes = todosLosMeses.find((m) => m.id === mesPedido);
    if (!mes) {
      return res.status(400).json({ error: `Mes '${mesPedido}' no está en el rango del año en curso (${todosLosMeses.map((m) => m.id).join(', ')})` });
    }
    const inicioTarea = Date.now();
    try {
      const cubo = await obtenerCubo(mes, token, { forzar: true });
      return res.status(200).json({ ok: true, mes: mes.id, forzado: true, ms: Date.now() - inicioTarea, volumen: cubo.hs.volumen });
    } catch (e) {
      return res.status(500).json({ ok: false, mes: mes.id, error: String(e.message ?? e) });
    }
  }

  // Los inestables primero -- son los que más importa mantener al día en
  // cada corrida diaria; si el presupuesto se agota, lo que queda afuera
  // es backfill de meses viejos (que no cambian, no hay apuro).
  const meses = [...todosLosMeses].sort((a, b) => (mesEstable(a.fin) ? 1 : 0) - (mesEstable(b.fin) ? 1 : 0));

  const inicioCorrida = Date.now();
  const resultados = [];
  const pendientes = [];

  for (const mes of meses) {
    if (Date.now() - inicioCorrida > PRESUPUESTO_MS) {
      pendientes.push(mes.id);
      continue;
    }
    const forzar = !mesEstable(mes.fin);
    const inicioTarea = Date.now();
    try {
      const cubo = await obtenerCubo(mes, token, { forzar });
      resultados.push({ mes: mes.id, forzado: forzar, ok: true, ms: Date.now() - inicioTarea, volumen: cubo.hs.volumen });
    } catch (e) {
      resultados.push({ mes: mes.id, forzado: forzar, ok: false, ms: Date.now() - inicioTarea, error: String(e.message ?? e) });
    }
  }

  const conError = resultados.filter((r) => !r.ok);
  return res.status(conError.length ? 207 : 200).json({
    ok: conError.length === 0 && pendientes.length === 0,
    meses_procesados: resultados.length,
    meses_con_error: conError.length,
    meses_pendientes: pendientes,
    nota_pendientes: pendientes.length ? 'Llamá al endpoint de nuevo -- retoma donde se quedó, no repite lo ya calculado.' : undefined,
    resultados,
  });
}
