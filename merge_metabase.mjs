#!/usr/bin/env node
// merge_metabase.mjs
//
// Fusiona en ce_retention_dashboard_data.json los campos que vienen de
// Metabase: tiempo de cierre promedio, CSAT, y tickets+horas de cierre por
// país. Estos números NO se pueden pedir con un script standalone (Metabase
// aquí solo es consultable vía MBQL a través del conector MCP, que solo
// funciona dentro de una sesión de Claude) — por eso este script no llama a
// Metabase él mismo: recibe los resultados ya calculados como JSON por
// stdin o por archivo, calculados por Claude en la tarea programada semanal
// usando las 3 consultas MBQL documentadas en INSTRUCTIVO.md sección 8.
//
// Uso:
//   node merge_metabase.mjs metabase_result.json
//
// Donde metabase_result.json tiene esta forma (ver INSTRUCTIVO.md sección 8
// para las consultas MBQL exactas que producen estos números):
// {
//   "tiempo_cierre": { "horas_promedio": 47.4, "tickets_base": 87320, "periodo": "01-may—21-ago" },
//   "csat": { "promoter": 6538, "passive": 95, "detractor": 265 },
//   "por_pais_horas": { "Colombia": 74.0, "Rep. Dominicana": 54.7, "México": 71.0, "Costa Rica": 98.6, "Argentina": 29.0, "Panamá": 12.8, "Perú": 0.2 },
//   "por_pais_tickets": { "Colombia": 8705, "Rep. Dominicana": 775, "México": 752, "Costa Rica": 529, "Argentina": 58, "Panamá": 47, "Perú": 24 },
//   "tendencia_semanal": { "weeks": ["26-abr", ...], "volumes": [753, ...], "close_hours": [91.5, ...], "censured_from_index": 14 }
// }
//
// "tendencia_semanal" es opcional (si no viene, se deja lo que ya había en el
// JSON) — pero desde el 21-ago-2026 la tarea programada semanal SÍ la calcula
// siempre, así que en la práctica ya no queda ningún campo manual.
//
// "Sin país" y los totales/porcentajes se recalculan aquí a partir del
// volumen ya actualizado por sync_hubspot.mjs — no hace falta pasarlos.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JSON_PATH = join(__dirname, 'ce_retention_dashboard_data.json');
const JS_PATH = join(__dirname, 'ce_retention_dashboard_data.js');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Uso: node merge_metabase.mjs metabase_result.json');
  process.exit(1);
}

const metabase = JSON.parse(readFileSync(inputPath, 'utf8'));
const current = JSON.parse(readFileSync(JSON_PATH, 'utf8'));

if (metabase.tiempo_cierre) {
  current.kpis.tiempo_cierre_horas.valor = metabase.tiempo_cierre.horas_promedio;
  current.kpis.tiempo_cierre_horas.base_tickets = metabase.tiempo_cierre.tickets_base;
  current.kpis.tiempo_cierre_horas.periodo = metabase.tiempo_cierre.periodo ?? current.kpis.tiempo_cierre_horas.periodo;
  current.kpis.tiempo_cierre_horas.nota = 'Promedio de horas hasta el cierre; no incluye los últimos días (aún no han tenido tiempo de cerrarse)';
}

if (metabase.csat) {
  const { promoter, passive, detractor } = metabase.csat;
  const total = promoter + passive + detractor;
  current.kpis.csat_promoter.promoter = promoter;
  current.kpis.csat_promoter.passive = passive;
  current.kpis.csat_promoter.detractor = detractor;
  current.kpis.csat_promoter.total_respuestas = total;
  current.kpis.csat_promoter.valor_pct = total ? Number(((promoter / total) * 100).toFixed(1)) : 0;
  const volumen = current.kpis.volumen.valor;
  current.kpis.csat_promoter.tasa_respuesta_pct = volumen ? Number(((total / volumen) * 100).toFixed(1)) : current.kpis.csat_promoter.tasa_respuesta_pct;
  current.kpis.csat_promoter.nota = 'Solo refleja a quienes respondieron la encuesta de satisfacción, no al total de casos';
}

// Desde el 21-ago-2026 la tendencia semanal (volumen + horas de cierre por
// semana) también llega automatizada, con la misma consulta MBQL de arriba
// pero con breakout por semana en vez de por país — ver INSTRUCTIVO.md
// sección 8.2. Antes era el único campo que se seguía editando a mano.
if (metabase.tendencia_semanal) {
  const t = metabase.tendencia_semanal;
  current.tendencia_semanal.weeks = t.weeks;
  current.tendencia_semanal.volumes = t.volumes;
  current.tendencia_semanal.close_hours = t.close_hours;
  current.tendencia_semanal.censured_from_index = t.censured_from_index ?? current.tendencia_semanal.censured_from_index;
}

if (metabase.por_pais_horas || metabase.por_pais_tickets) {
  const volumen = current.kpis.volumen.valor;
  const totalConPais = Object.values(metabase.por_pais_tickets ?? {}).reduce((a, b) => a + b, 0);
  const sinPais = Math.max(volumen - totalConPais, 0);
  current.por_pais = current.por_pais.map((row) => {
    const tickets = row.pais === 'Sin país' ? sinPais : (metabase.por_pais_tickets?.[row.pais] ?? row.tickets);
    const cierre_horas = row.pais === 'Sin país' ? row.cierre_horas : (metabase.por_pais_horas?.[row.pais] ?? row.cierre_horas);
    return {
      ...row,
      tickets,
      cierre_horas,
      pct_total: volumen ? Number(((tickets / volumen) * 100).toFixed(1)) : row.pct_total,
      fuente_tickets: 'metabase', // antes 'hubspot' — se movió por precisión (ver INSTRUCTIVO.md)
    };
  });
}

writeFileSync(JSON_PATH, JSON.stringify(current, null, 2) + '\n');
writeFileSync(JS_PATH, `// Generado automáticamente a partir de ce_retention_dashboard_data.json — no editar a mano.\nwindow.CE_RETENTION_DATA = ${JSON.stringify(current, null, 2)};\n`);

console.log('Listo — parte de Metabase fusionada en data.json/.js (tiempo de cierre, CSAT, país).');
