-- Líneas del extracto que no se tienen en cuenta (decisión de Fer, 09/11/2026).
-- Hay líneas que no se van a conciliar nunca y no tienen que quedar como pendientes: cobros de ventas anteriores a
-- cobros_desde (septiembre: la venta cuenta, pero su cobro nunca pasó por "a acreditar"), y lo anterior al inicio del
-- control de una cuenta, que se resuelve después con el saldo inicial. Descartar no mueve plata ni toca el libro mayor:
-- es una marca sobre la línea, con motivo, quién y cuándo, y se deshace (vuelve a pendiente).
ALTER TABLE fin.extracto_linea
  ADD COLUMN descartada     text CHECK (descartada IS NULL OR btrim(descartada) <> ''),
  ADD COLUMN descartada_por text,
  ADD COLUMN descartada_en  timestamptz;

-- Una línea conciliada no se descarta (y una descartada no se concilia: lo controla la app al conciliar).
CREATE OR REPLACE FUNCTION fin.linea_descartada_libre() RETURNS trigger AS $$
BEGIN
  IF NEW.descartada IS NOT NULL AND (OLD.descartada IS NULL)
     AND (NEW.compensa_a IS NOT NULL OR EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = NEW.id)) THEN
    RAISE EXCEPTION 'La línea ya está conciliada: deshacé la conciliación antes de descartarla.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER linea_descartada_libre BEFORE UPDATE OF descartada ON fin.extracto_linea
  FOR EACH ROW EXECUTE FUNCTION fin.linea_descartada_libre();

-- MERCADO PAGO SORELLE (decisiones de Fer, 09/11/2026):
-- 1. Los cobros de ventas de septiembre (antes de cobros_desde): no se tienen en cuenta; el saldo inicial se ajusta al
--    terminar el proceso de egresos.
UPDATE fin.extracto_linea l SET descartada = 'Cobro de una venta de septiembre (antes del inicio de los cobros)',
       descartada_por = 'fer', descartada_en = now()
 WHERE l.cuenta_id = (SELECT id FROM fin.cuenta WHERE nombre = 'MERCADO PAGO SORE')
   AND l.importe > 0 AND l.concepto LIKE 'Cobro%venta del 2026-09-%' AND l.compensa_a IS NULL
   AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id);
-- 2. Los ingresos sin explicar anteriores al 04/10 (cobros sin venta del 02 y 03/10, y el retiro del apartado del 01/10).
UPDATE fin.extracto_linea l SET descartada = 'Anterior al 04/10/2026, inicio del control de la cuenta',
       descartada_por = 'fer', descartada_en = now()
 WHERE l.cuenta_id = (SELECT id FROM fin.cuenta WHERE nombre = 'MERCADO PAGO SORE')
   AND l.importe > 0 AND l.fecha < '2026-10-04' AND l.descartada IS NULL AND l.compensa_a IS NULL
   AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.linea_id = l.id);

-- 3. El apartado de Mercado Pago de SORELLE como cuenta propia: las reservas y los retiros desde el 04/10 son
--    transferencias entre la cuenta principal y ésta (el saldo anterior entra con los saldos iniciales).
INSERT INTO fin.cuenta (nombre, tipo, sede_id, sociedad_id, banco)
SELECT 'MERCADO PAGO SORE · APARTADO', 'banco', c.sede_id, c.sociedad_id, 'MERCADO PAGO'
  FROM fin.cuenta c WHERE c.nombre = 'MERCADO PAGO SORE'
   AND NOT EXISTS (SELECT 1 FROM fin.cuenta WHERE nombre = 'MERCADO PAGO SORE · APARTADO');
