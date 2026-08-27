// lib/hubspot.mjs
//
// Trae de HubSpot los 3 KPIs que salen de ahí: volumen, reopen y FCR.
// Solo lee el campo `total` de la Search API — no pagina los 100k+ tickets,
// así que es rápido y barato incluso con este volumen.
//
// Variable de entorno requerida: HUBSPOT_TOKEN (Private App con scope
// crm.objects.tickets.read).

const HS_SEARCH_URL = 'https://api.hubapi.com/crm/v3/objects/tickets/search';

// ── Exclusión de rebotes (caso REVOPS-1324, confirmado 20-ago-2026).
// mailer-daemon@amazonses.com es el remitente automático de notificaciones de
// rebote de Amazon SES (el correo del sistema de facturación electrónica de
// Alegra). No es un cliente ni un caso real de soporte; entraba como tickets
// normales e inflaba volumen/reopen/FCR con picos de miles de un día a otro.
//
// Coincidencia EXACTA (NEQ) a propósito: NO usar CONTAINS_TOKEN, porque esa
// comparación fragmenta el email por los puntos y da falsos positivos.
const BOUNCE_EXCLUSION = {
  propertyName: 'hs_all_associated_contact_emails',
  operator: 'NEQ',
  value: 'mailer-daemon@amazonses.com',
};

// ── "Cerrado" = closed_date poblado (confirmado 21-ago-2026). Reemplazó a
// hs_pipeline_stage HAS_PROPERTY, que era demasiado amplio y contaba tickets
// todavía abiertos. Validado: 99,096 vs. 98,378 esperado.
const CLOSED_FILTER = { propertyName: 'closed_date', operator: 'HAS_PROPERTY' };

// ── REOPEN: métrica oficial de REVPYME-732 (Estefanía Messa, 22-ago-2026).
//
// NO se usa hs_ticket_reopened_at: esa property nativa se activa con
// CUALQUIER reapertura sin distinguir el motivo — se dispara igual si el
// cliente solo agradece, si el propio agente interactúa, o si pasa el mismo
// día del cierre. Sobrecontaba ~4.5x (2,598 vs. 569 reales).
//
// Definición oficial: ticket que, tras estar cerrado >=3 días, recibe una
// interacción NUEVA DEL CLIENTE que requiere gestión. La lógica ya viene
// aplicada y marcada dentro de HubSpot, en dos propiedades según la ventana:
//   • hasta 20-ago-2026 → clasificación retroactiva del análisis histórico
//   • desde 21-ago-2026 → marca automática del workflow
// Cuentan "Nueva consulta" y "Ambiguo" (ambiguo entra a propósito: el
// workflow es fail-safe, ante la duda asume que requiere gestión).
// "Cierre agradecimiento" NO cuenta.
const REOPEN_RETRO = {
  propertyName: 'reopen__retroactivo_tema_diferente',
  operator: 'IN',
  values: ['Nueva consulta', 'Ambiguo'],
};
const REOPEN_WF = {
  propertyName: 'ticket_reabierto__wf',
  operator: 'EQ',
  value: 'Nueva consulta',
};

async function searchTotal(token, filterGroups) {
  const res = await fetch(HS_SEARCH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 1, filterGroups }),
  });
  if (!res.ok) {
    throw new Error(`HubSpot search falló (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.total ?? 0;
}

function dateRange(periodStart, periodEnd) {
  return [
    { propertyName: 'createdate', operator: 'GTE', value: periodStart },
    { propertyName: 'createdate', operator: 'LTE', value: periodEnd },
    BOUNCE_EXCLUSION,
  ];
}

export async function fetchHubspotMetrics({ token, periodStart, periodEnd }) {
  if (!token) throw new Error('Falta HUBSPOT_TOKEN');

  const base = () => dateRange(periodStart, periodEnd);

  // Los 4 conteos van en paralelo — son llamadas independientes.
  const [volumen, reopen, cerrados, fcr] = await Promise.all([
    searchTotal(token, [{ filters: base() }]),

    // Los dos filtros de reopen van como filterGroups SEPARADOS a propósito:
    // HubSpot une los grupos con OR y devuelve el total ya DEDUPLICADO.
    // Importa porque hay tickets creados antes del 21-ago que quedaron
    // marcados como retroactivos y que después se reabrieron vía workflow —
    // tienen las DOS propiedades. Sumar dos búsquedas los contaría doble
    // (al 27-ago-2026 son 4 casos, y van a crecer).
    searchTotal(token, [
      { filters: [...base(), REOPEN_RETRO] },
      { filters: [...base(), REOPEN_WF] },
    ]),

    searchTotal(token, [{ filters: [...base(), CLOSED_FILTER] }]),

    searchTotal(token, [
      {
        filters: [
          ...base(),
          CLOSED_FILTER,
          { propertyName: 'hs_num_times_contacted', operator: 'EQ', value: '1' },
        ],
      },
    ]),
  ]);

  return { volumen, reopen, cerrados, fcr };
}
