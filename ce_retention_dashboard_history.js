// Generado automáticamente a partir de ce_retention_dashboard_history.json — no editar a mano.
window.CE_RETENTION_HISTORY = [
  {
    "snapshot_id": "2026-08-20",
    "capturado_en": "2026-08-20T00:00:00.000Z",
    "meta": {
      "generado": "05-ago-2026 (última corrida antes de automatizar; el próximo miércoles se refresca solo)",
      "periodo": {
        "inicio": "2026-05-01",
        "fin": "2026-08-19",
        "label": "01-may — 19-ago-2026"
      }
    },
    "kpis": {
      "volumen": {
        "valor": 102855,
        "fuente": "hubspot",
        "nota": "No incluye correos automáticos de rebote (no son casos reales de soporte)"
      },
      "tiempo_cierre_horas": {
        "valor": 47.2,
        "fuente": "metabase",
        "base_tickets": 91785,
        "periodo": "01-may—04-ago",
        "nota": "Promedio de horas hasta el cierre; no incluye los últimos días (aún no han tenido tiempo de cerrarse)"
      },
      "reopen": {
        "valor_pct": 2.53,
        "reopen": 2598,
        "volumen": 102855,
        "fuente": "hubspot",
        "nota": "Casos que el cliente tuvo que reabrir después de haber sido cerrados"
      },
      "fcr": {
        "valor_pct": 39.4,
        "gestionados_primer_contacto": 38750,
        "cerrados": 98378,
        "fuente": "hubspot_proxy",
        "nota": "Casos resueltos en el primer contacto, sobre el total de casos cerrados"
      },
      "csat_promoter": {
        "valor_pct": 94.7,
        "promoter": 5926,
        "passive": 88,
        "detractor": 242,
        "total_respuestas": 6256,
        "tasa_respuesta_pct": 6.5,
        "fuente": "metabase",
        "nota": "Solo refleja a quienes respondieron la encuesta de satisfacción, no al total de casos"
      }
    },
    "tendencia_semanal": {
      "fuente": "metabase",
      "weeks": [
        "26-abr",
        "03-may",
        "10-may",
        "17-may",
        "24-may",
        "31-may",
        "07-jun",
        "14-jun",
        "21-jun",
        "28-jun",
        "05-jul",
        "12-jul",
        "19-jul",
        "26-jul",
        "02-ago*",
        "09-ago*"
      ],
      "volumes": [
        753,
        8421,
        8289,
        5976,
        7392,
        7346,
        6437,
        5733,
        5843,
        6304,
        6990,
        5914,
        5872,
        7756,
        6147,
        128
      ],
      "close_hours": [
        91.5,
        50.3,
        55.2,
        59,
        50.2,
        53.3,
        47.4,
        48.6,
        42.2,
        43.6,
        35.8,
        35.8,
        31.1,
        21.4,
        9.5,
        0.3
      ],
      "censured_from_index": 14
    },
    "por_pais": [
      {
        "pais": "Sin país",
        "tickets": 85049,
        "pct_total": 88.6,
        "cierre_horas": 39.5,
        "fuente_tickets": "hubspot",
        "fuente_cierre": "metabase"
      },
      {
        "pais": "Colombia",
        "tickets": 8221,
        "pct_total": 8.6,
        "cierre_horas": 74,
        "fuente_tickets": "hubspot",
        "fuente_cierre": "metabase"
      },
      {
        "pais": "Rep. Dominicana",
        "tickets": 713,
        "pct_total": 0.7,
        "cierre_horas": 54.7,
        "fuente_tickets": "hubspot",
        "fuente_cierre": "metabase"
      },
      {
        "pais": "México",
        "tickets": 704,
        "pct_total": 0.7,
        "cierre_horas": 71,
        "fuente_tickets": "hubspot",
        "fuente_cierre": "metabase"
      },
      {
        "pais": "Costa Rica",
        "tickets": 492,
        "pct_total": 0.5,
        "cierre_horas": 98.6,
        "fuente_tickets": "hubspot",
        "fuente_cierre": "metabase"
      },
      {
        "pais": "Argentina",
        "tickets": 54,
        "pct_total": 0.1,
        "cierre_horas": 29,
        "fuente_tickets": "hubspot",
        "fuente_cierre": "metabase"
      },
      {
        "pais": "Panamá",
        "tickets": 42,
        "pct_total": 0,
        "cierre_horas": 12.8,
        "fuente_tickets": "hubspot",
        "fuente_cierre": "metabase"
      },
      {
        "pais": "Perú",
        "tickets": 20,
        "pct_total": 0,
        "cierre_horas": 0.2,
        "fuente_tickets": "hubspot",
        "fuente_cierre": "metabase"
      }
    ]
  }
];
