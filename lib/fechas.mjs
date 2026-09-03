// lib/fechas.mjs
//
// Utilidad de fechas compartida entre lib/metrics.mjs (arma la respuesta
// final) y lib/cubos.mjs (arma/lee los cubos mensuales) -- ambos necesitan
// la misma lista de meses calendario que se solapan con un rango, así que
// vive en un solo lugar para no repetirla ni desincronizarla.

export const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// Todos los meses calendario que se solapan con [start, end] (ISO). Cada
// mes trae su id 'YYYY-MM' (clave del cubo en KV), su primer/último día
// (YYYY-MM-DD) y una etiqueta corta para los gráficos.
export function mesesEnRango(start, end) {
  const meses = [];
  let cursor = new Date(`${start.slice(0, 10)}T00:00:00.000Z`);
  cursor.setUTCDate(1);
  const limite = new Date(`${end.slice(0, 10)}T00:00:00.000Z`);
  while (cursor <= limite) {
    const anio = cursor.getUTCFullYear();
    const mes = cursor.getUTCMonth();
    const id = `${anio}-${String(mes + 1).padStart(2, '0')}`;
    const inicio = cursor.toISOString().slice(0, 10);
    const fin = new Date(Date.UTC(anio, mes + 1, 0)).toISOString().slice(0, 10);
    meses.push({ id, inicio, fin, label: MESES[mes] });
    cursor = new Date(Date.UTC(anio, mes + 1, 1));
  }
  return meses.length
    ? meses
    : [{ id: start.slice(0, 7), inicio: start.slice(0, 10), fin: end.slice(0, 10), label: MESES[new Date(start).getUTCMonth()] }];
}
