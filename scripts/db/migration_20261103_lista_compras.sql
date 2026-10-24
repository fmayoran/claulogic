-- Lista de compras del centro (decisión de Fer, 24/10/2026): lo que hace falta comprar, antes de saber
-- a quién. Se carga a mano, con el botón "sumar lo que está bajo el mínimo" y, más adelante, con los
-- pedidos de los locales. Cada renglón se asigna a un proveedor (se sugiere el de la última compra) y
-- "generar pedidos" arma una compra por proveedor. Lo que un proveedor no entregó puede volver acá.
--
-- Guarda intenciones, no stock: no toca la regla de que el stock se deriva de los movimientos.
CREATE TABLE logic.necesidad (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id      uuid NOT NULL REFERENCES logic.producto(id),
  presentacion_id  uuid REFERENCES logic.presentacion(id),
  unidad           text REFERENCES logic.unidad(codigo),          -- suelta; NULL si va en presentación
  cantidad         numeric(16,4) NOT NULL CHECK (cantidad > 0),   -- en la presentación o unidad elegida
  cantidad_base    numeric(16,4) NOT NULL CHECK (cantidad_base > 0),
  proveedor_id     uuid REFERENCES logic.proveedor(id),           -- asignado; NULL = todavía sin proveedor
  origen           text NOT NULL DEFAULT 'manual' CHECK (origen IN ('manual','minimo','faltante','local')),
  notas            text,
  estado           text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','pedida')),
  compra_id        uuid REFERENCES logic.compra(id) ON DELETE SET NULL,   -- el pedido que la cubre
  creado_por       text DEFAULT org.usuario_actual(),
  creado_en        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX necesidad_pendiente_ix ON logic.necesidad (producto_id) WHERE estado = 'pendiente';
CREATE INDEX necesidad_compra_ix ON logic.necesidad (compra_id);

-- Si el pedido se borra o se anula, lo que cubría vuelve a la lista: no se pierde una necesidad
-- porque alguien canceló el pedido.
CREATE FUNCTION logic.necesidad_vuelve() RETURNS trigger AS $$
BEGIN
  UPDATE logic.necesidad SET estado = 'pendiente', compra_id = NULL WHERE compra_id = OLD.id;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER compra_borrada_necesidad BEFORE DELETE ON logic.compra
  FOR EACH ROW EXECUTE FUNCTION logic.necesidad_vuelve();
CREATE TRIGGER compra_anulada_necesidad AFTER UPDATE OF estado ON logic.compra
  FOR EACH ROW WHEN (NEW.estado = 'anulada' AND OLD.estado <> 'anulada') EXECUTE FUNCTION logic.necesidad_vuelve();
