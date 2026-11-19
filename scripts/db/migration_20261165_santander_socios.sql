-- El saldo de SANTANDER al 31/10/2026 (los depósitos de PedidosYa SORELLE de octubre, $7.972.853,47) pasa a PRÉSTAMOS DE SOCIOS y baja
-- la deuda con ellos (Fer, 19/11/2026). SANTANDER no tiene extracto: lo que salió de ahí se toma como devuelto a los socios.
DO $$
DECLARE s numeric;
BEGIN
  SELECT SUM(m.entrada - m.salida) INTO s FROM fin.movimiento_tes m JOIN fin.cuenta c ON c.id = m.cuenta_id
   WHERE c.nombre = 'SANTANDER' AND m.fecha <= DATE '2026-10-31';
  IF s <> 7972853.47 THEN RAISE EXCEPTION 'SANTANDER al 31/10 da % y se esperaba 7972853.47', s; END IF;
  PERFORM fin.transferir((SELECT id FROM fin.cuenta WHERE nombre = 'SANTANDER'), (SELECT id FROM fin.cuenta WHERE tipo = 'socios'),
                         s, DATE '2026-10-31', 'Saldo de SANTANDER al 31/10 a los socios (baja la deuda)');
END $$;
