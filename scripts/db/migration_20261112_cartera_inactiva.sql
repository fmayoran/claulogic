-- Sin cheques de terceros por ahora (decisión de Fer, 27/10/2026). La cartera no se borra (la usan las funciones de
-- cheques y el endoso en las órdenes de pago): se desactiva, y mientras esté inactiva no se puede recibir, depositar
-- ni endosar un cheque de tercero. Para volver a usarla alcanza con activarla. Los cheques propios no cambian.
UPDATE fin.cuenta SET activa = false WHERE tipo = 'cartera'
   AND NOT EXISTS (SELECT 1 FROM fin.cheque WHERE tipo = 'tercero' AND estado = 'en_cartera');

CREATE OR REPLACE FUNCTION fin.cartera() RETURNS uuid AS $$
DECLARE c record;
BEGIN
  SELECT id, activa INTO c FROM fin.cuenta WHERE tipo = 'cartera';
  IF c.id IS NULL OR NOT c.activa THEN
    RAISE EXCEPTION 'La cartera de cheques de terceros está desactivada: no se reciben ni se endosan cheques de terceros.';
  END IF;
  RETURN c.id;
END $$ LANGUAGE plpgsql STABLE;
