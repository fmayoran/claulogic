-- PedidosYa SORELLE: lo que depositó en SANTANDER en octubre (Fer, 19/11/2026). Noviembre, todavía no.
-- 1. La semana del 28/09 al 04/10 (pago del 16/10) se había marcado "cobrada fuera de la gestión" (egreso de "a acreditar", No es
--    resultado). También entró a SANTANDER: se anula ese egreso con su fecha y el lote pasa a confirmado con una transferencia de
--    "a acreditar" a SANTANDER el 16/10, por el neto por pedido (esa semana no tiene facturas: si el portal pagó otro importe, falta la
--    diferencia).
-- 2. Las semanas del 05/10 y del 12/10, liquidadas con sus facturas, se confirman con el pago del portal (23/10 y 30/10): lo mismo
--    que hace "Confirmar con el portal" (asentarLote: sólo pasa el neto, los costos de PedidosYa ya están asentados).
DO $$
DECLARE
  pr record; lo record; e record; tr uuid; ent bigint; n int := 0;
BEGIN
  SELECT p.id, p.nombre, p.cuenta_id AS pendiente, p.cuenta_acredita_id AS banco INTO pr
    FROM fin.procesador p WHERE p.nombre = 'PEDIDOSYA SORELLE';
  IF pr.banco IS DISTINCT FROM (SELECT id FROM fin.cuenta WHERE nombre = 'SANTANDER') THEN RAISE EXCEPTION 'PEDIDOSYA SORELLE no deposita en SANTANDER'; END IF;

  -- 1. La semana "fuera de la gestión".
  SELECT * INTO e FROM fin.movimiento_tes WHERE id = 25596;
  IF e.cuenta_id <> pr.pendiente OR EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = e.id) THEN RAISE EXCEPTION 'El egreso 25596 no es el esperado'; END IF;
  INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, anula_a)
  VALUES (e.fecha, e.cuenta_id, 'anulacion', e.salida, e.entrada, 'Anula (también se depositó en SANTANDER): ' || e.concepto, e.id);
  UPDATE fin.lote SET movimiento_id = NULL WHERE movimiento_id = 25596;
  UPDATE fin.liquidacion SET fuera_gestion = false, motivo = 'Era "fuera de la gestión"; se depositó en SANTANDER (Fer, 19/11/2026)'
   WHERE id = '28cd2a94-2ec0-45f3-8e56-ca9563597da6';

  -- 1 y 2. Cada lote de octubre, a SANTANDER en su fecha de pago.
  FOR lo IN SELECT l.id, l.fecha, l.neto, l.pagos FROM fin.lote l
             WHERE l.procesador_id = pr.id AND l.fecha BETWEEN DATE '2026-10-01' AND DATE '2026-10-31' AND l.movimiento_id IS NULL ORDER BY l.fecha LOOP
    tr := gen_random_uuid();
    INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, salida, concepto, transferencia_id)
    VALUES (lo.fecha, pr.pendiente, 'transferencia', lo.neto, format('Lote %s del %s · %s cobro(s)', pr.nombre, lo.fecha, lo.pagos), tr);
    INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, concepto, transferencia_id)
    VALUES (lo.fecha, pr.banco, 'transferencia', lo.neto, format('Lote %s del %s · %s cobro(s)', pr.nombre, lo.fecha, lo.pagos), tr) RETURNING id INTO ent;
    UPDATE fin.lote SET movimiento_id = ent WHERE id = lo.id;
    n := n + 1;
  END LOOP;
  IF n <> 3 THEN RAISE EXCEPTION 'Se esperaban 3 lotes de octubre y fueron %', n; END IF;
  IF (SELECT SUM(entrada - salida) FROM fin.movimiento_tes WHERE cuenta_id = pr.banco AND fecha <= DATE '2026-10-31') <> 7972853.47 THEN
    RAISE EXCEPTION 'SANTANDER al 31/10 no da 7.972.853,47';
  END IF;
END $$;
