-- Anular una compra recibida (pendiente desde la fase 1) y, con eso, las compras de prueba de octubre (pedido de Fer, 18/11/2026: figuraban
-- como "recibido sin factura" en Cuentas por pagar).
--  1. compra_cerrada admite recibida → anulada sólo si cada movimiento de stock de la compra ya tiene su anulación (el libro no se toca:
--     quedan la entrada y su inverso) y no hay un comprobante registrado vinculado.
--  2. Las cuatro recibidas (Reginald Lee 22/10, Frigorífico Pilotti x2 y Sabrosisimo 24/10) se anulan revirtiendo su entrada, y el pedido
--     de Mayorista del 24/10 (nunca recibido) también. Sus renglones de la lista de compras se borran (Fer: no vuelven a la lista).
--  3. El costo vigente de Aquarius Pomelo, Vacío y PAN BAGUETIN salió sólo de esas compras: vuelve a vacío (el cambio queda en
--     logic.costo_historial, como todos).
CREATE OR REPLACE FUNCTION logic.compra_cerrada() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.estado = 'recibida' THEN
    RAISE EXCEPTION 'Una compra recibida no se borra: ya generó movimientos de stock.';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.estado = 'recibida' AND NEW.estado = 'anulada' THEN
    IF EXISTS (SELECT 1 FROM logic.movimiento m JOIN logic.compra_item ci ON ci.id = m.compra_item_id
                WHERE ci.compra_id = OLD.id AND NOT EXISTS (SELECT 1 FROM logic.movimiento a WHERE a.anula_a = m.id)) THEN
      RAISE EXCEPTION 'Para anular una compra recibida, primero se anula cada entrada de stock.';
    END IF;
    IF EXISTS (SELECT 1 FROM fin.comprobante_compra x JOIN fin.comprobante c ON c.id = x.comprobante_id
                WHERE x.compra_id = OLD.id AND c.estado = 'registrado') THEN
      RAISE EXCEPTION 'La compra tiene una factura registrada: anulá primero la factura.';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.estado IN ('recibida', 'anulada') AND NEW.estado <> OLD.estado THEN
    RAISE EXCEPTION 'La compra está %: no cambia de estado.', OLD.estado;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;

CREATE TEMP TABLE prueba (id uuid) ON COMMIT DROP;
INSERT INTO prueba VALUES ('be20ed9b-973e-4ffb-bf3e-188f41f37d29'), ('1e5eaaa8-8f24-45f6-ad25-c7deaff2ed23'),
  ('e229ac48-0426-4f37-9bf9-1ddf4ac91d57'), ('e2b19b98-72cf-4380-befa-74f71e390d83'), ('70ca5c12-abd5-4947-9da3-4da148d58f52');

INSERT INTO logic.movimiento (tipo, producto_id, lote_id, cantidad_base, origen_id, destino_id, motivo, referencia, anula_a, registrado_por)
SELECT m.tipo, m.producto_id, m.lote_id, m.cantidad_base, m.destino_id, m.origen_id,
       'Anula #' || m.id || ': compra de prueba (pedido de Fer, 18/11/2026)', m.referencia, m.id, 'fer'
  FROM logic.movimiento m JOIN logic.compra_item ci ON ci.id = m.compra_item_id
 WHERE ci.compra_id IN (SELECT id FROM prueba) AND m.anula_a IS NULL
   AND NOT EXISTS (SELECT 1 FROM logic.movimiento a WHERE a.anula_a = m.id);

DELETE FROM logic.necesidad WHERE compra_id IN (SELECT id FROM prueba);
UPDATE logic.compra SET estado = 'anulada', notas = trim(COALESCE(notas || ' · ', '') || 'Anulada: datos de prueba (18/11/2026)')
 WHERE id IN (SELECT id FROM prueba) AND estado <> 'anulada';

UPDATE logic.producto SET costo_base = NULL
 WHERE nombre IN ('Aquarius Pomelo', 'Vacío', 'PAN BAGUETIN')
   AND NOT EXISTS (SELECT 1 FROM logic.compra_item ci JOIN logic.compra co ON co.id = ci.compra_id
                    WHERE ci.producto_id = logic.producto.id AND co.estado = 'recibida');
