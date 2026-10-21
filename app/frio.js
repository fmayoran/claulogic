// API de cadena de frío: estado de cada cámara, heladera y freezer, lecturas y alertas.
const express = require('express');
const { pool } = require('./db');
const { numero, texto, fecha, h } = require('./util');
const { filtroSedes } = require('./auth');

const r = express.Router();

// Una fila por equipo de frío, con su última lectura y si está fuera de rango. Un equipo sin
// lecturas recientes también es una alerta: no saber la temperatura es no tener control.
r.get('/frio', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.nombre, u.tipo, a.nombre AS almacen,
            trim_scale(u.temp_min)::text AS temp_min, trim_scale(u.temp_max)::text AS temp_max,
            ul.medido_en, trim_scale(ul.celsius)::text AS celsius,
            CASE WHEN ul.celsius < u.temp_min THEN 'bajo' WHEN ul.celsius > u.temp_max THEN 'alto' END AS desvio,
            (ul.medido_en IS NULL OR ul.medido_en < now() - interval '12 hours') AS sin_lectura_reciente,
            (SELECT COUNT(*)::int FROM logic.lectura_temperatura lt
              WHERE lt.ubicacion_id = u.id AND lt.medido_en > now() - interval '7 days'
                AND (lt.celsius < u.temp_min OR lt.celsius > u.temp_max)) AS alertas_7d
       FROM logic.ubicacion u
       JOIN logic.almacen a ON a.id = u.almacen_id
       LEFT JOIN LATERAL (SELECT medido_en, celsius FROM logic.lectura_temperatura
                           WHERE ubicacion_id = u.id ORDER BY medido_en DESC LIMIT 1) ul ON true
      WHERE u.activa AND u.tipo IN ('camara','heladera','freezer')
        AND ($1::uuid[] IS NULL OR a.sede_id = ANY($1))
      ORDER BY a.nombre, u.nombre`, [filtroSedes(req)]);
  res.json({ ok: true, equipos: rows });
}));

r.get('/lecturas', h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.id, l.medido_en, trim_scale(l.celsius)::text AS celsius, l.origen, l.registrado_por, l.notas,
            u.nombre AS ubicacion, a.nombre AS almacen,
            CASE WHEN l.celsius < u.temp_min THEN 'bajo' WHEN l.celsius > u.temp_max THEN 'alto' END AS desvio
       FROM logic.lectura_temperatura l
       JOIN logic.ubicacion u ON u.id = l.ubicacion_id
       JOIN logic.almacen a ON a.id = u.almacen_id
      WHERE ($1::uuid IS NULL OR l.ubicacion_id = $1)
        AND ($2::date IS NULL OR l.medido_en >= $2::date)
        AND (NOT $3 OR l.celsius < u.temp_min OR l.celsius > u.temp_max)
        AND ($4::uuid[] IS NULL OR a.sede_id = ANY($4))
      ORDER BY l.medido_en DESC LIMIT 500`,
    [texto(req.query.ubicacion), fecha(req.query.desde, { campo: 'Desde' }), req.query.solo_alertas === '1', filtroSedes(req)]);
  res.json({ ok: true, lecturas: rows });
}));

r.post('/lecturas', h(async (req, res) => {
  const b = req.body;
  const { rows: [n] } = await pool.query(
    `INSERT INTO logic.lectura_temperatura (ubicacion_id, celsius, medido_en, notas)
     VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4) RETURNING id`,
    [texto(b.ubicacion_id, { campo: 'la ubicación', requerido: true }),
     numero(b.celsius, { campo: 'La temperatura', requerido: true, negativo: true }),
     texto(b.medido_en), texto(b.notas)]);
  res.status(201).json({ ok: true, id: n.id });
}));

module.exports = r;
