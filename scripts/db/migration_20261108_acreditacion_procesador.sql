-- Acreditación de los procesadores (decisiones de Fer, 25/10/2026). Lo cobrado con un procesador entra, al procesar
-- los cobros del día, a su cuenta "a acreditar" (lo que el procesador nos debe). El procesador deposita en una cuenta
-- REAL (Pago24: su cuenta 210973; Mercado Pago: la billetera) operación por operación o en lotes, descontando sus
-- cargos e impuestos. El extracto de esa cuenta se importa y se concilia contra los pagos de las ventas:
--   · cada ingreso del extracto se parea con su pago (mismo importe, del día de la venta en adelante) y pasa de
--     "a acreditar" a la cuenta real con una transferencia;
--   · cargos, IVA de los cargos, impuesto a los débitos y créditos y retenciones se asientan como egresos de la
--     cuenta real, clasificados, y atados al pago por el número de operación del procesador;
--   · un movimiento y su reverso se compensan entre sí;
--   · lo demás (los pagos que salen de esa cuenta, por ejemplo) queda sin conciliar hasta que tenga su movimiento.
-- Así "a acreditar" es exactamente lo vendido que todavía no llegó, y el saldo de la cuenta real es el del extracto.

-- La cuenta donde el procesador deposita (un banco o una billetera, que se maneja como un banco).
ALTER TABLE fin.procesador ADD COLUMN cuenta_acredita_id uuid REFERENCES fin.cuenta(id);

-- Del extracto: saldos que trae (para controlar contra el sistema) y período.
ALTER TABLE fin.extracto ADD COLUMN saldo_inicial numeric(16,2), ADD COLUMN saldo_final numeric(16,2),
  ADD COLUMN desde date, ADD COLUMN hasta date;

-- De cada línea: la operación del procesador a la que se refiere (un cargo dice "por transferencia #1580009466"), y
-- la línea con la que se compensa (un movimiento y su reverso: ninguno de los dos necesita movimiento propio).
ALTER TABLE fin.extracto_linea ADD COLUMN operacion text, ADD COLUMN compensa_a bigint REFERENCES fin.extracto_linea(id);

-- El pago de la venta queda acreditado con la línea del extracto donde llegó.
ALTER TABLE pos.ticket_pago ADD COLUMN acreditado_linea_id bigint REFERENCES fin.extracto_linea(id);
CREATE INDEX ticket_pago_acreditado_ix ON pos.ticket_pago (acreditado_linea_id);

-- Clasificación de los egresos que no son pagos a proveedores, para el costo de cada medio y para el contador: el
-- IVA de un cargo es crédito fiscal; el impuesto a los débitos y créditos se toma en parte a cuenta de Ganancias.
-- `iva`: el IVA incluido en el importe, cuando el procesador lo cobra junto con el cargo. `ticket_pago_id`: el pago
-- de la venta al que corresponde (la acreditación y sus costos).
ALTER TABLE fin.movimiento_tes
  ADD COLUMN gasto text CHECK (gasto IN ('comision', 'iva_credito', 'imp_debitos_creditos', 'retencion', 'otro')),
  ADD COLUMN iva numeric(16,2),
  ADD COLUMN ticket_pago_id uuid REFERENCES pos.ticket_pago(id);
CREATE INDEX movimiento_tes_pago_ix ON fin.movimiento_tes (ticket_pago_id) WHERE ticket_pago_id IS NOT NULL;
