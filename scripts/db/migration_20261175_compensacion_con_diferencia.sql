-- Líneas del extracto que se compensan entre sí con una diferencia (pedido de Fer, 25/11/2026). En MERCADO PAGO SORELLE, el 22/11, un
-- retiro del apartado de $1.620.000 y cinco salidas por $1.606.000 fueron operaciones ajenas al negocio: sólo se usó la cuenta. No se
-- registran como movimientos; sólo la diferencia ($14.000, Otros ingresos), que sí quedó en la cuenta.
-- Hasta ahora una compensación era un par exacto (cada línea con `compensa_a` apuntando a la otra). Ahora una línea puede ser la
-- cabecera de un grupo: las otras líneas apuntan a ella con `compensa_a` y ella queda conciliada con el movimiento de la diferencia.
-- La suma que controla la base pasa a ser: importe de la línea + importe de las líneas que compensa = movimientos conciliados.
BEGIN;

CREATE OR REPLACE FUNCTION fin.conciliacion_suma() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE li numeric; mo numeric;
BEGIN
  SELECT l.importe + COALESCE((SELECT SUM(o.importe) FROM fin.extracto_linea o WHERE o.compensa_a = l.id AND l.compensa_a IS NULL), 0)
    INTO li FROM fin.extracto_linea l WHERE l.id = NEW.linea_id;
  SELECT COALESCE(SUM(m.entrada - m.salida), 0) INTO mo FROM fin.conciliacion k JOIN fin.movimiento_tes m ON m.id = k.movimiento_id WHERE k.linea_id = NEW.linea_id;
  IF li IS NOT NULL AND li <> mo THEN
    RAISE EXCEPTION 'La línea (%) y sus movimientos (%) no suman lo mismo.', li, mo;
  END IF;
  RETURN NULL;
END $$;

COMMENT ON COLUMN fin.extracto_linea.compensa_a IS
  'Línea con la que se compensa sin movimientos: un par exacto (cada una apunta a la otra) o un grupo (las líneas apuntan a una cabecera, que se concilia con el movimiento de la diferencia).';

COMMIT;
