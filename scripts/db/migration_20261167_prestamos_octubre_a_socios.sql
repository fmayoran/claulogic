-- Los préstamos de los socios depositados en BRUBANK en octubre estaban como ingresos en "Aportes, retiros y préstamos" (plata sin
-- deuda). Pasan a PRÉSTAMOS DE SOCIOS, como el resto de lo que pusieron (Fer, 19/11/2026): por cada uno se suelta la conciliación, se
-- anula el ingreso con su fecha y se asienta una transferencia de PRÉSTAMOS DE SOCIOS a BRUBANK el mismo día, conciliada con la misma
-- línea. El resultado no cambia; la deuda con los socios sube $3.580.000. Noviembre, todavía no.
-- ABUNDEMIO CASH (05/10, $1.000.000) puede ser la recaudación de Pago24 de ese día (pendiente de confirmar con Fer).
DO $$
DECLARE m record; tr uuid; soc uuid; n int := 0; tot numeric := 0;
BEGIN
  SELECT id INTO soc FROM fin.cuenta WHERE tipo = 'socios';
  FOR m IN SELECT x.*, k.linea_id FROM fin.movimiento_tes x JOIN fin.conciliacion k ON k.movimiento_id = x.id
            WHERE x.id IN (25541, 25542, 25543, 25544, 25545) AND x.tipo = 'ingreso'
              AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = x.id) LOOP
    DELETE FROM fin.conciliacion WHERE linea_id = m.linea_id AND movimiento_id = m.id;
    INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, anula_a)
    VALUES (m.fecha, m.cuenta_id, 'anulacion', m.salida, m.entrada, 'Anula (pasa a PRÉSTAMOS DE SOCIOS): ' || m.concepto, m.id);
    tr := fin.transferir(soc, m.cuenta_id, m.entrada, m.fecha, 'Transferencia desde PRÉSTAMOS DE SOCIOS · ' || m.concepto);
    INSERT INTO fin.conciliacion (linea_id, movimiento_id)
    SELECT m.linea_id, id FROM fin.movimiento_tes WHERE transferencia_id = tr AND cuenta_id = m.cuenta_id;
    n := n + 1; tot := tot + m.entrada;
  END LOOP;
  IF n <> 5 OR tot <> 3580000 THEN RAISE EXCEPTION 'Se esperaban 5 ingresos por 3.580.000 y fueron % por %', n, tot; END IF;
END $$;
