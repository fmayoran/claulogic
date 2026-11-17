-- Cancelaciones de PedidosYa como alerta (pedido de Fer, 17/11/2026: el 16/11 se cancelaron pedidos de SORELLE y el tablero no lo
-- ponía al frente). Cada pedido cancelado aparece en Inicio hasta que alguien lo revisa y anota qué pasó. La revisión es un dato
-- aparte del ticket (que viene del archivo y no se toca): quién, cuándo y la nota.
CREATE TABLE pos.cancelacion_revision (
  ticket_id    uuid PRIMARY KEY REFERENCES pos.ticket(id) ON DELETE CASCADE,
  nota         text NOT NULL CHECK (btrim(nota) <> ''),
  revisado_por text NOT NULL DEFAULT org.usuario_actual(),
  revisado_en  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE pos.cancelacion_revision IS 'Revisión de un pedido cancelado de PedidosYa: deja de ser alerta en Inicio. Se deshace borrando la fila.';
