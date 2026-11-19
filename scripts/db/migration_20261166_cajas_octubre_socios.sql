-- Las cajas que quedaron en negativo al 31/10/2026 se cubren con PRÉSTAMOS DE SOCIOS (Fer, 19/11/2026): CAJA MAYOR EFECTIVO (gastos en
-- efectivo sin el ingreso que los pagó) y el efectivo de los dos locales de SORELLE (cobros corregidos después de rendir). Cada una
-- recibe una transferencia de los socios el 31/10 por lo que le falta para quedar en cero; la deuda con ellos sube.
DO $$
DECLARE c record; n int := 0;
BEGIN
  FOR c IN SELECT cu.id, cu.nombre, SUM(m.entrada - m.salida) AS saldo FROM fin.cuenta cu JOIN fin.movimiento_tes m ON m.cuenta_id = cu.id
            WHERE cu.nombre IN ('CAJA MAYOR EFECTIVO', 'Efectivo · SORELLE BODEGON Y SUSHI', 'Efectivo · SORELLE CAFETERIA') AND m.fecha <= DATE '2026-10-31'
            GROUP BY cu.id, cu.nombre LOOP
    IF c.saldo >= 0 THEN RAISE EXCEPTION '% no está en negativo al 31/10 (%)', c.nombre, c.saldo; END IF;
    PERFORM fin.transferir((SELECT id FROM fin.cuenta WHERE tipo = 'socios'), c.id, -c.saldo, DATE '2026-10-31',
                           'Saldo negativo al 31/10 cubierto por los socios');
    n := n + 1;
  END LOOP;
  IF n <> 3 THEN RAISE EXCEPTION 'Se esperaban 3 cuentas y fueron %', n; END IF;
END $$;
