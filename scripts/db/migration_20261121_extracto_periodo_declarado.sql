-- Período de un extracto = el que declara el nombre del archivo, si contiene todas sus líneas (03/11/2026).
--
-- El estado de cuenta de Brubank de octubre de CORTAFUEGO ("[2026-10-01 al 2026-10-31]") quedó con hasta = 30/10 porque el 31
-- fue sábado y no tuvo movimientos; el paso 3 de Ingresos lo daba por incompleto contra las ventas, que llegan al 31. Desde
-- ahora `importarExtracto` amplía el período al declarado en el nombre; esto corrige los extractos ya importados con la misma
-- regla (sólo amplía, nunca achica, y sólo si todas las líneas caen dentro del período declarado).
WITH d AS (
  SELECT e.id, m[1]::date AS desde, m[2]::date AS hasta
    FROM fin.extracto e, regexp_match(e.archivo, '(\d{4}-\d{2}-\d{2})\s+(?:al?|-)\s+(\d{4}-\d{2}-\d{2})') AS m
   WHERE m IS NOT NULL
)
UPDATE fin.extracto e
   SET desde = LEAST(e.desde, d.desde), hasta = GREATEST(e.hasta, d.hasta)
  FROM d
 WHERE d.id = e.id AND d.desde <= d.hasta AND d.hasta < current_date AND d.hasta - d.desde <= 62
   AND NOT EXISTS (SELECT 1 FROM fin.extracto_linea l WHERE l.extracto_id = e.id AND (l.fecha < d.desde OR l.fecha > d.hasta))
   AND (e.desde > d.desde OR e.hasta < d.hasta);
