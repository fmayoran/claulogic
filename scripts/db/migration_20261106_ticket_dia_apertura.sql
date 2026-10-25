-- El día de una venta es el de su APERTURA, como lo cuenta Fudo (verificado el 25/10/2026 con la cuenta real:
-- por apertura, ventas, cobros y medios coinciden con los de Fudo; por cierre, la mesa abierta a la noche y
-- cobrada después de la medianoche caía en el día siguiente). Se guarda la hora de apertura cuando el POS la
-- trae, y el día ya calculado (`dia`, en la hora de la cocina) para agrupar cobros y ventas sin recalcular.
-- Lo que no trae apertura (los archivos) toma el día de su fecha.
ALTER TABLE pos.ticket ADD COLUMN abierto_en timestamptz, ADD COLUMN dia date;
UPDATE pos.ticket SET dia = (COALESCE(abierto_en, cerrado_en) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
ALTER TABLE pos.ticket ALTER COLUMN dia SET NOT NULL;
CREATE INDEX ticket_dia_ix ON pos.ticket (integracion_id, dia);
