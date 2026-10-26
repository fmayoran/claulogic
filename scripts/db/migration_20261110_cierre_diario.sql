-- Cierre diario de ingresos (decisiones de Fer, 26/10/2026). Cada punto de venta vende y cobra por su cuenta; la
-- central trae las ventas todos los días, controla el efectivo y que lo electrónico se acredite.
--   · La sincronización es automática si el sistema de venta va por API (todos los días a las 5:00, trae el día
--     anterior y repasa los dos de antes, por mesas que cerraron tarde) y manual si va por archivo. Se puede pausar
--     desde la ficha de la sede.
--   · Lo automático lo firma un usuario de sistema con permiso de finanzas ("sistema"): asienta cobros y lotes como
--     cualquier usuario de finanzas, pero no puede entrar a la app (no tiene clave) y no aparece en Usuarios.
--   · El efectivo de cada punto de venta queda en su cuenta a rendir hasta que llega a la central: rendir es una
--     transferencia a la caja central (o al banco), que se hace a mano cuando la plata efectivamente ingresa.

ALTER TABLE org.usuario ADD COLUMN de_sistema boolean NOT NULL DEFAULT false;
INSERT INTO org.usuario (usuario, nombre, clave_hash, debe_cambiar_clave, finanzas, de_sistema)
VALUES ('sistema', 'Proceso automático', 'sin-clave', false, true, true)
ON CONFLICT (usuario) DO NOTHING;
-- Si ya había un "sistema" (no debería), se lo convierte; sin tocar es_admin ni activo, que disparan el control de
-- "queda un administrador" aunque no cambie ninguna fila (y en una base nueva todavía no hay administrador).
UPDATE org.usuario SET de_sistema = true, finanzas = true, clave_hash = 'sin-clave' WHERE usuario = 'sistema';

ALTER TABLE pos.integracion ADD COLUMN sincroniza_auto boolean NOT NULL DEFAULT true;

-- Cada corrida de la sincronización (automática o pedida con "traer ahora"): qué rango trajo y qué resultó. Una
-- automática por punto de venta y por día: si la app se reinicia a las 5:10, no se repite.
CREATE TABLE pos.corrida (
  id              bigserial PRIMARY KEY,
  integracion_id  uuid NOT NULL REFERENCES pos.integracion(id),
  fecha           date NOT NULL DEFAULT current_date,
  automatica      boolean NOT NULL,
  desde           date NOT NULL,
  hasta           date NOT NULL,
  iniciada_en     timestamptz NOT NULL DEFAULT now(),
  terminada_en    timestamptz,
  ok              boolean,
  resultado       jsonb,
  error           text,
  creado_por      text DEFAULT org.usuario_actual()
);
CREATE UNIQUE INDEX corrida_automatica_ux ON pos.corrida (integracion_id, fecha) WHERE automatica;
CREATE INDEX corrida_integracion_ix ON pos.corrida (integracion_id, iniciada_en DESC);
