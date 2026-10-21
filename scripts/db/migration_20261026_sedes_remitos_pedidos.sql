-- Fase 1: sedes, unidades productivas, notas de pedido y remitos internos entre sedes.
--
-- El modelo de stock no cambia: un remito es un DOCUMENTO que agrupa traslados del libro mayor,
-- como una compra agrupa entradas. Despachar asienta los traslados del centro al local en el
-- momento (decisión de Fer: sin estado "en tránsito"); el local confirma al recibir, y lo que no
-- llegó sale como faltante del remito, con motivo. Nada se reescribe: un faltante es un movimiento
-- más, atado al remito.

-- ── Almacenes: el nombre es único dentro de la sede ──────────────────────────────────────────
-- Con un solo lugar daba igual; con locales, "Depósito" va a existir en todos.
DROP INDEX logic.almacen_nombre_ux;
CREATE UNIQUE INDEX almacen_nombre_ux ON logic.almacen (sede_id, lower(btrim(nombre)));

CREATE OR REPLACE FUNCTION logic.sede_de_ubicacion(p_ubicacion uuid) RETURNS uuid AS $$
  SELECT a.sede_id FROM logic.ubicacion u JOIN logic.almacen a ON a.id = u.almacen_id WHERE u.id = p_ubicacion;
$$ LANGUAGE sql STABLE;

-- ── Unidades productivas ─────────────────────────────────────────────────────────────────────
-- Un sector de producción de una sede (pastelería, cocina fría, panadería): de qué almacén toma
-- los insumos y dónde deja lo elaborado. Las recetas y las producciones se asignan a una.
CREATE TABLE logic.unidad_productiva (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id              uuid NOT NULL REFERENCES org.sede(id),
  nombre               text NOT NULL CHECK (btrim(nombre) <> ''),
  almacen_id           uuid NOT NULL REFERENCES logic.almacen(id),
  ubicacion_salida_id  uuid REFERENCES logic.ubicacion(id),
  activa               boolean NOT NULL DEFAULT true,
  creado_en            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX unidad_productiva_nombre_ux ON logic.unidad_productiva (sede_id, lower(btrim(nombre)));

-- El almacén de insumos y la ubicación de salida son de la misma sede que la unidad: producir en
-- el centro con insumos de un local sería un traslado entre sedes sin remito.
CREATE OR REPLACE FUNCTION logic.unidad_productiva_coherente() RETURNS trigger AS $$
BEGIN
  IF (SELECT sede_id FROM logic.almacen WHERE id = NEW.almacen_id) <> NEW.sede_id THEN
    RAISE EXCEPTION 'El almacén de insumos tiene que ser de la misma sede que la unidad productiva.';
  END IF;
  IF NEW.ubicacion_salida_id IS NOT NULL AND logic.sede_de_ubicacion(NEW.ubicacion_salida_id) <> NEW.sede_id THEN
    RAISE EXCEPTION 'La ubicación de salida tiene que ser de la misma sede que la unidad productiva.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER unidad_productiva_coherente BEFORE INSERT OR UPDATE ON logic.unidad_productiva
  FOR EACH ROW EXECUTE FUNCTION logic.unidad_productiva_coherente();

ALTER TABLE logic.receta ADD COLUMN unidad_productiva_id uuid REFERENCES logic.unidad_productiva(id);
ALTER TABLE logic.produccion ADD COLUMN unidad_productiva_id uuid REFERENCES logic.unidad_productiva(id);

-- ── Notas de pedido ──────────────────────────────────────────────────────────────────────────
-- Un local le pide al centro. Es un pedido manual (sin mínimos por local, decisión de Fer); el
-- centro lo convierte en remito y ahí se eligen los lotes.
CREATE SEQUENCE logic.pedido_numero_seq;
CREATE TABLE logic.pedido (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero              bigint NOT NULL UNIQUE DEFAULT nextval('logic.pedido_numero_seq'),
  sede_id             uuid NOT NULL REFERENCES org.sede(id),     -- quien pide
  proveedora_sede_id  uuid NOT NULL REFERENCES org.sede(id),     -- a quien le pide
  estado              text NOT NULL DEFAULT 'borrador'
                      CHECK (estado IN ('borrador','enviado','remitido','anulado')),
  necesario_para      date,
  notas               text,
  creado_por          text DEFAULT org.usuario_actual(),
  creado_en           timestamptz NOT NULL DEFAULT now(),
  enviado_por         text,
  enviado_en          timestamptz,
  CHECK (sede_id <> proveedora_sede_id)
);
CREATE INDEX pedido_sedes_ix ON logic.pedido (sede_id, proveedora_sede_id, estado);

CREATE TABLE logic.pedido_item (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id      uuid NOT NULL REFERENCES logic.pedido(id) ON DELETE CASCADE,
  producto_id    uuid NOT NULL REFERENCES logic.producto(id),
  cantidad_base  numeric(16,4) NOT NULL CHECK (cantidad_base > 0),
  notas          text,
  UNIQUE (pedido_id, producto_id)
);

CREATE OR REPLACE FUNCTION logic.pedido_cerrado() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.estado <> 'borrador' THEN
    RAISE EXCEPTION 'Sólo se borra un pedido en borrador; uno enviado se anula.';
  END IF;
  -- Anulado es final. Remitido sólo vuelve a enviado: pasa cuando se anula su remito, y el centro
  -- tiene que poder armarlo de nuevo.
  IF TG_OP = 'UPDATE' AND NEW.estado <> OLD.estado AND
     (OLD.estado = 'anulado' OR (OLD.estado = 'remitido' AND NEW.estado <> 'enviado')) THEN
    RAISE EXCEPTION 'El pedido está %: no cambia de estado.', OLD.estado;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER pedido_cerrado BEFORE UPDATE OR DELETE ON logic.pedido
  FOR EACH ROW EXECUTE FUNCTION logic.pedido_cerrado();

-- Lo que se pidió no se cambia después de enviarlo: es contra lo que se compara lo que llegó.
CREATE OR REPLACE FUNCTION logic.pedido_item_cerrado() RETURNS trigger AS $$
DECLARE est text;
BEGIN
  SELECT estado INTO est FROM logic.pedido
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.pedido_id ELSE NEW.pedido_id END;
  IF est IS DISTINCT FROM 'borrador' AND est IS NOT NULL THEN
    RAISE EXCEPTION 'El pedido ya fue enviado: sus renglones no se modifican.';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER pedido_item_cerrado BEFORE INSERT OR UPDATE OR DELETE ON logic.pedido_item
  FOR EACH ROW EXECUTE FUNCTION logic.pedido_item_cerrado();

-- ── Remitos internos ─────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE logic.remito_numero_seq;
CREATE TABLE logic.remito (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero                bigint NOT NULL UNIQUE DEFAULT nextval('logic.remito_numero_seq'),
  origen_sede_id        uuid NOT NULL REFERENCES org.sede(id),
  origen_almacen_id     uuid NOT NULL REFERENCES logic.almacen(id),   -- de dónde se eligen los lotes
  destino_sede_id       uuid NOT NULL REFERENCES org.sede(id),
  destino_ubicacion_id  uuid NOT NULL REFERENCES logic.ubicacion(id), -- dónde entra la mercadería
  pedido_id             uuid REFERENCES logic.pedido(id),
  estado                text NOT NULL DEFAULT 'borrador'
                        CHECK (estado IN ('borrador','enviado','recibido','anulado')),
  notas                 text,
  creado_por            text DEFAULT org.usuario_actual(),
  creado_en             timestamptz NOT NULL DEFAULT now(),
  enviado_por           text,
  enviado_en            timestamptz,
  recibido_por          text,
  recibido_en           timestamptz,
  anulado_por           text,
  anulado_en            timestamptz,
  motivo_anulacion      text,
  CHECK (origen_sede_id <> destino_sede_id),
  CHECK (estado <> 'anulado' OR motivo_anulacion IS NOT NULL)
);
CREATE INDEX remito_sedes_ix ON logic.remito (origen_sede_id, destino_sede_id, estado);
-- Un pedido se convierte en un solo remito.
CREATE UNIQUE INDEX remito_pedido_ux ON logic.remito (pedido_id) WHERE pedido_id IS NOT NULL AND estado <> 'anulado';

CREATE TABLE logic.remito_item (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  remito_id            uuid NOT NULL REFERENCES logic.remito(id) ON DELETE CASCADE,
  producto_id          uuid NOT NULL REFERENCES logic.producto(id),
  lote_id              uuid REFERENCES logic.lote(id),
  origen_ubicacion_id  uuid NOT NULL REFERENCES logic.ubicacion(id),
  cantidad_base        numeric(16,4) NOT NULL CHECK (cantidad_base > 0),
  cantidad_recibida    numeric(16,4) CHECK (cantidad_recibida IS NULL OR cantidad_recibida >= 0),
  motivo_diferencia    text,
  pedido_item_id       uuid REFERENCES logic.pedido_item(id)
);
CREATE INDEX remito_item_remito_ix ON logic.remito_item (remito_id);

-- Las puntas del remito tienen que corresponder a sus sedes.
CREATE OR REPLACE FUNCTION logic.remito_coherente() RETURNS trigger AS $$
BEGIN
  IF (SELECT sede_id FROM logic.almacen WHERE id = NEW.origen_almacen_id) <> NEW.origen_sede_id THEN
    RAISE EXCEPTION 'El almacén de origen no es de la sede de origen.';
  END IF;
  IF logic.sede_de_ubicacion(NEW.destino_ubicacion_id) <> NEW.destino_sede_id THEN
    RAISE EXCEPTION 'La ubicación de destino no es de la sede de destino.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER remito_coherente BEFORE INSERT OR UPDATE OF origen_almacen_id, destino_ubicacion_id ON logic.remito
  FOR EACH ROW EXECUTE FUNCTION logic.remito_coherente();

-- Estados: borrador -> enviado -> recibido, o -> anulado desde borrador o enviado. Recibido y
-- anulado son finales: lo despachado y lo confirmado no se reescriben.
CREATE OR REPLACE FUNCTION logic.remito_cerrado() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.estado <> 'borrador' THEN
      RAISE EXCEPTION 'Sólo se borra un remito en borrador; uno despachado se anula.';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.estado <> OLD.estado AND NOT (
       (OLD.estado = 'borrador' AND NEW.estado IN ('enviado','anulado')) OR
       (OLD.estado = 'enviado'  AND NEW.estado IN ('recibido','anulado'))) THEN
    RAISE EXCEPTION 'Un remito % no puede pasar a %.', OLD.estado, NEW.estado;
  END IF;
  IF OLD.estado <> 'borrador' AND (NEW.origen_almacen_id <> OLD.origen_almacen_id
       OR NEW.destino_ubicacion_id <> OLD.destino_ubicacion_id OR NEW.destino_sede_id <> OLD.destino_sede_id) THEN
    RAISE EXCEPTION 'El remito ya fue despachado: no cambia de origen ni de destino.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER remito_cerrado BEFORE UPDATE OR DELETE ON logic.remito
  FOR EACH ROW EXECUTE FUNCTION logic.remito_cerrado();

-- Renglones: se editan en borrador. Despachado, sólo se completa la recepción (cantidad recibida
-- y motivo de la diferencia). Recibido o anulado, nada.
CREATE OR REPLACE FUNCTION logic.remito_item_cerrado() RETURNS trigger AS $$
DECLARE r record;
BEGIN
  SELECT estado, origen_sede_id INTO r FROM logic.remito
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.remito_id ELSE NEW.remito_id END;
  IF r.estado IS NULL THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;  -- cascada del borrado
  IF r.estado = 'borrador' THEN
    IF TG_OP <> 'DELETE' AND logic.sede_de_ubicacion(NEW.origen_ubicacion_id) <> r.origen_sede_id THEN
      RAISE EXCEPTION 'La ubicación de origen del renglón no es de la sede que despacha.';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF r.estado = 'enviado' AND TG_OP = 'UPDATE'
     AND (NEW.producto_id, NEW.lote_id, NEW.origen_ubicacion_id, NEW.cantidad_base, NEW.pedido_item_id)
         IS NOT DISTINCT FROM (OLD.producto_id, OLD.lote_id, OLD.origen_ubicacion_id, OLD.cantidad_base, OLD.pedido_item_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'El remito está %: sus renglones no se modifican.', r.estado;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER remito_item_cerrado BEFORE INSERT OR UPDATE OR DELETE ON logic.remito_item
  FOR EACH ROW EXECUTE FUNCTION logic.remito_item_cerrado();

-- ── Movimientos: un traslado entre sedes sólo con remito ─────────────────────────────────────
ALTER TABLE logic.movimiento ADD COLUMN remito_id uuid REFERENCES logic.remito(id);
CREATE INDEX movimiento_remito_ix ON logic.movimiento (remito_id) WHERE remito_id IS NOT NULL;

-- Entre dos sedes, la mercadería cambia de responsable: tiene que haber un documento que lo diga
-- y alguien del otro lado que lo confirme. Por eso un traslado entre sedes sin remito se rechaza.
-- Con remito, el permiso se verifica en la punta de la sede que despacha (quien despacha no
-- necesita rol en el local); la confirmación del local va por la recepción, con su propio usuario.
-- Dentro de una misma sede, como antes: permiso en las dos puntas.
CREATE OR REPLACE FUNCTION logic.movimiento_firma() RETURNS trigger AS $$
DECLARE
  so uuid := logic.sede_de_ubicacion(NEW.origen_id);
  sd uuid := logic.sede_de_ubicacion(NEW.destino_id);
  r  record;
BEGIN
  IF so IS NOT NULL AND sd IS NOT NULL AND so <> sd THEN
    IF NEW.remito_id IS NULL THEN
      RAISE EXCEPTION 'Un traslado entre sedes va con remito: armalo desde Remitos.';
    END IF;
    SELECT origen_sede_id, destino_sede_id INTO r FROM logic.remito WHERE id = NEW.remito_id;
    IF NOT ((so = r.origen_sede_id AND sd = r.destino_sede_id) OR (so = r.destino_sede_id AND sd = r.origen_sede_id)) THEN
      RAISE EXCEPTION 'El traslado no coincide con las sedes del remito.';
    END IF;
    PERFORM org.exigir_operar(CASE WHEN so = r.origen_sede_id THEN NEW.origen_id ELSE NEW.destino_id END);
  ELSE
    PERFORM org.exigir_operar(NEW.origen_id);
    PERFORM org.exigir_operar(NEW.destino_id);
  END IF;
  NEW.registrado_por := COALESCE(org.usuario_actual(), NEW.registrado_por);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
