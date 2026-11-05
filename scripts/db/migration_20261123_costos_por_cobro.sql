-- Costos de PedidosYa, devengados el día de la venta (decisión de Fer, 05/11/2026). PedidosYa liquida el neto, y su archivo
-- trae por pedido el desglose exacto de lo que descuenta: comisión, comisión por pago en línea, el IVA de las dos, marketing y
-- otros cargos, más el descuento que financia el local. Opción B de Fer: la venta va por el total parcial (precio de carta) y
-- el descuento financiado por el local es un costo ("Descuentos y promociones"), así se ve cuánto cuestan las promociones.
-- Lo que financia PedidosYa no es plata del local y no se registra.
--
-- Cada pago guarda sus costos (pos.ticket_pago.costos: [{gasto, concepto, importe}], importe positivo = cuesta). Al procesar
-- los cobros del día se asientan como egresos de la cuenta "a acreditar", sumados por concepto, con el mismo cobro: así esa
-- cuenta queda con el neto que va a depositar PedidosYa y anular el cobro (o la importación) los revierte. El estado de
-- resultados los toma por su tipo de gasto en el día de la venta y la filial de la cuenta.

ALTER TABLE pos.ticket_pago ADD COLUMN costos jsonb CHECK (costos IS NULL OR jsonb_typeof(costos) = 'array');
COMMENT ON COLUMN pos.ticket_pago.costos IS
  'Costos que el procesador descuenta de este pago, informados por él (PedidosYa): [{gasto, concepto, importe}]. Se asientan al procesar el cobro.';

ALTER TABLE fin.movimiento_tes DROP CONSTRAINT movimiento_tes_gasto_check;
ALTER TABLE fin.movimiento_tes ADD CONSTRAINT movimiento_tes_gasto_check
  CHECK (gasto IN ('comision', 'iva_credito', 'imp_debitos_creditos', 'retencion', 'descuento', 'marketing', 'otro'));

INSERT INTO fin.rubro (nombre, linea, clave, orden) VALUES
  ('Descuentos y promociones', 'cobro', 'descuento', 32),
  ('Publicidad y marketing', 'operativos', 'marketing', 55);

CREATE OR REPLACE FUNCTION fin.rubro_de(p_rubro uuid, p_gasto text, p_concepto text) RETURNS uuid AS $$
  SELECT COALESCE(p_rubro, (SELECT id FROM fin.rubro WHERE clave = CASE
    WHEN p_gasto = 'retencion' AND p_concepto ~* 'sircreb|iibb|ingresos\s+brutos' THEN 'iibb'
    WHEN p_gasto IN ('comision','iva_credito','imp_debitos_creditos','retencion','descuento','marketing') THEN p_gasto
    WHEN p_gasto = 'otro' AND p_concepto ~* '^(faltante|sobrante) de caja' THEN 'dif_caja'
    WHEN p_gasto = 'otro' AND p_concepto ~* '^diferencia con el lote' THEN 'dif_acreditacion'
  END))
$$ LANGUAGE sql STABLE;
