#!/usr/bin/env node
// append_history.mjs
//
// Toma ce_retention_dashboard_data.json TAL COMO ESTÉ (ya con HubSpot y
// Metabase fusionados por sync_hubspot.mjs + merge_metabase.mjs) y lo agrega
// como snapshot nuevo a ce_retention_dashboard_history.json. Nunca pisa
// snapshots de días anteriores — solo reemplaza el de HOY si ya existía
// (para que correr esto dos veces el mismo día no duplique).
//
// Correr esto AL FINAL, después de sync_hubspot.mjs y merge_metabase.mjs.
//
// Uso: node append_history.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JSON_PATH = join(__dirname, 'ce_retention_dashboard_data.json');
const HISTORY_JSON_PATH = join(__dirname, 'ce_retention_dashboard_history.json');
const HISTORY_JS_PATH = join(__dirname, 'ce_retention_dashboard_history.js');

const current = JSON.parse(readFileSync(JSON_PATH, 'utf8'));

const snapshotId = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Bogota' }); // YYYY-MM-DD
let history = [];
try {
  history = JSON.parse(readFileSync(HISTORY_JSON_PATH, 'utf8'));
} catch (e) {
  console.warn('No se encontró ce_retention_dashboard_history.json previo — se crea uno nuevo.');
}

const snapshot = { snapshot_id: snapshotId, capturado_en: new Date().toISOString(), ...current };
const idx = history.findIndex((h) => h.snapshot_id === snapshotId);
if (idx >= 0) history[idx] = snapshot; else history.push(snapshot);
history.sort((a, b) => a.snapshot_id.localeCompare(b.snapshot_id));

writeFileSync(HISTORY_JSON_PATH, JSON.stringify(history, null, 2) + '\n');
writeFileSync(HISTORY_JS_PATH, `// Generado automáticamente a partir de ce_retention_dashboard_history.json — no editar a mano.\nwindow.CE_RETENTION_HISTORY = ${JSON.stringify(history, null, 2)};\n`);

console.log(`Listo — snapshot '${snapshotId}' guardado en el histórico (${history.length} snapshots en total).`);
