-- Liquidación semanal de PedidosYa (decisión de Fer, 09/11/2026, opción 2).
-- PedidosYa liquida por semana (lunes a domingo) y paga lo vendido menos dos facturas A a la sociedad: la de Delivery Hero
-- E-Commerce (comisión, publicidad, descuentos del local y reclamos, menos una bonificación) y la de Pagos Ya (pago en línea),
-- con IVA y percepciones. El orderDetails trae por pedido la comisión, el pago en línea, los descuentos y los reclamos (ya
-- se asientan al cobrar el día), pero no la publicidad ni las percepciones: eso sale de las facturas.
--
-- Al cargar las facturas de una semana:
--   * quedan registradas como comprobantes del proveedor (entran en el libro IVA compras de la sociedad) y COMPENSADAS con la
--     liquidación: un movimiento de cuenta corriente las cancela, sin deuda ni plata que salga;
--   * lo que falta (publicidad, su IVA, percepciones y la diferencia que quede) se asienta como egreso de "a acreditar",
--     por tienda, en el último día de la semana;
--   * los cobros de la semana forman un lote (fin.lote) por lo que paga PedidosYa: queda esperado hasta que el extracto del
--     banco lo confirma, o se confirma con el portal si no hay extracto (SANTANDER de SORELLE).
-- Una semana cobrada fuera de la gestión (la del 28/09 de SORELLE) sale de "a acreditar" como "No es resultado".

CREATE TABLE fin.liquidacion (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  procesador_id   uuid NOT NULL REFERENCES fin.procesador(id),
  desde           date NOT NULL,
  hasta           date NOT NULL,
  fecha_pago      date NOT NULL,
  calculado       numeric(16,2) NOT NULL,           -- la suma de los netos por pedido
  total           numeric(16,2) NOT NULL,           -- lo que paga PedidosYa
  fuera_gestion   boolean NOT NULL DEFAULT false,
  motivo          text,
  lote_id         uuid NOT NULL UNIQUE REFERENCES fin.lote(id),
  creado_en       timestamptz NOT NULL DEFAULT now(),
  creado_por      text DEFAULT org.usuario_actual(),
  CHECK (hasta >= desde),
  CHECK (total >= 0),
  CHECK (NOT fuera_gestion OR motivo IS NOT NULL),
  UNIQUE (procesador_id, desde)
);
COMMENT ON TABLE fin.liquidacion IS
  'Liquidación semanal de un procesador que liquida por semana con facturas (PedidosYa): sus cobros forman el lote, sus facturas quedan compensadas y lo que falta se asienta como costo.';

CREATE TABLE fin.liquidacion_comprobante (
  liquidacion_id   uuid NOT NULL REFERENCES fin.liquidacion(id) ON DELETE CASCADE,
  comprobante_id   uuid NOT NULL UNIQUE REFERENCES fin.comprobante(id),
  importe          numeric(16,2) NOT NULL CHECK (importe > 0),
  cc_movimiento_id bigint NOT NULL REFERENCES fin.movimiento_cc(id),
  PRIMARY KEY (liquidacion_id, comprobante_id)
);
COMMENT ON TABLE fin.liquidacion_comprobante IS 'Facturas del procesador compensadas con la liquidación: no generan deuda.';

CREATE TABLE fin.liquidacion_costo (
  liquidacion_id uuid NOT NULL REFERENCES fin.liquidacion(id) ON DELETE CASCADE,
  movimiento_id  bigint NOT NULL UNIQUE REFERENCES fin.movimiento_tes(id),
  PRIMARY KEY (liquidacion_id, movimiento_id)
);
COMMENT ON TABLE fin.liquidacion_costo IS 'Egresos de "a acreditar" que asentó la liquidación (publicidad, IVA, percepciones, diferencia).';

-- Una factura compensada no está pendiente de pago.
CREATE OR REPLACE VIEW fin.comprobante_pendiente AS
 SELECT id AS comprobante_id, proveedor_id, tipo, letra, punto_venta, numero, fecha,
        COALESCE(vencimiento, fecha) AS vencimiento,
        total
          - COALESCE((SELECT sum(n.total) FROM fin.comprobante n
                       WHERE n.asociado_id = c.id AND n.tipo = 'nota_credito' AND n.estado = 'registrado'), 0)
          - COALESCE((SELECT sum(a.importe) FROM fin.orden_pago_aplicacion a JOIN fin.orden_pago o ON o.id = a.orden_pago_id
                       WHERE a.comprobante_id = c.id AND o.estado = 'registrada'), 0)
          - COALESCE((SELECT sum(lc.importe) FROM fin.liquidacion_comprobante lc WHERE lc.comprobante_id = c.id), 0) AS pendiente,
        sociedad_id
   FROM fin.comprobante c
  WHERE estado = 'registrado' AND tipo IN ('factura', 'nota_debito');

-- Una factura compensada no se anula suelta: se deshace la liquidación.
CREATE OR REPLACE FUNCTION fin.comprobante_sin_pagos() RETURNS trigger AS $$
BEGIN
  IF NEW.estado = 'anulado' AND OLD.estado = 'registrado' AND EXISTS (
       SELECT 1 FROM fin.orden_pago_aplicacion a JOIN fin.orden_pago o ON o.id = a.orden_pago_id
        WHERE a.comprobante_id = NEW.id AND o.estado = 'registrada') THEN
    RAISE EXCEPTION 'El comprobante tiene pagos aplicados: anulá primero la orden de pago.';
  END IF;
  IF NEW.estado = 'anulado' AND OLD.estado = 'registrado' AND EXISTS (
       SELECT 1 FROM fin.liquidacion_comprobante WHERE comprobante_id = NEW.id) THEN
    RAISE EXCEPTION 'La factura está compensada con una liquidación de PedidosYa: deshacé la liquidación.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
