-- Un motivo por pedido (pedido de Fer, 17/11/2026): cada pedido cancelado o con reclamo de PedidosYa sale de las alarmas de Inicio
-- recién cuando tiene su motivo, de una lista (para poder contarlos después), con un detalle opcional; "Otro" exige el detalle.
-- La tabla estaba vacía (se creó el mismo día).
ALTER TABLE pos.cancelacion_revision ADD COLUMN motivo text NOT NULL CHECK (btrim(motivo) <> '');
ALTER TABLE pos.cancelacion_revision ALTER COLUMN nota DROP NOT NULL;
ALTER TABLE pos.cancelacion_revision DROP CONSTRAINT cancelacion_revision_nota_check;
ALTER TABLE pos.cancelacion_revision ADD CONSTRAINT cancelacion_revision_otro_check
  CHECK (motivo <> 'Otro' OR btrim(COALESCE(nota, '')) <> '');
COMMENT ON COLUMN pos.cancelacion_revision.motivo IS 'Motivo propio del pedido cancelado o con reclamo, de la lista de la pantalla (Inicio).';
COMMENT ON COLUMN pos.cancelacion_revision.nota IS 'Detalle opcional; obligatorio si el motivo es "Otro".';
