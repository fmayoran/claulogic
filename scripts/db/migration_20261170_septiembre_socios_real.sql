-- El saldo real de los préstamos de socios al 31/10/2026 es $27.013.155 (Fer, 19/11/2026); el sistema daba $41.215.515,72. La diferencia
-- ($14.202.360,72) sale de la estimación de septiembre: el gasto sin detalle pagado por los socios (egreso de PRÉSTAMOS DE SOCIOS del
-- 30/09, migración 20261160) baja de $16.866.602 a $2.664.241,28. Se anula con su fecha y se asienta el nuevo, con el mismo rubro y
-- local. La pérdida de septiembre de CORTAFUEGO pasa a −$2.664.241,28 y la deuda inicial con los socios a $5.504.358,36.
DO $$
DECLARE m record; nuevo bigint; s numeric;
BEGIN
  SELECT x.*, k.rubro_id, k.sede_id INTO m FROM fin.movimiento_tes x JOIN fin.clasificacion k ON k.movimiento_id = x.id
   WHERE x.id = 28061 AND x.salida = 16866602 AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = x.id);
  IF m.id IS NULL THEN RAISE EXCEPTION 'El gasto de septiembre de los socios no está como se esperaba'; END IF;
  INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, anula_a)
  VALUES (m.fecha, m.cuenta_id, 'anulacion', m.salida, 0, 'Anula (el saldo real con los socios al 31/10 es $27.013.155): ' || m.concepto, m.id);
  INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto)
  VALUES (m.fecha, m.cuenta_id, 'egreso', 0, 2664241.28, m.concepto) RETURNING id INTO nuevo;
  INSERT INTO fin.clasificacion (movimiento_id, rubro_id, sede_id) VALUES (nuevo, m.rubro_id, m.sede_id);

  SELECT SUM(x.entrada - x.salida) INTO s FROM fin.movimiento_tes x WHERE x.cuenta_id = m.cuenta_id AND x.fecha <= DATE '2026-10-31';
  IF s <> -27013155 THEN RAISE EXCEPTION 'PRÉSTAMOS DE SOCIOS al 31/10 da % y tenía que dar -27013155', s; END IF;
END $$;
