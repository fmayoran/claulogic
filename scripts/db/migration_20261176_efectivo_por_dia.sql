-- Rendir efectivo eligiendo días sueltos (pedido de Fer, 25/11/2026: tildar un día del medio tildaba todos los anteriores).
-- Hasta ahora el pendiente de cada día se deducía del saldo de la cuenta de efectivo suponiendo que lo rendido cubre primero lo más
-- viejo. Ahora cada rendición (y cada gasto pagado con la caja) dice qué parte va a cada día. El pendiente de un día es su efectivo
-- menos lo aplicado a él; lo rendido sin días (antes de esta migración, o una diferencia de caja) sigue cubriendo lo más viejo.
-- Un movimiento anulado deja de aplicar (se filtra al leer, como el resto del libro mayor).
BEGIN;

CREATE TABLE fin.efectivo_aplicado (
  movimiento_id bigint NOT NULL REFERENCES fin.movimiento_tes(id),
  cuenta_id     uuid NOT NULL REFERENCES fin.cuenta(id),
  dia           date NOT NULL,
  importe       numeric(16,2) NOT NULL CHECK (importe > 0),
  creado_en     timestamptz NOT NULL DEFAULT now(),
  creado_por    text DEFAULT org.usuario_actual(),
  PRIMARY KEY (movimiento_id, dia)
);
CREATE INDEX efectivo_aplicado_cuenta_ix ON fin.efectivo_aplicado (cuenta_id, dia);

COMMENT ON TABLE fin.efectivo_aplicado IS
  'Qué parte de una rendición o de un gasto pagado con el efectivo de un local corresponde a cada día de ventas. Sin filas, lo rendido cubre primero lo más viejo.';

CREATE OR REPLACE FUNCTION fin.efectivo_aplicado_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'fin.efectivo_aplicado no se modifica: se anula el movimiento.'; END $$;
CREATE TRIGGER efectivo_aplicado_sin_update BEFORE UPDATE OR DELETE ON fin.efectivo_aplicado
  FOR EACH ROW EXECUTE FUNCTION fin.efectivo_aplicado_inmutable();

COMMIT;
