#!/usr/bin/env node
// sync_hubspot.mjs
//
// Actualiza SOLO los campos de ce_retention_dashboard_data.json que vienen de
// HubSpot (volumen, reopen, FCR) y reescribe ce_retention_dashboard_data.js.
// index.html no se toca nunca — mismo patrón que CE-luciaBot (ver INSTRUCTIVO.md).
//
// Desde el 21-ago-2026, "tickets por país" YA NO sale de aquí — se movió a
// Metabase (bi_ce_interactions.country), que calzó mucho mejor contra el
// snapshot original que la property de HubSpot. Ver merge_metabase.mjs.
//
// Este script NO toca el histórico (ce_retention_dashboard_history.json) —
// eso lo hace append_history.mjs, después de que tanto este script como
// merge_metabase.mjs hayan actualizado ce_retention_dashboard_data.json.
// Así el snapshot que queda en el histórico ya tiene AMBAS fuentes fusionadas,
// no solo la mitad de HubSpot.
//
// Uso:
//   HUBSPOT_TOKEN=pat-... node sync_hubspot.mjs
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

// CONFIRMADO (20-ago-2026): mailer-daemon@amazonses.com es el remitente
// automático de notificaciones de rebote (bounce) de Amazon SES — el
// servicio de correo que usa el sistema de facturación electrónica de
// Alegra. No es un cliente ni un caso de soporte real; es tráfico de
// infraestructura de correo que entró como tickets normales al pipeline y
// infló volumen, reopen y FCR (picos de miles de tickets de un día a otro).
// Filtro: coincidencia EXACTA (EQ/NEQ) sobre hs_all_associated_contact_emails
// — a propósito NO se usa CONTAINS_TOKEN, porque esa comparación fragmenta
// el email por los puntos (tokeniza "mailer-daemon@amazonses.com" en
// pedazos) y genera conteos inflados/falsos positivos.
const BOUNCE_EXCLUSION_FILTERS = [
  { propertyName: 'hs_all_associated_contact_emails', operator: 'NEQ', value: 'mailer-daemon@amazonses.com' },
];

// CONFIRMADO (21-ago-2026): "cerrado" = closed_date HAS_PROPERTY (tickets con
// fecha de cierre poblada). Reemplaza el placeholder anterior (hs_pipeline_stage
// HAS_PROPERTY), que era demasiado amplio y probablemente contaba tickets
// todavía abiertos. Validado contra el snapshot original (99,096 vs. 98,378).
const CLOSED_FILTER = { propertyName: 'closed_date', operator: 'HAS_PROPERTY' };

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

  // ── Verificación básica antes de sobrescribir (si algo se ve fuera de
  // rango razonable, avisar en vez de pisar el JSON en silencio).
  if (volumen < 1000 || volumen > 500000) {
    console.error(`ADVERTENCIA: volumen (${volumen}) parece fuera de rango razonable. Revisar antes de confiar en este resultado. No se sobrescribe el JSON.`);
    process.exit(1);
  }

  const current = JSON.parse(readFileSync(JSON_PATH, 'utf8'));

  const nowBogota = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  current.meta.generado = nowBogota + ' (actualizado automáticamente)';
  current.meta.periodo.inicio = PERIOD_START.slice(0, 10);
  current.meta.periodo.fin = PERIOD_END.slice(0, 10);

  current.kpis.volumen.valor = volumen;
  current.kpis.volumen.nota = 'No incluye correos automáticos de rebote (no son casos reales de soporte)';
  current.kpis.reopen.reopen = reopen;
  current.kpis.reopen.volumen = volumen;
  current.kpis.reopen.valor_pct = volumen ? Number(((reopen / volumen) * 100).toFixed(2)) : 0;
  current.kpis.reopen.nota = 'Casos que el cliente tuvo que reabrir después de haber sido cerrados';
  current.kpis.fcr.gestionados_primer_contacto = fcr;
  current.kpis.fcr.cerrados = cerrados;
  current.kpis.fcr.valor_pct = cerrados ? Number(((fcr / cerrados) * 100).toFixed(1)) : 0;
  current.kpis.fcr.nota = 'Casos resueltos en el primer contacto, sobre el total de casos cerrados';

  // Los campos de Metabase (tiempo_cierre_horas, csat_promoter, por_pais,
  // tendencia_semanal) quedan intactos — no se tocan aquí. Los actualiza
  // merge_metabase.mjs por separado.

  writeFileSync(JSON_PATH, JSON.stringify(current, null, 2) + '\n');
  writeFileSync(JS_PATH, `// Generado automáticamente a partir de ce_retention_dashboard_data.json — no editar a mano.\nwindow.CE_RETENTION_DATA = ${JSON.stringify(current, null, 2)};\n`);

  console.log('Listo — parte de HubSpot actualizada en data.json/.js (volumen/reopen/FCR).');
}

main().catch((e) => {
  console.error('Error sincronizando con HubSpot:', e);
  process.exit(1);
});
