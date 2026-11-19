-- La parte de $1.000.000 de la Recaudación de Pago24 del 05/10/2026 (línea 15615) se había registrado como transferencia a BRUBANK,
-- pero en el extracto de BRUBANK no hay ese ingreso. Fer, 19/11/2026: va a los socios. Se suelta la conciliación de la pata de Pago24,
-- se anulan las dos patas con su fecha y se asienta una transferencia de PAGO 24 a PRÉSTAMOS DE SOCIOS el 05/10, conciliada con la
-- misma línea (la suma de la línea no cambia). BRUBANK baja $1.000.000 y la deuda con los socios también.
DO $$
DECLARE p record; tr uuid; pago24 uuid;
BEGIN
  SELECT cuenta_id INTO pago24 FROM fin.movimiento_tes WHERE id = 27974;
  IF NOT EXISTS (SELECT 1 FROM fin.conciliacion WHERE linea_id = 15615 AND movimiento_id = 27974)
     OR EXISTS (SELECT 1 FROM fin.conciliacion WHERE movimiento_id = 27975) THEN
    RAISE EXCEPTION 'La transferencia del millón no está como se esperaba';
  END IF;
  DELETE FROM fin.conciliacion WHERE linea_id = 15615 AND movimiento_id = 27974;
  FOR p IN SELECT * FROM fin.movimiento_tes x WHERE x.transferencia_id = 'c8fb4330-edf5-456b-9463-97b39ec8e853' AND x.tipo <> 'anulacion'
             AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = x.id) LOOP
    INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, transferencia_id, anula_a)
    VALUES (p.fecha, p.cuenta_id, 'anulacion', p.salida, p.entrada, 'Anula (no llegó a BRUBANK: fue a los socios): ' || p.concepto, p.transferencia_id, p.id);
  END LOOP;
  tr := fin.transferir(pago24, (SELECT id FROM fin.cuenta WHERE tipo = 'socios'), 1000000, DATE '2026-10-05',
                       'Transferencia a PRÉSTAMOS DE SOCIOS · Recaudacion - 1580867930 (parte)');
  INSERT INTO fin.conciliacion (linea_id, movimiento_id) SELECT 15615, id FROM fin.movimiento_tes WHERE transferencia_id = tr AND cuenta_id = pago24;
END $$;
