-- La reserva al apartado de MERCADO PAGO SORELLE del 13/10 ($4.500.000) se mandó contra PRÉSTAMOS DE SOCIOS (Fer, 19/11/2026); lo que
-- volvió del apartado también va contra los socios (Fer, mismo día): los retiros de reserva del 21/10 ($500.000), 27/10 ($1.050.000) y
-- 02/11 ($3.000.000 y $1.100.000), que estaban como transferencias desde MERCADO PAGO SORE · APARTADO. Por cada línea: se suelta la
-- conciliación, se anulan las dos patas con su fecha original (los saldos a una fecha no cambian de golpe) y se asienta la
-- transferencia de PRÉSTAMOS DE SOCIOS a MERCADO PAGO SORE con la fecha de la línea, conciliada con ella. El apartado queda en cero.
DO $$
DECLARE
  l record; p record; mov bigint; tr uuid; soc uuid; n int := 0;
BEGIN
  SELECT id INTO soc FROM fin.cuenta WHERE tipo = 'socios';
  FOR l IN SELECT x.id, x.fecha, x.importe, x.concepto, x.cuenta_id FROM fin.extracto_linea x JOIN fin.cuenta c ON c.id = x.cuenta_id
            WHERE c.nombre = 'MERCADO PAGO SORE' AND x.id IN (18773, 19477, 20593, 20624) AND x.importe > 0 LOOP
    SELECT k.movimiento_id INTO mov FROM fin.conciliacion k WHERE k.linea_id = l.id;
    SELECT transferencia_id INTO tr FROM fin.movimiento_tes WHERE id = mov;
    IF tr IS NULL OR NOT EXISTS (SELECT 1 FROM fin.movimiento_tes o JOIN fin.cuenta oc ON oc.id = o.cuenta_id
                                  WHERE o.transferencia_id = tr AND oc.nombre = 'MERCADO PAGO SORE · APARTADO') THEN
      RAISE EXCEPTION 'La línea % no está conciliada con una transferencia desde el apartado', l.id;
    END IF;
    DELETE FROM fin.conciliacion WHERE linea_id = l.id;
    FOR p IN SELECT * FROM fin.movimiento_tes x WHERE x.transferencia_id = tr AND x.tipo <> 'anulacion'
               AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = x.id) LOOP
      INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, transferencia_id, anula_a)
      VALUES (p.fecha, p.cuenta_id, 'anulacion', p.salida, p.entrada, 'Anula (lo que vuelve del apartado va contra los socios): ' || p.concepto, p.transferencia_id, p.id);
    END LOOP;
    tr := fin.transferir(soc, l.cuenta_id, l.importe, l.fecha, 'Transferencia desde PRÉSTAMOS DE SOCIOS · ' || l.concepto);
    INSERT INTO fin.conciliacion (linea_id, movimiento_id)
    SELECT l.id, id FROM fin.movimiento_tes WHERE transferencia_id = tr AND cuenta_id = l.cuenta_id;
    n := n + 1;
  END LOOP;
  IF n <> 4 THEN RAISE EXCEPTION 'Se esperaban 4 líneas y fueron %', n; END IF;
  IF (SELECT COALESCE(SUM(m.entrada - m.salida), 0) FROM fin.movimiento_tes m JOIN fin.cuenta c ON c.id = m.cuenta_id
       WHERE c.nombre = 'MERCADO PAGO SORE · APARTADO') <> 0 THEN
    RAISE EXCEPTION 'El apartado no quedó en cero';
  END IF;
END $$;
