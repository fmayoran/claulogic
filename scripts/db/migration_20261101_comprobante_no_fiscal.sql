-- Comprobante NO FISCAL: letra X, la convención argentina para documentos sin validez fiscal
-- (remito X, presupuesto X). Muchos proveedores chicos entregan eso o nada.
--
-- Tiene el mismo circuito que uno fiscal: se vincula a la compra, entra en la cuenta corriente y se
-- paga con orden de pago. Lo que cambia es el registro fiscal:
--   · no discrimina IVA (como B y C: precio final, renglones sin alícuota);
--   · no exige CUIT del proveedor ni CAE;
--   · punto de venta y número son opcionales: si no vienen, la base pone 0 y un número interno de
--     una secuencia propia (FC X 00000-00000001), para que se pueda buscar y no choque;
--   · no entra en el libro IVA compras (eso lo filtra la consulta del libro).

ALTER TABLE fin.comprobante DROP CONSTRAINT comprobante_letra_check,
  ADD CONSTRAINT comprobante_letra_check CHECK (letra IN ('A','B','C','M','X'));
ALTER TABLE fin.comprobante DROP CONSTRAINT comprobante_punto_venta_check,
  ADD CONSTRAINT comprobante_punto_venta_check
    CHECK (punto_venta BETWEEN 1 AND 99999 OR (letra = 'X' AND punto_venta = 0));

CREATE SEQUENCE fin.comprobante_x_seq;

CREATE FUNCTION fin.comprobante_x_numero() RETURNS trigger AS $$
BEGIN
  IF NEW.letra = 'X' THEN
    IF NEW.numero IS NULL THEN
      NEW.punto_venta := 0;
      NEW.numero := nextval('fin.comprobante_x_seq');
    ELSIF NEW.punto_venta IS NULL THEN
      NEW.punto_venta := 0;
    END IF;
    NEW.cae := NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER comprobante_x_numero BEFORE INSERT OR UPDATE ON fin.comprobante
  FOR EACH ROW EXECUTE FUNCTION fin.comprobante_x_numero();

-- Los dos controles de "no discrimina IVA" pasan a incluir la X. Mismo cuerpo que en
-- migration_20261027_fin_comprobantes, con la X agregada.
CREATE OR REPLACE FUNCTION fin.comprobante_detalle_cerrado() RETURNS trigger AS $$
DECLARE c record;
BEGIN
  SELECT estado, letra INTO c FROM fin.comprobante
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.comprobante_id ELSE NEW.comprobante_id END;
  IF c.estado IS NULL THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;  -- cascada del borrado
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

CREATE OR REPLACE FUNCTION fin.comprobante_cerrado() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.estado <> 'borrador' THEN RAISE EXCEPTION 'Sólo se borra un comprobante en borrador; uno registrado se anula.'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.estado = 'anulado' THEN RAISE EXCEPTION 'El comprobante está anulado: no cambia más.'; END IF;
  IF OLD.estado = 'registrado' AND (NEW.estado <> 'anulado' OR
       (NEW.proveedor_id, NEW.tipo, NEW.letra, NEW.punto_venta, NEW.numero, NEW.fecha, NEW.vencimiento, NEW.total, NEW.ajuste_redondeo)
       IS DISTINCT FROM
       (OLD.proveedor_id, OLD.tipo, OLD.letra, OLD.punto_venta, OLD.numero, OLD.fecha, OLD.vencimiento, OLD.total, OLD.ajuste_redondeo)) THEN
    RAISE EXCEPTION 'El comprobante está registrado: no se modifica. Anulalo y cargalo de nuevo, o hacé una nota de crédito.';
  END IF;
  -- Cambiar la letra a B, C o X con renglones que tienen alícuota dejaría IVA discriminado donde no va.
  IF NEW.letra IN ('B','C','X') AND EXISTS (SELECT 1 FROM fin.comprobante_item WHERE comprobante_id = NEW.id AND alicuota IS NOT NULL) THEN
    RAISE EXCEPTION 'Un comprobante % no discrimina IVA: quitá las alícuotas de los renglones.', NEW.letra;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
