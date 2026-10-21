-- Fase 4: integración con los puntos de venta (Fudo por API, Maxirest y otros por archivo).
--
-- ClauLogic no vende: recibe lo que vendió cada local. Dos efectos, que se procesan por separado
-- porque son de áreas distintas:
--   · CONSUMO TEÓRICO (operación): cada artículo vendido tiene su receta de venta (plato), y lo
--     vendido descuenta los ingredientes del stock del local. Los conteos del local dan después la
--     diferencia entre teórico y real.
--   · COBROS (finanzas): lo cobrado por cada medio entra a su cuenta (el efectivo a la caja del
--     local; tarjetas y QR a una cuenta de cobranza que se acredita después en el banco).
--
-- Todo lo que llega del POS entra a tablas de RECEPCIÓN idempotentes: un ticket se identifica por
-- su id en el POS, y reimportar el mismo día no duplica nada. Las tablas de recepción no son el
-- libro mayor: lo que mueve stock y plata son los movimientos que genera el procesamiento.
CREATE SCHEMA pos;

-- ── Recetas de venta ─────────────────────────────────────────────────────────────────────────
-- Un plato de la carta y lo que consume una porción. No produce stock (para eso está la receta de
-- producción): sólo dice qué se descuenta cuando se vende.
CREATE TABLE logic.plato (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     text NOT NULL CHECK (btrim(nombre) <> ''),
  notas      text,
  activo     boolean NOT NULL DEFAULT true,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX plato_nombre_ux ON logic.plato (lower(btrim(nombre)));

CREATE TABLE logic.plato_item (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plato_id       uuid NOT NULL REFERENCES logic.plato(id) ON DELETE CASCADE,
  producto_id    uuid NOT NULL REFERENCES logic.producto(id),
  cantidad_base  numeric(16,4) NOT NULL CHECK (cantidad_base > 0),     -- por porción, neto
  merma_pct      numeric(5,2) NOT NULL DEFAULT 0 CHECK (merma_pct >= 0 AND merma_pct < 100),
  UNIQUE (plato_id, producto_id)
);

-- ── Integraciones ────────────────────────────────────────────────────────────────────────────
-- Un POS de un local. Las credenciales de API van cifradas (AES-256-GCM, app/crypto.js) y nunca
-- vuelven al navegador. El consumo se descuenta del almacén del local, y lo que no tiene stock
-- queda en negativo en la ubicación indicada (decisión de Fer).
CREATE TABLE pos.integracion (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id          uuid NOT NULL REFERENCES org.sede(id),
  sistema          text NOT NULL CHECK (sistema IN ('fudo','maxirest','otro')),
  modo             text NOT NULL CHECK (modo IN ('api','archivo')),
  nombre           text NOT NULL CHECK (btrim(nombre) <> ''),
  credenciales     text,                                   -- gcm$… ; sólo modo api
  almacen_id       uuid NOT NULL REFERENCES logic.almacen(id),
  ubicacion_id     uuid NOT NULL REFERENCES logic.ubicacion(id),   -- donde queda el negativo
  mapeo            jsonb NOT NULL DEFAULT '{}',            -- columnas de los archivos, recordadas
  activa           boolean NOT NULL DEFAULT true,
  ultima_sincronizacion timestamptz,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  CHECK (sistema <> 'maxirest' OR modo = 'archivo'),
  CHECK (modo = 'api' OR credenciales IS NULL)
);
CREATE UNIQUE INDEX integracion_nombre_ux ON pos.integracion (lower(btrim(nombre)));

-- Almacén y ubicación son del local de la integración: el consumo de un local no sale de otro.
CREATE OR REPLACE FUNCTION pos.integracion_coherente() RETURNS trigger AS $$
BEGIN
  IF (SELECT sede_id FROM logic.almacen WHERE id = NEW.almacen_id) <> NEW.sede_id THEN
    RAISE EXCEPTION 'El almacén de consumo tiene que ser de la sede de la integración.';
  END IF;
  IF (SELECT almacen_id FROM logic.ubicacion WHERE id = NEW.ubicacion_id) <> NEW.almacen_id THEN
    RAISE EXCEPTION 'La ubicación tiene que ser del almacén de consumo.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER integracion_coherente BEFORE INSERT OR UPDATE ON pos.integracion
  FOR EACH ROW EXECUTE FUNCTION pos.integracion_coherente();

-- Artículos y medios de cobro tal como los nombra el POS, con su equivalencia en ClauLogic.
CREATE TABLE pos.articulo (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integracion_id   uuid NOT NULL REFERENCES pos.integracion(id),
  codigo_externo   text NOT NULL,
  nombre           text NOT NULL,
  plato_id         uuid REFERENCES logic.plato(id),
  -- Artículos que no consumen stock (servicio de mesa, propina, cubierto): se marcan y no quedan
  -- como pendientes de receta.
  sin_consumo      boolean NOT NULL DEFAULT false,
  UNIQUE (integracion_id, codigo_externo)
);

CREATE TABLE pos.medio (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integracion_id   uuid NOT NULL REFERENCES pos.integracion(id),
  codigo_externo   text NOT NULL,
  nombre           text NOT NULL,
  cuenta_id        uuid REFERENCES fin.cuenta(id),
  UNIQUE (integracion_id, codigo_externo)
);

-- ── Recepción ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE pos.importacion (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integracion_id    uuid NOT NULL REFERENCES pos.integracion(id),
  origen            text NOT NULL CHECK (origen IN ('api','archivo')),
  archivo           text,
  desde             date,
  hasta             date,
  tickets_nuevos    int NOT NULL DEFAULT 0,
  tickets_repetidos int NOT NULL DEFAULT 0,
  estado            text NOT NULL DEFAULT 'recibida' CHECK (estado IN ('recibida','anulada')),
  creado_por        text DEFAULT org.usuario_actual(),
  creado_en         timestamptz NOT NULL DEFAULT now(),
  anulado_por       text,
  anulado_en        timestamptz,
  motivo_anulacion  text
);
CREATE INDEX importacion_integracion_ix ON pos.importacion (integracion_id, creado_en DESC);

-- Un ticket es único por su id en el POS: es lo que hace idempotente la importación.
CREATE TABLE pos.ticket (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integracion_id  uuid NOT NULL REFERENCES pos.integracion(id),
  importacion_id  uuid NOT NULL REFERENCES pos.importacion(id),
  id_externo      text NOT NULL,
  cerrado_en      timestamptz NOT NULL,
  estado          text NOT NULL CHECK (estado IN ('cerrado','anulado')),
  total           numeric(16,2),
  tipo            text,            -- salón, para llevar
  mesa            text,
  mozo            text,
  personas        int,
  UNIQUE (integracion_id, id_externo)
);
CREATE INDEX ticket_importacion_ix ON pos.ticket (importacion_id);
CREATE INDEX ticket_cerrado_ix ON pos.ticket (integracion_id, cerrado_en);

-- ── Procesamiento ────────────────────────────────────────────────────────────────────────────
-- Cada pasada de consumo o de cobro queda registrada y es lo que referencian los movimientos que
-- generó. Una importación puede tener varias: la primera procesa lo que tiene receta, y cuando se
-- completan recetas faltantes, otra procesa lo que había quedado pendiente.
CREATE TABLE pos.consumo (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  importacion_id   uuid NOT NULL REFERENCES pos.importacion(id),
  sede_id          uuid NOT NULL REFERENCES org.sede(id),
  renglones        int NOT NULL,
  estado           text NOT NULL DEFAULT 'procesado' CHECK (estado IN ('procesado','anulado')),
  creado_por       text DEFAULT org.usuario_actual(),
  creado_en        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pos.cobro (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  importacion_id   uuid NOT NULL REFERENCES pos.importacion(id),
  pagos            int NOT NULL,
  estado           text NOT NULL DEFAULT 'procesado' CHECK (estado IN ('procesado','anulado')),
  creado_por       text DEFAULT org.usuario_actual(),
  creado_en        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pos.ticket_item (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    uuid NOT NULL REFERENCES pos.ticket(id) ON DELETE CASCADE,
  articulo_id  uuid NOT NULL REFERENCES pos.articulo(id),
  cantidad     numeric(16,4) NOT NULL CHECK (cantidad > 0),
  precio       numeric(16,4),
  importe      numeric(16,2),
  anulado      boolean NOT NULL DEFAULT false,
  consumo_id   uuid REFERENCES pos.consumo(id)           -- NULL: todavía no se descontó
);
CREATE INDEX ticket_item_ticket_ix ON pos.ticket_item (ticket_id);
CREATE INDEX ticket_item_pendiente_ix ON pos.ticket_item (articulo_id) WHERE consumo_id IS NULL AND NOT anulado;

CREATE TABLE pos.ticket_pago (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  uuid NOT NULL REFERENCES pos.ticket(id) ON DELETE CASCADE,
  medio_id   uuid NOT NULL REFERENCES pos.medio(id),
  importe    numeric(16,2) NOT NULL,
  anulado    boolean NOT NULL DEFAULT false,
  cobro_id   uuid REFERENCES pos.cobro(id)
);
CREATE INDEX ticket_pago_ticket_ix ON pos.ticket_pago (ticket_id);

-- Los movimientos de stock y de tesorería apuntan a la pasada que los generó.
ALTER TABLE logic.movimiento ADD COLUMN pos_consumo_id uuid REFERENCES pos.consumo(id);
CREATE INDEX movimiento_pos_consumo_ix ON logic.movimiento (pos_consumo_id) WHERE pos_consumo_id IS NOT NULL;
ALTER TABLE fin.movimiento_tes ADD COLUMN pos_cobro_id uuid REFERENCES pos.cobro(id);

-- Cobros: nuevo tipo de movimiento de tesorería, y cuentas de cobranza (tarjetas, QR, billeteras)
-- que se acreditan después en el banco con una transferencia.
ALTER TABLE fin.movimiento_tes DROP CONSTRAINT movimiento_tes_tipo_check;
ALTER TABLE fin.movimiento_tes ADD CONSTRAINT movimiento_tes_tipo_check CHECK (tipo IN
  ('pago','transferencia','ingreso','egreso','arqueo','alta_cheque','endoso','deposito_cheque','debito_cheque','anulacion','cobro'));
ALTER TABLE fin.cuenta DROP CONSTRAINT cuenta_tipo_check;
ALTER TABLE fin.cuenta ADD CONSTRAINT cuenta_tipo_check CHECK (tipo IN ('banco','caja','cartera','cobranza'));

-- Lo que se vendió y todavía no descontó stock: artículos sin receta (y no marcados como sin
-- consumo), con cuánto se vendió. Es la lista que hay que completar para que el teórico cierre.
CREATE VIEW pos.articulo_pendiente AS
SELECT a.id AS articulo_id, a.integracion_id, a.codigo_externo, a.nombre,
       SUM(i.cantidad) AS cantidad, COUNT(DISTINCT t.id) AS tickets, MIN(t.cerrado_en) AS desde
  FROM pos.articulo a
  JOIN pos.ticket_item i ON i.articulo_id = a.id AND i.consumo_id IS NULL AND NOT i.anulado
  JOIN pos.ticket t ON t.id = i.ticket_id AND t.estado = 'cerrado'
 WHERE a.plato_id IS NULL AND NOT a.sin_consumo
 GROUP BY a.id;
