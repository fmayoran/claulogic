-- ══ NÚCLEO DE ClauLogic ══════════════════════════════════════════════════════════════════════
-- Gestión de almacén y producción para gastronomía: productos, compras, stock, cámaras de frío,
-- recetas y producción.
--
-- LA DECISIÓN DE FONDO: EL STOCK NO SE GUARDA, SE DERIVA.
-- No existe una columna `cantidad_actual` en ningún lado. El stock sale de sumar un LIBRO MAYOR de
-- movimientos inmutable. Guardar el stock como número es cómodo el primer día y es el origen de
-- todos los problemas después: dos operaciones simultáneas lo pisan, una corrección a mano lo
-- desvía, y cuando el número del sistema no coincide con el de la estantería nadie puede saber
-- cuál de los dos miente ni desde cuándo. Derivándolo, el stock SIEMPRE es explicable: cada
-- unidad tiene su movimiento con fecha, motivo y responsable. Si hay que corregir, se asienta un
-- movimiento de ajuste; no se edita el pasado.
--
-- TODO EN LA UNIDAD BASE. Se compra en cajas, se cocina en gramos y se cuenta en unidades. Cada
-- producto tiene UNA unidad base y todo lo demás convierte a ella. Sin esto, "2" no significa nada.
--
-- PLATA Y CANTIDADES EN NUMERIC, NUNCA EN FLOAT. 0,1 + 0,2 en coma flotante no da 0,3, y un
-- inventario que no cierra por centésimas es un inventario que nadie va a volver a mirar.

-- ── Vocabulario de medida ────────────────────────────────────────────────────────────────────
-- La magnitud permite VALIDAR conversiones: de kg a g sí, de kg a litros no. Sin eso, un factor
-- mal cargado convierte peso en volumen y nadie se entera hasta que falta mercadería.
CREATE TABLE logic.unidad (
  codigo    text PRIMARY KEY,
  nombre    text NOT NULL,
  magnitud  text NOT NULL CHECK (magnitud IN ('masa','volumen','conteo')),
  factor_si numeric(20,8) NOT NULL CHECK (factor_si > 0)   -- a la unidad base de su magnitud
);
INSERT INTO logic.unidad (codigo, nombre, magnitud, factor_si) VALUES
  ('g',  'gramo',      'masa',    1),
  ('kg', 'kilogramo',  'masa',    1000),
  ('ml', 'mililitro',  'volumen', 1),
  ('l',  'litro',      'volumen', 1000),
  ('u',  'unidad',     'conteo',  1);

-- ── Qué manejamos ────────────────────────────────────────────────────────────────────────────
CREATE TABLE logic.producto (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo          text UNIQUE NOT NULL,               -- el que se usa en la estantería y la etiqueta
  nombre          text NOT NULL,
  categoria       text,
  unidad_base     text NOT NULL REFERENCES logic.unidad(codigo),
  -- Perecedero obliga a lote con vencimiento (lo exige un CHECK en logic.lote). Es la diferencia
  -- entre poder contestar "qué se vence esta semana" y no poder.
  perecedero      boolean NOT NULL DEFAULT true,
  vida_util_dias  int CHECK (vida_util_dias IS NULL OR vida_util_dias > 0),
  -- Rango de conservación del PRODUCTO. Se compara contra el de la ubicación donde está guardado.
  temp_min        numeric(5,2),
  temp_max        numeric(5,2),
  stock_minimo    numeric(16,4) CHECK (stock_minimo IS NULL OR stock_minimo >= 0),
  activo          boolean NOT NULL DEFAULT true,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  CHECK (temp_min IS NULL OR temp_max IS NULL OR temp_min <= temp_max)
);
CREATE INDEX producto_activo_ix ON logic.producto (activo, nombre);

-- Cómo se COMPRA: "caja de 6 x 1 kg" = 6000 g. El factor es a la unidad base del producto.
CREATE TABLE logic.presentacion (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id    uuid NOT NULL REFERENCES logic.producto(id) ON DELETE CASCADE,
  nombre         text NOT NULL,                        -- "caja x6", "bolsa 25 kg"
  cantidad_base  numeric(16,4) NOT NULL CHECK (cantidad_base > 0),
  es_default     boolean NOT NULL DEFAULT false,
  UNIQUE (producto_id, nombre)
);

CREATE TABLE logic.proveedor (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     text NOT NULL,
  cuit       text,
  contacto   text,
  telefono   text,
  email      text,
  notas      text,
  activo     boolean NOT NULL DEFAULT true,
  creado_en  timestamptz NOT NULL DEFAULT now()
);

-- ── Dónde se guarda ──────────────────────────────────────────────────────────────────────────
-- Las cámaras y heladeras son ubicaciones como cualquier otra: así una sola consulta contesta
-- "qué hay acá adentro", sea un depósito seco o una cámara de frío.
CREATE TABLE logic.ubicacion (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre    text UNIQUE NOT NULL,
  tipo      text NOT NULL CHECK (tipo IN ('deposito','camara','heladera','freezer','cocina','salon')),
  temp_min  numeric(5,2),
  temp_max  numeric(5,2),
  activa    boolean NOT NULL DEFAULT true,
  CHECK (temp_min IS NULL OR temp_max IS NULL OR temp_min <= temp_max),
  -- Una cámara sin rango no se puede controlar: el control de frío necesita contra qué comparar.
  CHECK (tipo NOT IN ('camara','heladera','freezer') OR (temp_min IS NOT NULL AND temp_max IS NOT NULL))
);

-- ── Lotes: trazabilidad y vencimiento ────────────────────────────────────────────────────────
-- Todo lo perecedero entra por lote. Es lo que permite PEPS/FEFO —sale primero lo que vence
-- primero— y, si hay un problema con una partida, saber exactamente a qué producción fue.
CREATE TABLE logic.lote (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id   uuid NOT NULL REFERENCES logic.producto(id),
  codigo        text NOT NULL,
  proveedor_id  uuid REFERENCES logic.proveedor(id),
  vencimiento   date,
  costo_base    numeric(16,6) CHECK (costo_base IS NULL OR costo_base >= 0),  -- por unidad base
  recibido_en   timestamptz NOT NULL DEFAULT now(),
  notas         text,
  UNIQUE (producto_id, codigo)
);
CREATE INDEX lote_vencimiento_ix ON logic.lote (vencimiento) WHERE vencimiento IS NOT NULL;

-- ── EL LIBRO MAYOR ───────────────────────────────────────────────────────────────────────────
-- Cantidad SIEMPRE positiva; el sentido lo dan origen y destino:
--   origen NULL  -> entra al sistema (compra, producción, ajuste a favor)
--   destino NULL -> sale del sistema (consumo, venta, merma, vencimiento)
--   ambos         -> traslado entre ubicaciones
CREATE TABLE logic.movimiento (
  id              bigserial PRIMARY KEY,
  ocurrido_en     timestamptz NOT NULL DEFAULT now(),
  tipo            text NOT NULL CHECK (tipo IN
                    ('compra','produccion','consumo','traslado','merma','vencimiento','venta','ajuste')),
  producto_id     uuid NOT NULL REFERENCES logic.producto(id),
  lote_id         uuid REFERENCES logic.lote(id),
  cantidad_base   numeric(16,4) NOT NULL CHECK (cantidad_base > 0),
  origen_id       uuid REFERENCES logic.ubicacion(id),
  destino_id      uuid REFERENCES logic.ubicacion(id),
  motivo          text,
  referencia      text,            -- nº de remito, de producción, de comanda
  registrado_por  text,
  -- Un movimiento no se borra ni se edita: se ANULA con otro que lo revierte, y quedan los dos.
  anula_a         bigint REFERENCES logic.movimiento(id),
  CHECK (origen_id IS NOT NULL OR destino_id IS NOT NULL),
  CHECK (origen_id IS NULL OR destino_id IS NULL OR origen_id <> destino_id)
);
CREATE INDEX movimiento_producto_ix  ON logic.movimiento (producto_id, ocurrido_en DESC);
CREATE INDEX movimiento_lote_ix      ON logic.movimiento (lote_id) WHERE lote_id IS NOT NULL;
CREATE INDEX movimiento_ubicacion_ix ON logic.movimiento (destino_id, origen_id);

-- El libro mayor es inmutable, y se hace cumplir en la BASE y no en la aplicación: una consulta
-- suelta desde pgadmin o un script apurado no tienen por qué poder reescribir el pasado.
CREATE OR REPLACE FUNCTION logic.movimiento_inmutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'El libro mayor es inmutable: un movimiento no se edita ni se borra. '
                  'Para revertir, asentá un movimiento de ajuste con anula_a=%.', OLD.id;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER movimiento_sin_update BEFORE UPDATE ON logic.movimiento
  FOR EACH ROW EXECUTE FUNCTION logic.movimiento_inmutable();
CREATE TRIGGER movimiento_sin_delete BEFORE DELETE ON logic.movimiento
  FOR EACH ROW EXECUTE FUNCTION logic.movimiento_inmutable();

-- Un producto perecedero exige lote: sin lote no hay vencimiento ni trazabilidad, que es lo que
-- de verdad se le pide a un sistema de almacén gastronómico.
CREATE OR REPLACE FUNCTION logic.exigir_lote() RETURNS trigger AS $$
DECLARE pere boolean;
BEGIN
  SELECT perecedero INTO pere FROM logic.producto WHERE id = NEW.producto_id;
  IF pere AND NEW.lote_id IS NULL THEN
    RAISE EXCEPTION 'El producto es perecedero: el movimiento necesita lote.';
  END IF;
  IF NEW.lote_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM logic.lote WHERE id = NEW.lote_id AND producto_id = NEW.producto_id) THEN
    RAISE EXCEPTION 'El lote no pertenece a ese producto.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER movimiento_exige_lote BEFORE INSERT ON logic.movimiento
  FOR EACH ROW EXECUTE FUNCTION logic.exigir_lote();

-- ── Stock derivado ───────────────────────────────────────────────────────────────────────────
CREATE VIEW logic.stock AS
SELECT producto_id, lote_id, ubicacion_id, SUM(cant) AS cantidad
  FROM (
    SELECT producto_id, lote_id, destino_id AS ubicacion_id,  cantidad_base AS cant
      FROM logic.movimiento WHERE destino_id IS NOT NULL
    UNION ALL
    SELECT producto_id, lote_id, origen_id,                  -cantidad_base
      FROM logic.movimiento WHERE origen_id IS NOT NULL
  ) t
 GROUP BY producto_id, lote_id, ubicacion_id
HAVING SUM(cant) <> 0;

-- Lo que mira el encargado: cuánto hay de cada cosa y qué se vence primero.
CREATE VIEW logic.stock_producto AS
SELECT p.id AS producto_id, p.codigo, p.nombre, p.unidad_base, p.stock_minimo,
       COALESCE(SUM(s.cantidad), 0) AS cantidad,
       MIN(l.vencimiento) FILTER (WHERE s.cantidad > 0) AS vence_primero,
       p.stock_minimo IS NOT NULL AND COALESCE(SUM(s.cantidad), 0) < p.stock_minimo AS bajo_minimo
  FROM logic.producto p
  LEFT JOIN logic.stock s ON s.producto_id = p.id
  LEFT JOIN logic.lote  l ON l.id = s.lote_id
 WHERE p.activo
 GROUP BY p.id;

-- ── Compras ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE logic.compra (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor_id  uuid NOT NULL REFERENCES logic.proveedor(id),
  numero        text,
  fecha         date NOT NULL DEFAULT current_date,
  estado        text NOT NULL DEFAULT 'borrador'
                CHECK (estado IN ('borrador','pedida','recibida','anulada')),
  notas         text,
  creado_en     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE logic.compra_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  compra_id        uuid NOT NULL REFERENCES logic.compra(id) ON DELETE CASCADE,
  producto_id      uuid NOT NULL REFERENCES logic.producto(id),
  presentacion_id  uuid REFERENCES logic.presentacion(id),
  cantidad         numeric(16,4) NOT NULL CHECK (cantidad > 0),   -- en la presentación elegida
  cantidad_base    numeric(16,4) NOT NULL CHECK (cantidad_base > 0),
  precio_total     numeric(16,2) CHECK (precio_total IS NULL OR precio_total >= 0)
);
-- Recibir una compra GENERA movimientos; no se toca el stock a mano. El vínculo queda por
-- `referencia`, así que desde un movimiento siempre se puede volver al remito que lo originó.

-- ── Cadena de frío ───────────────────────────────────────────────────────────────────────────
-- Una lectura por ubicación y momento. La serie es el control: un pico de media hora a 12°C no se
-- ve en una foto del momento, y es exactamente lo que hay que poder demostrar.
CREATE TABLE logic.lectura_temperatura (
  id            bigserial PRIMARY KEY,
  ubicacion_id  uuid NOT NULL REFERENCES logic.ubicacion(id),
  medido_en     timestamptz NOT NULL DEFAULT now(),
  celsius       numeric(5,2) NOT NULL,
  origen        text NOT NULL DEFAULT 'manual' CHECK (origen IN ('manual','sensor')),
  registrado_por text,
  notas         text
);
CREATE INDEX lectura_temp_ix ON logic.lectura_temperatura (ubicacion_id, medido_en DESC);

-- Lecturas fuera del rango de su ubicación: la lista de lo que hay que explicar.
CREATE VIEW logic.alerta_temperatura AS
SELECT l.id, u.nombre AS ubicacion, u.tipo, l.medido_en, l.celsius, u.temp_min, u.temp_max,
       CASE WHEN l.celsius < u.temp_min THEN 'bajo' ELSE 'alto' END AS desvio
  FROM logic.lectura_temperatura l
  JOIN logic.ubicacion u ON u.id = l.ubicacion_id
 WHERE (u.temp_min IS NOT NULL AND l.celsius < u.temp_min)
    OR (u.temp_max IS NOT NULL AND l.celsius > u.temp_max);

-- ── Recetas y producción ─────────────────────────────────────────────────────────────────────
-- Una receta produce un PRODUCTO (el elaborado), que entra al mismo stock que la mercadería
-- comprada. Así el salpicón de ayer se controla y se vence igual que la lechuga.
CREATE TABLE logic.receta (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre           text NOT NULL,
  producto_id      uuid NOT NULL REFERENCES logic.producto(id),   -- el elaborado que sale
  rinde_base       numeric(16,4) NOT NULL CHECK (rinde_base > 0), -- en la unidad base del elaborado
  instrucciones    text,
  vigente          boolean NOT NULL DEFAULT true,
  creado_en        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE logic.receta_item (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receta_id      uuid NOT NULL REFERENCES logic.receta(id) ON DELETE CASCADE,
  producto_id    uuid NOT NULL REFERENCES logic.producto(id),
  cantidad_base  numeric(16,4) NOT NULL CHECK (cantidad_base > 0),
  -- Merma: lo que se pierde al limpiar o pelar. Sin esto la receta pide 1 kg de papa y la cocina
  -- usa 1,3: el stock empieza a no cerrar y nadie sabe por qué.
  merma_pct      numeric(5,2) NOT NULL DEFAULT 0 CHECK (merma_pct >= 0 AND merma_pct < 100),
  UNIQUE (receta_id, producto_id)
);
CREATE TABLE logic.produccion (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receta_id      uuid NOT NULL REFERENCES logic.receta(id),
  fecha          timestamptz NOT NULL DEFAULT now(),
  cantidad_base  numeric(16,4) NOT NULL CHECK (cantidad_base > 0),
  lote_salida_id uuid REFERENCES logic.lote(id),
  ubicacion_id   uuid REFERENCES logic.ubicacion(id),
  responsable    text,
  notas          text
);
-- Producir asienta movimientos: consumo de cada ingrediente (con su lote) y entrada del elaborado.
-- Que el consumo vaya por lote es lo que después permite contestar "este elaborado, ¿con qué
-- partida se hizo?" — la pregunta que importa el día que hay un problema sanitario.
