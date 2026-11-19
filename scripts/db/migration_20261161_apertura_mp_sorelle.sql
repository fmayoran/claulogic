-- MERCADO PAGO SORELLE arranca el 01/10/2026 en cero (decisión de Fer, 19/11/2026): se anula, con fecha 30/09, el saldo de apertura
-- de $2.396.438,25 que tomó del extracto. Por única vez. SORELLE arranca el 01/10 sin plata ni resultado.
INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, anula_a)
SELECT m.fecha, m.cuenta_id, 'anulacion', m.salida, m.entrada, 'Anula (SORELLE arranca el 01/10 en cero): ' || m.concepto, m.id
  FROM fin.movimiento_tes m JOIN fin.cuenta c ON c.id = m.cuenta_id
 WHERE c.nombre = 'MERCADO PAGO SORE' AND m.concepto = 'Saldo de apertura según extracto' AND m.fecha = DATE '2026-09-30'
   AND m.entrada = 2396438.25 AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = m.id);

DO $$
DECLARE s numeric;
BEGIN
  SELECT COALESCE(SUM(m.entrada - m.salida), 0) INTO s FROM fin.movimiento_tes m JOIN fin.cuenta c ON c.id = m.cuenta_id
   WHERE c.nombre = 'MERCADO PAGO SORE' AND m.fecha <= DATE '2026-09-30';
  IF s <> 0 THEN RAISE EXCEPTION 'MERCADO PAGO SORELLE al 30/09 da % y tenía que dar 0', s; END IF;
END $$;
