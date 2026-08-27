// Prueba end-to-end contra servidores simulados de HubSpot, Metabase y KV.
// No toca nada real: verifica que la lógica de construcción del payload, la
// validación y el guardado del histórico funcionen antes de desplegar.
//
// Correr: node test/mock-test.mjs

import { createServer } from 'node:http';

const PORT = 4599;
const kvStore = new Map();

// Datos simulados calcados de los números reales verificados el 27-ago-2026,
// para que el payload de salida sea comparable con el del dashboard actual.
const HS_TOTALS = {
  volumen: 103387,
  reopen: 569,
  cerrados: 99096,
  fcr: 38900,
};

function hsTotalFor(body) {
  const groups = body.filterGroups ?? [];
  const flat = JSON.stringify(groups);
  // El reopen llega como DOS filterGroups (retro + workflow) → se detecta así.
  if (groups.length === 2 && flat.includes('reopen__retroactivo')) return HS_TOTALS.reopen;
  if (flat.includes('hs_num_times_contacted')) return HS_TOTALS.fcr;
  if (flat.includes('closed_date')) return HS_TOTALS.cerrados;
  return HS_TOTALS.volumen;
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    // ── HubSpot simulado
    if (url.pathname === '/crm/v3/objects/tickets/search') {
      return send(200, { total: hsTotalFor(JSON.parse(body || '{}')) });
    }

    // ── Metabase simulado
    if (url.pathname === '/api/database') {
      return send(200, [{ id: 3, name: 'Viz' }]);
    }
    if (url.pathname === '/api/database/3/metadata') {
      return send(200, {
        tables: [{
          id: 42,
          name: 'bi_ce_interactions',
          schema: 'dm_customer_experience',
          fields: [
            { id: 101, name: 'channel' }, { id: 102, name: 'created_at' },
            { id: 103, name: 'closed_at' }, { id: 104, name: 'time_to_close_seconds' },
            { id: 105, name: 'country' }, { id: 106, name: 'csat_classification' },
          ],
        }],
      });
    }
    if (url.pathname === '/api/dataset') {
      const q = JSON.parse(body);
      const aggs = JSON.stringify(q.query.aggregation ?? []);
      const breakout = JSON.stringify(q.query.breakout ?? []);

      if (!q.query.breakout) {
        // tiempo de cierre: [count, avg_segundos] → 47.4 h
        return send(200, { data: { rows: [[87320, 170640]] } });
      }
      if (breakout.includes('106')) {
        return send(200, { data: { rows: [['Detractor', 265], ['Passive', 95], ['Promoter', 6538]] } });
      }
      if (breakout.includes('105')) {
        return send(200, { data: { rows: [
          ['COL', 8705, 266400], ['DOM', 775, 196920], ['MEX', 752, 255600],
          ['CRI', 529, 354960], ['ARG', 58, 104400], ['PAN', 47, 46080],
          ['PER', 24, 720], ['USA', 12, 5000], [null, 84000, 142200],
        ] } });
      }
      if (breakout.includes('temporal-unit')) {
        return send(200, { data: { rows: [
          ['2026-04-26T00:00:00Z', 8421, 181080], ['2026-05-03T00:00:00Z', 8289, 198720],
          ['2026-05-10T00:00:00Z', 5976, 212400], ['2026-05-17T00:00:00Z', 7392, 180720],
          ['2026-05-24T00:00:00Z', 7346, 191880], ['2026-05-31T00:00:00Z', 6437, 170640],
          ['2026-06-07T00:00:00Z', 5733, 174960], ['2026-06-14T00:00:00Z', 5843, 151920],
          ['2026-06-21T00:00:00Z', 6304, 156960], ['2026-06-28T00:00:00Z', 6990, 128880],
          ['2026-07-05T00:00:00Z', 5914, 128880], ['2026-07-12T00:00:00Z', 5872, 111960],
          ['2026-07-19T00:00:00Z', 7756, 77040], ['2026-07-26T00:00:00Z', 6147, 34200],
          ['2026-08-02T00:00:00Z', 6000, 30000], ['2026-08-09T00:00:00Z', 5800, 25000],
          ['2026-08-16T00:00:00Z', 5500, 20000], ['2026-08-23T00:00:00Z', 900, 3600],
        ] } });
      }
      return send(200, { data: { rows: [] } });
    }

    // ── Vercel KV simulado
    if (url.pathname.startsWith('/get/')) {
      const key = decodeURIComponent(url.pathname.slice(5));
      return send(200, { result: kvStore.get(key) ?? null });
    }
    if (url.pathname.startsWith('/set/')) {
      const key = decodeURIComponent(url.pathname.slice(5));
      kvStore.set(key, body);
      return send(200, { result: 'OK' });
    }

    send(404, { error: 'no encontrado: ' + url.pathname });
  });
});

await new Promise((r) => server.listen(PORT, r));

process.env.HUBSPOT_TOKEN = 'fake-token';
process.env.METABASE_URL = `http://localhost:${PORT}`;
process.env.METABASE_API_KEY = 'fake-key';
process.env.KV_REST_API_URL = `http://localhost:${PORT}`;
process.env.KV_REST_API_TOKEN = 'fake-kv';
process.env.CRON_SECRET = 'fake-secret';

// Redirigir las llamadas a api.hubapi.com al servidor simulado
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) =>
  realFetch(String(url).replace('https://api.hubapi.com', `http://localhost:${PORT}`), init);

let fallos = 0;
const check = (nombre, condicion, detalle) => {
  if (condicion) console.log(`  ✓ ${nombre}`);
  else { console.log(`  ✗ ${nombre} — ${detalle}`); fallos++; }
};

const { buildMetrics, validarMetrics, hoyBogota } = await import('../lib/metrics.mjs');
const { guardarSnapshot, leerHistorico } = await import('../lib/store.mjs');

console.log('\n── Construcción del payload ──');
const data = await buildMetrics();

check('volumen', data.kpis.volumen.valor === 103387, data.kpis.volumen.valor);
check('reopen usa la métrica nueva (569, no 2598)', data.kpis.reopen.reopen === 569, data.kpis.reopen.reopen);
check('reopen % ronda 0.55', data.kpis.reopen.valor_pct === 0.55, data.kpis.reopen.valor_pct);
check('tiempo de cierre = 47.4 h', data.kpis.tiempo_cierre_horas.valor === 47.4, data.kpis.tiempo_cierre_horas.valor);
check('FCR calculado sobre cerrados', data.kpis.fcr.valor_pct === 39.3, data.kpis.fcr.valor_pct);
check('CSAT promoter %', data.kpis.csat_promoter.valor_pct === 94.8, data.kpis.csat_promoter.valor_pct);
check('CSAT total respuestas', data.kpis.csat_promoter.total_respuestas === 6898, data.kpis.csat_promoter.total_respuestas);

console.log('\n── País ──');
const colombia = data.por_pais.find((p) => p.pais === 'Colombia');
const sinPais = data.por_pais.find((p) => p.pais === 'Sin país');
check('Colombia con tickets y horas', colombia?.tickets === 8705 && colombia?.cierre_horas === 74, JSON.stringify(colombia));
check('ignora países fuera del tablero (USA)', !data.por_pais.some((p) => p.pais === 'USA'), 'apareció USA');
check('"Sin país" se calcula restando', sinPais?.tickets === 103387 - 10890, sinPais?.tickets);
check('porcentajes suman ~100', Math.abs(data.por_pais.reduce((a, p) => a + p.pct_total, 0) - 100) < 1.5,
  data.por_pais.reduce((a, p) => a + p.pct_total, 0));

console.log('\n── Tendencia semanal ──');
const t = data.tendencia_semanal;
check('18 semanas', t.weeks.length === 18, t.weeks.length);
check('formato de semana DD-mmm', /^\d{2}-[a-z]{3}$/.test(t.weeks[0]), t.weeks[0]);
check('marca la última semana como incompleta', t.censured_from_index === 17, t.censured_from_index);

console.log('\n── Validación ──');
check('payload válido no reporta problemas', validarMetrics(data).length === 0, JSON.stringify(validarMetrics(data)));
const roto = JSON.parse(JSON.stringify(data));
roto.kpis.reopen.valor_pct = 2.53;
check('detecta reopen inflado (2.53% = métrica vieja)', validarMetrics(roto).some((p) => p.includes('reopen')), 'no lo detectó');
const roto2 = JSON.parse(JSON.stringify(data));
roto2.kpis.volumen.valor = 0;
check('detecta volumen en cero', validarMetrics(roto2).some((p) => p.includes('volumen')), 'no lo detectó');

console.log('\n── Histórico en KV ──');
const hoy = hoyBogota();
const r1 = await guardarSnapshot({ snapshotId: hoy, data });
check('guarda el primer snapshot', r1.total === 1 && !r1.reemplazado, JSON.stringify(r1));
const r2 = await guardarSnapshot({ snapshotId: hoy, data });
check('correr dos veces el mismo día no duplica', r2.total === 1 && r2.reemplazado, JSON.stringify(r2));
await guardarSnapshot({ snapshotId: '2026-08-20', data });
const hist = await leerHistorico();
check('conserva snapshots anteriores', hist.length === 2, hist.length);
check('quedan ordenados por fecha', hist[0].snapshot_id === '2026-08-20', hist.map((h) => h.snapshot_id).join(','));
check('cada snapshot tiene los KPIs completos', !!hist[1].kpis?.volumen?.valor && !!hist[1].por_pais?.length, 'snapshot incompleto');

server.close();
console.log(fallos === 0 ? '\n✅ Todas las pruebas pasaron\n' : `\n❌ ${fallos} prueba(s) fallaron\n`);
process.exit(fallos === 0 ? 0 : 1);
