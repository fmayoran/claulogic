-- La factura que llega con la mercadería: desde la factura se arma la compra y se la recibe
-- ("Recibir mercadería"). Eso vincula la compra a una factura que puede estar ya REGISTRADA.
--
-- El vínculo factura-compra es una referencia, sin importes (decisión de Fer, fase 2): agregarlo a
-- una factura registrada no cambia la deuda ni el libro IVA. Por eso se permite SUMAR un vínculo a
-- una registrada; quitarlo, cambiar renglones o impuestos sigue exigiendo borrador. Una anulada no
-- cambia más.
--
-- Mismo cuerpo que en migration_20261101_comprobante_no_fiscal, con esa excepción al principio.
CREATE OR REPLACE FUNCTION fin.comprobante_detalle_cerrado() RETURNS trigger AS $$
DECLARE c record;
BEGIN
  SELECT estado, letra INTO c FROM fin.comprobante
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.comprobante_id ELSE NEW.comprobante_id END;
  IF c.estado IS NULL THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;  -- cascada del borrado
  IF TG_TABLE_NAME = 'comprobante_compra' AND TG_OP = 'INSERT' AND c.estado = 'registrado' THEN
    RETURN NEW;
  END IF;
  IF c.estado <> 'borrador' THEN
    RAISE EXCEPTION 'El comprobante está %: no se modifica. Anulalo y cargalo de nuevo, o hacé una nota de crédito.', c.estado;
  END IF;
  -- Anidado a propósito: PL/pgSQL no corta la evaluación, y NEW.alicuota no existe en los tributos.
  IF TG_TABLE_NAME = 'comprobante_item' AND TG_OP <> 'DELETE' AND c.letra IN ('B','C','X') THEN
    IF NEW.alicuota IS NOT NULL THEN
      RAISE EXCEPTION 'Un comprobante % no discrimina IVA: sus renglones van sin alícuota.', c.letra;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
