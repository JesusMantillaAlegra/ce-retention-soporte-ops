#!/usr/bin/env node
// sync_hubspot.mjs
//
// Regenera SOLO los campos de ce_retention_dashboard_data.json que vienen de
// HubSpot (volumen, reopen, FCR, tickets por país) y reescribe también
// ce_retention_dashboard_data.js a partir de ese JSON. index.html no se toca
// nunca — mismo patrón que CE-luciaBot (ver INSTRUCTIVO.md).
//
// Los campos que vienen de Metabase (tiempo de cierre, CSAT, horas de cierre
// por país) NO se tocan — se preservan tal cual estén en el JSON existente.
// Esos se actualizan a mano corriendo de nuevo la consulta en Metabase.
//
// Uso:
//   HUBSPOT_TOKEN=pat-... node sync_hubspot.mjs
// o crear un .env junto a este script con HUBSPOT_TOKEN=... y cargarlo antes
// (este script no trae dotenv por defecto para no sumar dependencias).
//
// Requiere Node 18+ (usa fetch nativo).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JSON_PATH = join(__dirname, 'ce_retention_dashboard_data.json');
const JS_PATH = join(__dirname, 'ce_retention_dashboard_data.js');

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) {
  console.error('Falta HUBSPOT_TOKEN en el entorno. Ver instrucciones al inicio de este archivo.');
  process.exit(1);
}

const PERIOD_START = process.env.PERIOD_START ?? '2026-05-01T00:00:00.000Z';
const PERIOD_END = process.env.PERIOD_END ?? new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────
// PENDIENTE DE CONFIRMAR (ver INSTRUCTIVO.md, sección "Pendientes"):
// estos 3 valores son placeholders. Antes de confiar en los números en vivo,
// hay que confirmarlos contra el portal real de HubSpot (Settings ->
// Properties, o list_pipeline_stages / get_properties vía el MCP de HubSpot)
// — igual que recomienda el instructivo de Lucía: "pedir el filtro exacto
// de cada widget antes de automatizar, para que el número calce".
// ─────────────────────────────────────────────────────────────────────────

// TODO: property/valor real que identifica los ~7,900 tickets de rebote de
// mailer-daemon@amazonses.com (caso REVOPS-1324). Hoy no se excluye nada.
const BOUNCE_EXCLUSION_FILTERS = [];

// TODO: property/valor real de "cerrado" en el pipeline de tickets de este
// portal (stage IDs). HAS_PROPERTY sobre hs_pipeline_stage es un placeholder
// demasiado amplio — probablemente incluye tickets abiertos también.
const CLOSED_FILTER = { propertyName: 'hs_pipeline_stage', operator: 'HAS_PROPERTY' };

// TODO: nombre real de la property de país del ticket en este portal.
const COUNTRY_PROPERTY = 'country';

const COUNTRIES = ['Colombia', 'Rep. Dominicana', 'México', 'Costa Rica', 'Argentina', 'Panamá', 'Perú'];

async function hsSearchTotal(filterGroups) {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/tickets/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 1, filterGroups }),
  });
  if (!res.ok) {
    throw new Error(`HubSpot search falló (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.total ?? 0;
}

function dateRangeFilters() {
  return [
    { propertyName: 'createdate', operator: 'GTE', value: PERIOD_START },
    { propertyName: 'createdate', operator: 'LTE', value: PERIOD_END },
    ...BOUNCE_EXCLUSION_FILTERS,
  ];
}

async function main() {
  console.log(`Sincronizando con HubSpot — período ${PERIOD_START} a ${PERIOD_END}...`);

  const volumen = await hsSearchTotal([{ filters: dateRangeFilters() }]);
  console.log(`  volumen: ${volumen}`);

  const reopen = await hsSearchTotal([
    { filters: [...dateRangeFilters(), { propertyName: 'hs_ticket_reopened_at', operator: 'HAS_PROPERTY' }] },
  ]);
  console.log(`  reopen: ${reopen}`);

  const cerrados = await hsSearchTotal([{ filters: [...dateRangeFilters(), CLOSED_FILTER] }]);
  console.log(`  cerrados: ${cerrados}`);

  const fcr = await hsSearchTotal([
    { filters: [...dateRangeFilters(), CLOSED_FILTER, { propertyName: 'hs_num_times_contacted', operator: 'EQ', value: '1' }] },
  ]);
  console.log(`  FCR (primer contacto): ${fcr}`);

  const porPaisCounts = {};
  for (const country of COUNTRIES) {
    porPaisCounts[country] = await hsSearchTotal([
      { filters: [...dateRangeFilters(), { propertyName: COUNTRY_PROPERTY, operator: 'EQ', value: country }] },
    ]);
    console.log(`  ${country}: ${porPaisCounts[country]}`);
  }

  // ── Verificación básica antes de sobrescribir (recomendación del instructivo
  // de Lucía, sección 5.4): si algo se ve fuera de rango razonable, avisar en
  // vez de pisar el JSON en silencio.
  if (volumen < 1000 || volumen > 500000) {
    console.error(`ADVERTENCIA: volumen (${volumen}) parece fuera de rango razonable. Revisar antes de confiar en este resultado. No se sobrescribe el JSON.`);
    process.exit(1);
  }

  const current = JSON.parse(readFileSync(JSON_PATH, 'utf8'));

  current.meta.generado = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }) + ' (sincronizado con HubSpot)';
  current.meta.periodo.inicio = PERIOD_START.slice(0, 10);
  current.meta.periodo.fin = PERIOD_END.slice(0, 10);

  current.kpis.volumen.valor = volumen;
  current.kpis.reopen.reopen = reopen;
  current.kpis.reopen.volumen = volumen;
  current.kpis.reopen.valor_pct = volumen ? Number(((reopen / volumen) * 100).toFixed(2)) : 0;
  current.kpis.fcr.gestionados_primer_contacto = fcr;
  current.kpis.fcr.cerrados = cerrados;
  current.kpis.fcr.valor_pct = cerrados ? Number(((fcr / cerrados) * 100).toFixed(1)) : 0;

  const totalConPais = Object.values(porPaisCounts).reduce((a, b) => a + b, 0);
  const sinPais = Math.max(volumen - totalConPais, 0);
  current.por_pais = current.por_pais.map((row) => {
    const tickets = row.pais === 'Sin país' ? sinPais : (porPaisCounts[row.pais] ?? row.tickets);
    return { ...row, tickets, pct_total: volumen ? Number(((tickets / volumen) * 100).toFixed(1)) : row.pct_total };
  });

  // Los campos de Metabase (tiempo_cierre_horas, csat_promoter, tendencia_semanal,
  // cierre_horas dentro de por_pais) quedan intactos — no se tocan aquí.

  writeFileSync(JSON_PATH, JSON.stringify(current, null, 2) + '\n');
  writeFileSync(JS_PATH, `// Generado automáticamente por sync_hubspot.mjs a partir de ce_retention_dashboard_data.json — no editar a mano.\nwindow.CE_RETENTION_DATA = ${JSON.stringify(current, null, 2)};\n`);

  console.log('Listo — ce_retention_dashboard_data.json y .js actualizados.');
}

main().catch((e) => {
  console.error('Error sincronizando con HubSpot:', e);
  process.exit(1);
});
