-- Lotes esperados (decisión de Fer, 26/10/2026). Al llegar la fecha de liquidación que informa el procesador, el lote
-- se arma pero NO mueve plata: queda "esperado" (sin movimiento). El neto pasa de "a acreditar" a la cuenta donde
-- deposita (y el costo queda como cargo) recién cuando el depósito aparece en el extracto y se concilia. Así el saldo de
-- Brubank es sólo lo que el banco confirmó; lo esperado sigue en "a acreditar". Deshacer la conciliación vuelve el lote
-- a esperado.
ALTER TABLE fin.lote ALTER COLUMN movimiento_id DROP NOT NULL;

-- Los lotes ya liquidados por fecha y todavía sin confirmar pasan a esperados: sus movimientos se anulan (el libro mayor
-- no se reescribe) y el lote queda sin movimiento.
DO $$
DECLARE l record; m record;
BEGIN
  FOR l IN SELECT * FROM fin.lote x WHERE x.movimiento_id IS NOT NULL AND x.desde_linea_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM fin.conciliacion k WHERE k.movimiento_id = x.movimiento_id) LOOP
    FOR m IN SELECT x.* FROM fin.movimiento_tes x
              WHERE (x.transferencia_id = (SELECT transferencia_id FROM fin.movimiento_tes WHERE id = l.movimiento_id)
                     OR x.id = l.movimiento_id OR x.id = l.costo_movimiento_id)
                AND x.tipo <> 'anulacion' AND NOT EXISTS (SELECT 1 FROM fin.movimiento_tes a WHERE a.anula_a = x.id) LOOP
      INSERT INTO fin.movimiento_tes (fecha, cuenta_id, tipo, entrada, salida, concepto, transferencia_id, anula_a)
      VALUES (m.fecha, m.cuenta_id, 'anulacion', m.salida, m.entrada, 'Anula (el lote espera el extracto): ' || COALESCE(m.concepto, m.tipo),
              m.transferencia_id, m.id);
    END LOOP;
    UPDATE fin.lote SET movimiento_id = NULL, costo_movimiento_id = NULL WHERE id = l.id;
  END LOOP;
END $$;
