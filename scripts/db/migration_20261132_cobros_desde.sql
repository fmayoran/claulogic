-- Ventas históricas sin cobros (decisión de Fer, 08/11/2026: importar septiembre "sólo ventas").
-- pos.integracion.cobros_desde: el primer día cuyos cobros se procesan. Los días anteriores se importan y cuentan como ventas
-- (tableros, estado de resultados, lo más vendido), pero no se cobran: no generan efectivo a rendir ni cobros por acreditar, y
-- no aparecen como pendientes en Ingresos. Sin fecha, se cobra todo.
-- Todos los puntos de venta arrancaron sus cobros el 01/10/2026 (no hay cobros anteriores).

ALTER TABLE pos.integracion ADD COLUMN cobros_desde date;
COMMENT ON COLUMN pos.integracion.cobros_desde IS 'Primer día cuyos cobros se procesan; los anteriores son ventas históricas, sin cobros.';
UPDATE pos.integracion SET cobros_desde = DATE '2026-10-01';

-- La base no deja cobrar un día histórico, venga de donde venga.
CREATE OR REPLACE FUNCTION pos.cobro_desde() RETURNS trigger AS $$
DECLARE d date;
BEGIN
  IF NEW.integracion_id IS NULL OR NEW.dia IS NULL THEN RETURN NEW; END IF;
  SELECT cobros_desde INTO d FROM pos.integracion WHERE id = NEW.integracion_id;
  IF d IS NOT NULL AND NEW.dia < d THEN
    RAISE EXCEPTION 'El % es anterior al inicio de los cobros de este punto de venta (%): es una venta histórica, sin cobros.',
      to_char(NEW.dia, 'DD/MM/YYYY'), to_char(d, 'DD/MM/YYYY');
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cobro_desde BEFORE INSERT ON pos.cobro FOR EACH ROW EXECUTE FUNCTION pos.cobro_desde();
