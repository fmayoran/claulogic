-- Traer el extracto de Pago24 desde su portal (pedido de Fer, 03/11/2026; etapa 2): a mano ("Traer ahora") o todos los días
-- después de la sincronización de las ventas. Cada corrida queda con su rango y su resultado o su error, como las de los
-- puntos de venta (pos.corrida); una automática por procesador y por día.
ALTER TABLE fin.procesador ADD COLUMN portal_auto boolean NOT NULL DEFAULT true;

CREATE TABLE fin.portal_corrida (
  id             bigserial PRIMARY KEY,
  procesador_id  uuid NOT NULL REFERENCES fin.procesador(id),
  fecha          date NOT NULL DEFAULT current_date,
  automatica     boolean NOT NULL,
  desde          date NOT NULL,
  hasta          date NOT NULL,
  iniciada_en    timestamptz NOT NULL DEFAULT now(),
  terminada_en   timestamptz,
  ok             boolean,
  resultado      jsonb,
  error          text,
  creado_por     text DEFAULT org.usuario_actual()
);
CREATE UNIQUE INDEX portal_corrida_automatica_ux ON fin.portal_corrida (procesador_id, fecha) WHERE automatica;
CREATE INDEX portal_corrida_procesador_ix ON fin.portal_corrida (procesador_id, iniciada_en DESC);
