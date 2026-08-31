// lib/metrics.mjs
//
// Todo sale de HubSpot ahora (ver MAPEO_CAMPOS_TABLA.md) — ya no hay
// Metabase ni respaldo de snapshot para "datos desactualizados": si HubSpot
// falla, falla todo el payload, porque ya no hay una segunda fuente que
// pueda quedar rezagada.
//
// ── TEMPORAL (27-ago-2026): mientras se construyen los "cubos" semanales
// (PLAN_IMPLEMENTACION.md, para que cambiar el filtro de fecha no dispare
// una consulta en vivo a HubSpot), cada carga del tablero hacía 6-8 llamadas
// directas a la API de HubSpot — eso saturó el límite por segundo de la
// cuenta (429 RATE_LIMIT) mientras varias personas lo abrían a la vez.
// Por pedido explícito: por ahora se sirve un valor fijo (hardcodeado),
// sacado en vivo por HubSpot MCP el 27-ago-2026 para el rango 2026-01-01 a
// 2026-08-27 (ver METRICAS_MCP.md, "Corte 1"). Cuando se construya el
// sistema de cubos, esto se reemplaza por la suma real desde KV.
const HARDCODE_TEMPORAL = true;

import {
  fetchHubspotMetrics,
  fetchTiempoCierre,
  fetchCsat,
  fetchDistribucionVersion,
  fetchTendenciaSemanal,
} from './hubspot.mjs';

// Por defecto el rango es el año en curso completo — antes arrancaba fijo en
// 01-may-2026; ahora cada año arranca en 1-ene y se puede consultar el
// histórico moviendo el filtro (ver PLAN_IMPLEMENTACION.md).
function inicioAnioActual() {
  return `${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`;
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function etiquetaFecha(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MESES[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

// Fecha de hoy en zona Bogotá, formato YYYY-MM-DD. Se usa como snapshot_id.
export function hoyBogota() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Bogota' });
}

const pct = (num, den, decimals = 1) =>
  den ? Number(((num / den) * 100).toFixed(decimals)) : 0;

// Corte 2 de METRICAS_MCP.md, sacado en vivo por HubSpot MCP el 27-ago-2026,
// mes por mes (2026-01-01 a 2026-08-27), para que el selector de período
// (un mes, un rango de meses, o año completo) muestre el sub-total real de
// esos meses en vez de repetir siempre el total del corte completo.
// Ver HARDCODE_TEMPORAL arriba.
const MESES_HARDCODE = [
  '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01',
  '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01',
];
// Último día de cada mes — para saber si un mes cae dentro del rango pedido.
const MESES_FIN_HARDCODE = [
  '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30',
  '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31',
];
// Volumen = todos los tickets creados ese mes (createdate), sin importar si
// ya cerraron.
const VOLUMENES_HARDCODE = [5954, 5280, 6468, 6230, 6022, 5339, 5563, 4566];
// Cerrados = de los creados ese mes, cuántos tienen closed_date (createdate).
const CERRADOS_HARDCODE = [5933, 5240, 6427, 6172, 5957, 5239, 5396, 3056];
// Reopen = de los creados ese mes, cuántos tienen alguna de las dos
// propiedades de reapertura en 'Nueva consulta' (createdate).
const REOPEN_HARDCODE = [226, 178, 240, 253, 183, 182, 144, 32];
// Cerrados que además reabrieron, sobre el universo de CERRADOS_HARDCODE
// (createdate) — usado solo para ponderar el tiempo de cierre, NO para FCR
// (ver FCR_CERRADOS_HARDCODE abajo).
const CERRADOS_REABIERTOS_HARDCODE = [226, 173, 238, 249, 180, 171, 132, 23];
// FCR (ajuste 28-ago-2026): anclado a closed_date (no createdate), con
// ventana de maduración de 3 días — mismo cambio que en lib/hubspot.mjs
// (ver comentario ahí). La definición de reopen NO cambia, sigue siendo la
// de Estefanía ('Nueva consulta' únicamente); solo cambia el eje temporal.
// Sacado por HubSpot MCP el 28-ago-2026, agrupado por mes de closed_date,
// rango 2026-01-01 a 2026-08-25 (hoy 28-ago menos 3 días de maduración).
const FCR_CERRADOS_HARDCODE = [5489, 5782, 6091, 5971, 6658, 5636, 5612, 4309];
const FCR_CERRADOS_REABIERTOS_HARDCODE = [43, 150, 166, 231, 233, 214, 213, 136];
// Tiempo de cierre promedio en ms de ese mes (createdate), ya excluyendo
// tickets reabiertos — AVG(time_to_close) directo de HubSpot.
const CIERRE_MS_HARDCODE = [
  913864945.7594182, 887995754.4624038, 888700709.2903539, 781313608.9832855,
  784777405.2920201, 719023582.6187845, 605121294.8191489, 460964709.3672931,
];
// CSAT: OJO — se agrupa por fecha_de_la_ultima_encuestra_ces_csat (cuándo se
// CONTESTÓ la encuesta), no por createdate del ticket. Un ticket creado en
// julio puede aparecer aquí en agosto si respondió la encuesta ese mes.
const CSAT_PROMOTER_HARDCODE = [265, 258, 266, 283, 282, 260, 240, 202];
const CSAT_PASSIVE_HARDCODE = [13, 15, 22, 16, 6, 8, 12, 8];
const CSAT_DETRACTOR_HARDCODE = [53, 39, 49, 40, 30, 37, 39, 15];
// Tiempo de cierre por mes (en horas) para el gráfico de tendencia — mismo
// dato fuente que CIERRE_MS_HARDCODE (AVG(time_to_close) de HubSpot), solo
// convertido de ms a horas.
const CIERRE_HORAS_HARDCODE = CIERRE_MS_HARDCODE.map((ms) => Number((ms / 3600000).toFixed(1)));

// ── Pedido de Lauren Pacheco, 30-ago-2026 (para la reunión del 31-ago) ──
// Cerrados por mes según closed_date (NO por cohorte de createdate como
// CERRADOS_HARDCODE arriba) — para el gráfico "Creados vs Cerrados" que
// detecta backlog. Sacado por HubSpot MCP el 30-ago-2026, con los mismos
// filtros base (pipelines de soporte, excluye Lucía y rebotes), SIN la
// ventana de maduración de 3 días de FCR (acá interesa el cierre real de
// cada mes, no si es "definitivo").
const CERRADOS_MES_HARDCODE = [5321, 5781, 6091, 5971, 6656, 5627, 5522, 5098];

// Tiempo a primera respuesta promedio por mes, en horas (time_to_first_agent_reply,
// agrupado por mes de createdate). Sacado por HubSpot MCP el 30-ago-2026.
const PRIMERA_RESPUESTA_HORAS_HARDCODE = [5.4, 5.8, 4.8, 2.3, 2.3, 1.9, 2.4, 2.0];

// Histograma de tiempo de cierre (time_to_close), en buckets de días — sobre
// el corte completo ene-ago 2026 (no varía con el filtro de período, ver
// nota HARDCODE_TEMPORAL). Sacado por HubSpot MCP el 30-ago-2026.
const HISTOGRAMA_CIERRE_HARDCODE = {
  menos_1: 2862,
  de_1_a_3: 2948,
  de_3_a_7: 22151,
  de_7_a_14: 9668,
  de_14_a_30: 3988,
  mas_30: 2461,
};

// Scatter "Variación de desempeño por agente" — 78 agentes con >=100
// tickets en el corte ene-ago 2026 (createdate), sobre el mismo universo de
// pipelines/exclusión de Lucía. reopens usa la definición de Estefanía
// ('Nueva consulta' únicamente en cualquiera de las dos propiedades — NO se
// agregó 'Ambiguo', a diferencia de la consulta que mandó Lauren, para no
// contradecir la definición ya validada del KPI de reopen). ttc_dias =
// AVG(time_to_close) de ese agente, en días. Sacado por HubSpot MCP y
// search_owners el 30-ago-2026.
const AGENTES_HARDCODE = [
  { nombre: 'Mariela Castellanos', volumen: 1667, reopens: 104, reopen_pct: 6.2, ttc_dias: 8.9 },
  { nombre: 'María Fernanda Sánchez', volumen: 1455, reopens: 38, reopen_pct: 2.6, ttc_dias: 6.1 },
  { nombre: 'Alvaro Cardenas', volumen: 1286, reopens: 60, reopen_pct: 4.7, ttc_dias: 8.4 },
  { nombre: 'Milena Uribe', volumen: 1284, reopens: 56, reopen_pct: 4.4, ttc_dias: 7.7 },
  { nombre: 'Linda Ramírez', volumen: 1265, reopens: 34, reopen_pct: 2.7, ttc_dias: 7.0 },
  { nombre: 'Yohanna Moreno', volumen: 1242, reopens: 47, reopen_pct: 3.8, ttc_dias: 8.8 },
  { nombre: 'Jocelyn Miranda', volumen: 1221, reopens: 35, reopen_pct: 2.9, ttc_dias: 11.4 },
  { nombre: 'Yasmin Puentes', volumen: 1107, reopens: 33, reopen_pct: 3.0, ttc_dias: 11.3 },
  { nombre: 'Caroline Molina', volumen: 1054, reopens: 25, reopen_pct: 2.4, ttc_dias: 8.9 },
  { nombre: 'Daniela Aguado', volumen: 1044, reopens: 27, reopen_pct: 2.6, ttc_dias: 6.7 },
  { nombre: 'Valentina Benitez', volumen: 1008, reopens: 31, reopen_pct: 3.1, ttc_dias: 7.4 },
  { nombre: 'Daniela Yepes', volumen: 997, reopens: 39, reopen_pct: 3.9, ttc_dias: 8.7 },
  { nombre: 'Yshttar Moreno', volumen: 982, reopens: 29, reopen_pct: 3.0, ttc_dias: 10.4 },
  { nombre: 'Alexandra López', volumen: 829, reopens: 19, reopen_pct: 2.3, ttc_dias: 11.5 },
  { nombre: 'Eva Serje', volumen: 818, reopens: 26, reopen_pct: 3.2, ttc_dias: 8.4 },
  { nombre: 'Ana Aponte', volumen: 815, reopens: 30, reopen_pct: 3.7, ttc_dias: 8.9 },
  { nombre: 'Andrea Ruiz', volumen: 800, reopens: 15, reopen_pct: 1.9, ttc_dias: 6.3 },
  { nombre: 'Grey Paola Villar Guerrero', volumen: 772, reopens: 14, reopen_pct: 1.8, ttc_dias: 10.1 },
  { nombre: 'Cristian Gomez', volumen: 770, reopens: 44, reopen_pct: 5.7, ttc_dias: 12.9 },
  { nombre: 'Miriam Almanza', volumen: 760, reopens: 31, reopen_pct: 4.1, ttc_dias: 9.2 },
  { nombre: 'Andres Bañez', volumen: 741, reopens: 17, reopen_pct: 2.3, ttc_dias: 8.7 },
  { nombre: 'Ariadna Beltran', volumen: 711, reopens: 29, reopen_pct: 4.1, ttc_dias: 13.4 },
  { nombre: 'Crisyelisa Sálcet', volumen: 682, reopens: 32, reopen_pct: 4.7, ttc_dias: 12.6 },
  { nombre: 'Daines Torres', volumen: 676, reopens: 23, reopen_pct: 3.4, ttc_dias: 7.6 },
  { nombre: 'Pedro Rodríguez', volumen: 672, reopens: 17, reopen_pct: 2.5, ttc_dias: 10.3 },
  { nombre: 'Dayanis Jarava Rodríguez', volumen: 663, reopens: 15, reopen_pct: 2.3, ttc_dias: 9.2 },
  { nombre: 'Polette Martínez', volumen: 647, reopens: 13, reopen_pct: 2.0, ttc_dias: 5.8 },
  { nombre: 'Mary Peña', volumen: 629, reopens: 15, reopen_pct: 2.4, ttc_dias: 12.5 },
  { nombre: 'Victoria Portillo', volumen: 624, reopens: 19, reopen_pct: 3.0, ttc_dias: 12.6 },
  { nombre: 'Karol Muñoz', volumen: 619, reopens: 14, reopen_pct: 2.3, ttc_dias: 9.6 },
  { nombre: 'Diego Villota', volumen: 617, reopens: 14, reopen_pct: 2.3, ttc_dias: 9.9 },
  { nombre: 'Camila Muñoz Cardona', volumen: 585, reopens: 20, reopen_pct: 3.4, ttc_dias: 10.6 },
  { nombre: 'Sandra Herrera', volumen: 581, reopens: 11, reopen_pct: 1.9, ttc_dias: 7.9 },
  { nombre: 'Leidy Avila', volumen: 563, reopens: 20, reopen_pct: 3.6, ttc_dias: 15.9 },
  { nombre: 'Maryi Ramirez', volumen: 556, reopens: 12, reopen_pct: 2.2, ttc_dias: 11.3 },
  { nombre: 'Victor Escobar', volumen: 551, reopens: 12, reopen_pct: 2.2, ttc_dias: 7.7 },
  { nombre: 'Santiago Elizondo Bello', volumen: 550, reopens: 20, reopen_pct: 3.6, ttc_dias: 8.7 },
  { nombre: 'Ana Cristina Durón Rivas', volumen: 540, reopens: 8, reopen_pct: 1.5, ttc_dias: 12.3 },
  { nombre: 'Laura Posada', volumen: 536, reopens: 13, reopen_pct: 2.4, ttc_dias: 7.1 },
  { nombre: 'Yaribel Paulino', volumen: 517, reopens: 24, reopen_pct: 4.6, ttc_dias: 7.5 },
  { nombre: 'Tomás Hoening', volumen: 514, reopens: 33, reopen_pct: 6.4, ttc_dias: 12.2 },
  { nombre: 'Ashley Hernández Rodríguez', volumen: 513, reopens: 25, reopen_pct: 4.9, ttc_dias: 7.4 },
  { nombre: 'Juan Rivera', volumen: 508, reopens: 16, reopen_pct: 3.1, ttc_dias: 12.6 },
  { nombre: 'Milena Fernandez Carmona', volumen: 503, reopens: 10, reopen_pct: 2.0, ttc_dias: 10.5 },
  { nombre: 'Vivian Pech', volumen: 473, reopens: 7, reopen_pct: 1.5, ttc_dias: 11.2 },
  { nombre: 'Eliana Katherine Rivera', volumen: 450, reopens: 15, reopen_pct: 3.3, ttc_dias: 15.0 },
  { nombre: 'Jorman Coronado', volumen: 444, reopens: 9, reopen_pct: 2.0, ttc_dias: 12.4 },
  { nombre: 'Camilo Ramos', volumen: 416, reopens: 16, reopen_pct: 3.8, ttc_dias: 5.6 },
  { nombre: 'Brenda Diaz', volumen: 411, reopens: 10, reopen_pct: 2.4, ttc_dias: 8.5 },
  { nombre: 'Luisa Florez', volumen: 411, reopens: 21, reopen_pct: 5.1, ttc_dias: 10.1 },
  { nombre: 'Juselfy Gomez', volumen: 383, reopens: 18, reopen_pct: 4.7, ttc_dias: 13.6 },
  { nombre: 'Luis Jiménez', volumen: 344, reopens: 5, reopen_pct: 1.5, ttc_dias: 11.0 },
  { nombre: 'Karen Patiño', volumen: 331, reopens: 15, reopen_pct: 4.5, ttc_dias: 14.0 },
  { nombre: 'Pierina Rangel', volumen: 330, reopens: 11, reopen_pct: 3.3, ttc_dias: 7.5 },
  { nombre: 'María Sosa', volumen: 325, reopens: 14, reopen_pct: 4.3, ttc_dias: 11.9 },
  { nombre: 'Daniela Amado', volumen: 322, reopens: 3, reopen_pct: 0.9, ttc_dias: 12.2 },
  { nombre: 'María Briceño', volumen: 289, reopens: 13, reopen_pct: 4.5, ttc_dias: 7.9 },
  { nombre: 'Grey Kerguelén', volumen: 288, reopens: 4, reopen_pct: 1.4, ttc_dias: 14.4 },
  { nombre: 'Annelis Ogando Ramírez', volumen: 285, reopens: 3, reopen_pct: 1.1, ttc_dias: 8.6 },
  { nombre: 'Robert David Martelo Mercado', volumen: 265, reopens: 14, reopen_pct: 5.3, ttc_dias: 9.7 },
  { nombre: 'Jessica Gutierrez', volumen: 225, reopens: 6, reopen_pct: 2.7, ttc_dias: 8.2 },
  { nombre: 'Michel Rivas Garcia', volumen: 224, reopens: 4, reopen_pct: 1.8, ttc_dias: 10.6 },
  { nombre: 'Dulcenia Pascual', volumen: 221, reopens: 6, reopen_pct: 2.7, ttc_dias: 19.7 },
  { nombre: 'Mafe Rodríguez', volumen: 213, reopens: 6, reopen_pct: 2.8, ttc_dias: 6.7 },
  { nombre: 'Karen Parra', volumen: 213, reopens: 0, reopen_pct: 0.0, ttc_dias: 20.9 },
  { nombre: 'Marcela Pérez', volumen: 203, reopens: 1, reopen_pct: 0.5, ttc_dias: 8.5 },
  { nombre: 'Andrés Juvinao', volumen: 193, reopens: 5, reopen_pct: 2.6, ttc_dias: 13.7 },
  { nombre: 'Franklin Castilla', volumen: 173, reopens: 2, reopen_pct: 1.2, ttc_dias: 14.9 },
  { nombre: 'Brayan Ortega', volumen: 164, reopens: 4, reopen_pct: 2.4, ttc_dias: 10.4 },
  { nombre: 'Samir Vargas', volumen: 163, reopens: 3, reopen_pct: 1.8, ttc_dias: 9.0 },
  { nombre: 'Jethcely Angel', volumen: 153, reopens: 0, reopen_pct: 0.0, ttc_dias: 15.1 },
  { nombre: 'Karen Valentina Rodríguez Fernandez', volumen: 150, reopens: 1, reopen_pct: 0.7, ttc_dias: 7.6 },
  { nombre: 'Dayalis Garcia', volumen: 130, reopens: 1, reopen_pct: 0.8, ttc_dias: 10.9 },
  { nombre: 'Jesús Castillo', volumen: 128, reopens: 3, reopen_pct: 2.3, ttc_dias: 18.8 },
  { nombre: 'Daniela Sánchez', volumen: 120, reopens: 2, reopen_pct: 1.7, ttc_dias: 8.7 },
  { nombre: 'Lisbeth Kukuly Coll Cardenas', volumen: 110, reopens: 3, reopen_pct: 2.7, ttc_dias: 7.8 },
  { nombre: 'Alejandro Cárdenas', volumen: 104, reopens: 4, reopen_pct: 3.8, ttc_dias: 8.5 },
  { nombre: 'Elizabeth Miranda', volumen: 103, reopens: 4, reopen_pct: 3.9, ttc_dias: 10.0 },
];

// ── Pedido de Noa, 31-ago-2026: al filtrar un solo mes, "Creados vs
// Cerrados" y "Tiempo a primera respuesta" mostraban un único punto (no se
// veía tendencia). Se agrega desglose en bloques de 5 días dentro del mes,
// SOLO usado cuando el filtro de período cae en exactamente un mes — con un
// rango de varios meses se sigue mostrando un punto por mes como antes.
// Sacado por HubSpot MCP el 31-ago-2026 (mismos filtros base: pipelines de
// soporte, excluye Lucía y rebotes; creados agrupado por createdate,
// cerrados por closed_date, primera respuesta = promedio ponderado por
// cantidad de tickets de time_to_first_agent_reply agrupado por createdate).
// Bloques: 1-5, 6-10, 11-15, 16-20, 21-25, 26-fin de mes.
const BUCKETS_5D_LABELS_HARDCODE = [
  ["1-5", "6-10", "11-15", "16-20", "21-25", "26-31"],
  ["1-5", "6-10", "11-15", "16-20", "21-25", "26-28"],
  ["1-5", "6-10", "11-15", "16-20", "21-25", "26-31"],
  ["1-5", "6-10", "11-15", "16-20", "21-25", "26-30"],
  ["1-5", "6-10", "11-15", "16-20", "21-25", "26-31"],
  ["1-5", "6-10", "11-15", "16-20", "21-25", "26-30"],
  ["1-5", "6-10", "11-15", "16-20", "21-25", "26-31"],
  ["1-5", "6-10", "11-15", "16-20", "21-25", "26-31"],
];
const CREADOS_5D_HARDCODE = [
  [556, 1022, 1058, 909, 986, 1422],
  [1060, 888, 753, 1174, 825, 580],
  [1186, 956, 924, 1254, 905, 1243],
  [416, 1476, 982, 857, 1157, 1342],
  [846, 934, 1434, 833, 805, 1168],
  [1363, 809, 689, 937, 844, 682],
  [793, 1134, 735, 630, 973, 1187],
  [828, 629, 888, 888, 735, 841],
];
const CERRADOS_5D_HARDCODE = [
  [825, 791, 740, 905, 989, 1239],
  [1180, 1077, 1089, 827, 893, 715],
  [823, 1046, 1102, 927, 840, 1353],
  [881, 938, 1066, 1123, 1041, 922],
  [1187, 1099, 1084, 999, 1139, 1148],
  [1049, 843, 1097, 796, 1002, 840],
  [823, 941, 813, 993, 784, 1168],
  [768, 1044, 717, 688, 942, 940],
];
const PRIMERA_RESPUESTA_5D_HARDCODE = [
  [2.45, 6.16, 6.61, 7.28, 2.74, 5.9],
  [5.06, 3.44, 6.17, 2.02, 5.1, 18.67],
  [8.68, 5.42, 2.22, 3.69, 6.03, 2.85],
  [3.09, 3.09, 1.66, 1.93, 2.03, 2.16],
  [2.05, 1.85, 2.96, 2.28, 2.18, 1.93],
  [1.29, 2.1, 1.46, 1.93, 2.22, 2.65],
  [2.84, 1.5, 2.74, 2.3, 3.15, 2.01],
  [2.81, 2.89, 1.89, 1.56, 1.94, 1.32],
];

// Índices de MESES_HARDCODE cuyo rango [1-mes, fin-de-mes] se solapa con
// [start, end]. Si ninguno cae dentro (p. ej. una fecha personalizada más
// fina que un mes), se cae de vuelta a todos los meses disponibles para no
// devolver un total en cero.
function mesesIncluidos(start, end) {
  const s = start.slice(0, 10);
  const e = end.slice(0, 10);
  const idx = [];
  for (let i = 0; i < MESES_HARDCODE.length; i++) {
    if (MESES_HARDCODE[i] <= e && MESES_FIN_HARDCODE[i] >= s) idx.push(i);
  }
  return idx.length ? idx : MESES_HARDCODE.map((_, i) => i);
}

function hardcodeMetrics(start, end) {
  const idx = mesesIncluidos(start, end);
  const sum = (arr) => idx.reduce((acc, i) => acc + arr[i], 0);

  const volumen = sum(VOLUMENES_HARDCODE);
  const reopen = sum(REOPEN_HARDCODE);
  // FCR sobre su propio universo (closed_date + ventana de maduración de 3
  // días) — distinto del "cerrados por createdate" que se usa para ponderar
  // el tiempo de cierre más abajo. Ver FCR_CERRADOS_HARDCODE arriba.
  const fcrCerrados = sum(FCR_CERRADOS_HARDCODE);
  const fcrCerradosReabiertos = sum(FCR_CERRADOS_REABIERTOS_HARDCODE);
  const fcr = Math.max(0, fcrCerrados - fcrCerradosReabiertos);
  const hs = { volumen, reopen, cerrados: fcrCerrados, fcr };

  // Tiempo de cierre: promedio ponderado por la cantidad de tickets base de
  // cada mes (cerrados sin contar los reabiertos), no un promedio simple de
  // promedios mensuales.
  const pesos = idx.map((i) => CERRADOS_HARDCODE[i] - CERRADOS_REABIERTOS_HARDCODE[i]);
  const pesoTotal = pesos.reduce((a, b) => a + b, 0);
  const msPromedio = pesoTotal
    ? idx.reduce((acc, i, j) => acc + CIERRE_MS_HARDCODE[i] * pesos[j], 0) / pesoTotal
    : 0;
  const tiempoCierre = {
    horas_promedio: Number((msPromedio / 3600000).toFixed(1)),
    tickets_base: pesoTotal,
  };

  const promoter = sum(CSAT_PROMOTER_HARDCODE);
  const passive = sum(CSAT_PASSIVE_HARDCODE);
  const detractor = sum(CSAT_DETRACTOR_HARDCODE);
  const totalRespuestas = promoter + passive + detractor;
  const csat = {
    csat_pct: pct(promoter, totalRespuestas),
    promoter,
    passive,
    detractor,
    total_respuestas: totalRespuestas,
  };

  // Distribución por país/versión: se mantiene como el total del corte
  // completo (ene-ago) — todavía no se sacó por MCP el desglose mes a mes
  // por país, así que esta tabla no cambia al mover el filtro de período.
  const volumenTotalCorte = VOLUMENES_HARDCODE.reduce((a, b) => a + b, 0);
  const version = [
    { version: 'Colombia (colombia)', tickets: 25012 },
    { version: 'República Dominicana (republicaDominicana)', tickets: 6784 },
    { version: 'México (mexico)', tickets: 4364 },
    { version: 'Costa Rica (costaRica)', tickets: 2845 },
    { version: 'Panamá (panama)', tickets: 1834 },
    { version: 'Argentina (argentina)', tickets: 1333 },
    { version: 'Perú (peru)', tickets: 1055 },
    { version: 'Unassigned', tickets: 1006 },
    { version: 'España (spain)', tickets: 776 },
    { version: 'Otro (other)', tickets: 261 },
    { version: 'Estados Unidos (usa)', tickets: 92 },
    { version: 'Chile (chile)', tickets: 39 },
    { version: 'Venezuela (venezuela)', tickets: 12 },
  ].map((v) => ({ ...v, pct_total: pct(v.tickets, volumenTotalCorte, 2), cierre_horas: 215.5 }));

  const tendencia = { weeks: MESES_HARDCODE, volumes: VOLUMENES_HARDCODE, close_hours: CIERRE_HORAS_HARDCODE };

  // Un solo mes seleccionado: se usa el desglose en bloques de 5 días (ver
  // BUCKETS_5D_LABELS_HARDCODE arriba) para que la línea tenga varios puntos
  // en vez de uno solo. Con más de un mes, se mantiene un punto por mes.
  let creadosVsCerrados;
  let primeraRespuesta;
  if (idx.length === 1) {
    const i = idx[0];
    creadosVsCerrados = {
      meses: BUCKETS_5D_LABELS_HARDCODE[i],
      creados: CREADOS_5D_HARDCODE[i],
      cerrados: CERRADOS_5D_HARDCODE[i],
    };
    primeraRespuesta = {
      meses: BUCKETS_5D_LABELS_HARDCODE[i],
      horas: PRIMERA_RESPUESTA_5D_HARDCODE[i],
    };
  } else {
    creadosVsCerrados = {
      meses: idx.map((i) => MESES_HARDCODE[i]),
      creados: idx.map((i) => VOLUMENES_HARDCODE[i]),
      cerrados: idx.map((i) => CERRADOS_MES_HARDCODE[i]),
    };
    primeraRespuesta = {
      meses: idx.map((i) => MESES_HARDCODE[i]),
      horas: idx.map((i) => PRIMERA_RESPUESTA_HORAS_HARDCODE[i]),
    };
  }
  const histogramaCierre = HISTOGRAMA_CIERRE_HARDCODE;
  const agentes = AGENTES_HARDCODE;

  return { hs, tiempoCierre, csat, version, tendencia, creadosVsCerrados, primeraRespuesta, histogramaCierre, agentes };
}

export async function buildMetrics({ periodStart, periodEnd } = {}) {
  const start = periodStart ?? inicioAnioActual();
  const end = periodEnd ?? new Date().toISOString();
  const token = process.env.HUBSPOT_TOKEN;

  const { hs, tiempoCierre, csat, version, tendencia, creadosVsCerrados, primeraRespuesta, histogramaCierre, agentes } = HARDCODE_TEMPORAL
    ? hardcodeMetrics(start, end)
    // Todo en paralelo — son consultas independientes a la misma fuente.
    : await Promise.all([
        fetchHubspotMetrics({ token, periodStart: start, periodEnd: end }),
        fetchTiempoCierre({ token, periodStart: start, periodEnd: end }),
        fetchCsat({ token, periodStart: start, periodEnd: end }),
        fetchDistribucionVersion({ token, periodStart: start, periodEnd: end }),
        fetchTendenciaSemanal({ token, periodStart: start, periodEnd: end }),
      ]).then(([hs, tiempoCierre, csat, version, tendencia]) => ({ hs, tiempoCierre, csat, version, tendencia }));

  return {
    meta: {
      generado: etiquetaFecha(end),
      periodo: {
        inicio: start.slice(0, 10),
        fin: end.slice(0, 10),
        label: `${etiquetaFecha(start)} — ${etiquetaFecha(end)}`,
      },
    },
    kpis: {
      volumen: {
        valor: hs.volumen,
        fuente: 'hubspot',
        nota: 'No incluye correos automáticos de rebote (no son casos reales de soporte)',
      },
      tiempo_cierre_horas: {
        valor: tiempoCierre.horas_promedio,
        fuente: 'hubspot',
        base_tickets: tiempoCierre.tickets_base,
        periodo: `${etiquetaFecha(start).slice(0, 6)}—${etiquetaFecha(end).slice(0, 6)}`,
        nota: 'Promedio de horas hasta el cierre, sin contar tickets reabiertos',
      },
      reopen: {
        valor_pct: pct(hs.reopen, hs.volumen, 2),
        reopen: hs.reopen,
        volumen: hs.volumen,
        fuente: 'hubspot',
        nota: 'Casos cerrados que el cliente reabrió con una solicitud nueva, al menos 3 días después del cierre',
      },
      fcr: {
        valor_pct: pct(hs.fcr, hs.cerrados),
        gestionados_primer_contacto: hs.fcr,
        cerrados: hs.cerrados,
        fuente: 'hubspot',
        nota: 'Casos resueltos en el primer contacto, sobre el total de casos cerrados',
      },
      csat: {
        valor_pct: csat.csat_pct,
        promoter: csat.promoter,
        passive: csat.passive,
        detractor: csat.detractor,
        total_respuestas: csat.total_respuestas,
        tasa_respuesta_pct: pct(csat.total_respuestas, hs.volumen),
        fuente: 'hubspot',
        nota: 'Solo refleja a quienes respondieron la encuesta de satisfacción, no al total de casos',
      },
    },
    tendencia_semanal: { fuente: 'hubspot', ...tendencia },
    por_version: version.map((v) => ({ ...v, fuente: 'hubspot' })),
    creados_vs_cerrados: creadosVsCerrados ? { fuente: 'hubspot', ...creadosVsCerrados } : null,
    primera_respuesta: primeraRespuesta ? { fuente: 'hubspot', ...primeraRespuesta } : null,
    histograma_cierre: histogramaCierre ? { fuente: 'hubspot', ...histogramaCierre } : null,
    agentes: agentes ?? null,
  };
}

// ── Validación de cordura. Se corre ANTES de guardar un snapshot o de
// devolver datos, para no publicar una foto obviamente rota. Devuelve la
// lista de problemas encontrados; vacía = todo bien.
export function validarMetrics(data) {
  const problemas = [];
  const k = data?.kpis ?? {};

  const v = k.volumen?.valor;
  if (!(v > 0 && v < 500000)) problemas.push(`volumen fuera de rango: ${v}`);

  const cierre = k.tiempo_cierre_horas?.valor;
  if (!(cierre > 0 && cierre < 2000)) problemas.push(`tiempo de cierre fuera de rango: ${cierre}`);

  // Actualizado 27-ago-2026: con la definición confirmada en vivo con
  // Estefanía (REVPYME-732, contando 'Nueva consulta' en cualquiera de las
  // dos propiedades), la tasa real ronda 3%–3.5% (validado en 3,3% =
  // 1.510/45.321, y de nuevo en 3,18% = 1.438/45.240). El techo se sube a 8%
  // — sigue disparando si algo vuelve a contar con hs_ticket_reopened_at
  // directo (que daba ~2.53% con una definición distinta, o mucho más si se
  // cuentan reaperturas no deduplicadas).
  const reopenPct = k.reopen?.valor_pct;
  if (!(reopenPct >= 0 && reopenPct < 8)) {
    problemas.push(
      `reopen fuera de rango: ${reopenPct}% (con la métrica oficial debería rondar 3%–3.5%)`
    );
  }

  const fcrPct = k.fcr?.valor_pct;
  if (!(fcrPct >= 0 && fcrPct <= 100)) problemas.push(`FCR fuera de rango: ${fcrPct}%`);

  const csatPct = k.csat?.valor_pct;
  if (!(csatPct >= 0 && csatPct <= 100)) problemas.push(`CSAT fuera de rango: ${csatPct}%`);

  if (!data?.tendencia_semanal?.weeks?.length) problemas.push('tendencia semanal vacía');

  return problemas;
}
