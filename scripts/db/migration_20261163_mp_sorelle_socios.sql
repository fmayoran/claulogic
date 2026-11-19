-- MERCADO PAGO SORELLE, contra los socios (Fer, 19/11/2026). Con la apertura en cero (migración 20261161) la cuenta daba −$5,3 M contra
-- $841.841 de Mercado Pago. Como en CORTAFUEGO (migración 20261160), lo que había y lo que entró sin ser de la gestión es plata de los
-- socios:
-- 1. El saldo de apertura del extracto ($2.396.438,25 al 30/09): transferencia de PRÉSTAMOS DE SOCIOS, con el concepto de apertura
--    (fuera del flujo de caja y de lo pendiente de conciliar).
-- 2. Los 54 ingresos marcados "no se tienen en cuenta" ($4.570.000: cobros de ventas de septiembre liberados en octubre e ingresos
--    anteriores al 04/10, entre ellos un retiro del apartado): dejan de estar descartados y cada uno entra como transferencia de
--    PRÉSTAMOS DE SOCIOS con la fecha de la línea, conciliada con ella.
-- El resultado no cambia. La deuda con los socios sube $6.966.438,25.
DO $$
DECLARE
  soc uuid; mp uuid; l record; tr uuid; n int := 0;
BEGIN
  SELECT id INTO soc FROM fin.cuenta WHERE tipo = 'socios';
  SELECT id INTO mp FROM fin.cuenta WHERE nombre = 'MERCADO PAGO SORE';
  IF EXISTS (SELECT 1 FROM fin.movimiento_tes m WHERE m.cuenta_id = mp AND m.fecha <= DATE '2026-09-30' AND m.tipo <> 'anulacion'
               AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = m.id)) THEN
    RAISE EXCEPTION 'MERCADO PAGO SORE ya tiene movimientos vivos al 30/09';
  END IF;
  PERFORM fin.transferir(soc, mp, 2396438.25, DATE '2026-09-30', 'Saldo de apertura según extracto');

  FOR l IN SELECT x.id, x.fecha, x.importe, x.concepto FROM fin.extracto_linea x
            WHERE x.cuenta_id = mp AND x.descartada IS NOT NULL AND x.importe > 0 ORDER BY x.fecha, x.id LOOP
    UPDATE fin.extracto_linea SET descartada = NULL, descartada_por = NULL, descartada_en = NULL WHERE id = l.id;
    tr := fin.transferir(soc, mp, l.importe, l.fecha, 'Transferencia desde PRÉSTAMOS DE SOCIOS · ' || l.concepto);
    INSERT INTO fin.conciliacion (linea_id, movimiento_id)
    SELECT l.id, id FROM fin.movimiento_tes WHERE transferencia_id = tr AND cuenta_id = mp;
    n := n + 1;
  END LOOP;
  IF n <> 54 THEN RAISE EXCEPTION 'Se esperaban 54 líneas y fueron %', n; END IF;
END $$;
