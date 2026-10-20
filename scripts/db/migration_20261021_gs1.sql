-- Identificación de productos y lotes según GS1: SKU propio, GTIN por presentación y GTIN interno.
--
-- CÓMO ENCAJA CON GS1
--   · El SKU es `producto.codigo`: el código propio del negocio, alfanumérico, siempre presente.
--   · El GTIN identifica un NIVEL DE EMPAQUE, no un producto abstracto: el sachet de 1 l tiene un
--     GTIN-13 y la caja de 12 sachets otro GTIN-14. Por eso el GTIN del fabricante se asocia a la
--     PRESENTACIÓN, que ya sabe cuánto contiene en unidad base: escanear resuelve producto y cantidad.
--   · Todo producto tiene además un GTIN INTERNO con prefijo 040, el rango que GS1 reserva para
--     números de circulación restringida dentro de una empresa (040-049). Sirve para etiquetar
--     lotes y góndolas de lo que no trae código (elaborados, granel) y no choca con ningún GTIN
--     real. Fuera del negocio no significa nada, que es justamente lo que dice la norma.
--   · Se guarda siempre en 14 dígitos (con ceros a la izquierda), como recomienda GS1: así un
--     EAN-13, un UPC-A y un GTIN-14 se comparan sin ambigüedad.

-- ── Dígito verificador GS1 (módulo 10) ───────────────────────────────────────────────────────
-- Pesos 3 y 1 alternados desde la derecha, sin contar el verificador.
CREATE OR REPLACE FUNCTION logic.gtin_digito(cuerpo text) RETURNS int AS $$
  SELECT (10 - (SUM(substr(reverse(cuerpo), i, 1)::int * CASE WHEN i % 2 = 1 THEN 3 ELSE 1 END) % 10)) % 10
    FROM generate_series(1, length(cuerpo)) AS i;
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION logic.gtin_valido(g text) RETURNS boolean AS $$
  SELECT g ~ '^\d{14}$' AND logic.gtin_digito(left(g, 13)) = right(g, 1)::int;
$$ LANGUAGE sql IMMUTABLE STRICT;

-- ── Tabla de GTIN ────────────────────────────────────────────────────────────────────────────
-- Una sola tabla para los dos orígenes, con el GTIN como clave: un código escaneado lleva a un
-- único lugar, sea de fabricante o interno.
CREATE TABLE logic.gtin (
  gtin             text PRIMARY KEY CHECK (logic.gtin_valido(gtin)),
  producto_id      uuid NOT NULL REFERENCES logic.producto(id),
  presentacion_id  uuid REFERENCES logic.presentacion(id) ON DELETE CASCADE,
  origen           text NOT NULL CHECK (origen IN ('fabricante', 'interno')),
  creado_en        timestamptz NOT NULL DEFAULT now(),
  -- El GTIN de fabricante siempre es de un empaque concreto.
  CHECK (origen = 'interno' OR presentacion_id IS NOT NULL),
  -- Un GTIN de fabricante en el rango 040-049 es el código interno de OTRA empresa: fuera de ella
  -- no identifica nada, y además podría chocar con los nuestros.
  CHECK (origen = 'interno' OR substr(gtin, 2, 2) <> '04'),
  CHECK (origen = 'fabricante' OR substr(gtin, 2, 3) = '040')
);
CREATE INDEX gtin_producto_ix ON logic.gtin (producto_id);
-- Un único GTIN interno "del producto" (sin presentación) por producto.
CREATE UNIQUE INDEX gtin_interno_producto_ux ON logic.gtin (producto_id) WHERE presentacion_id IS NULL;
-- Una presentación tiene a lo sumo un GTIN.
CREATE UNIQUE INDEX gtin_presentacion_ux ON logic.gtin (presentacion_id) WHERE presentacion_id IS NOT NULL;

-- La presentación tiene que ser del mismo producto que el GTIN.
CREATE OR REPLACE FUNCTION logic.gtin_coherente() RETURNS trigger AS $$
BEGIN
  IF NEW.presentacion_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM logic.presentacion WHERE id = NEW.presentacion_id AND producto_id = NEW.producto_id) THEN
    RAISE EXCEPTION 'La presentación no pertenece a ese producto.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER gtin_coherente BEFORE INSERT OR UPDATE ON logic.gtin
  FOR EACH ROW EXECUTE FUNCTION logic.gtin_coherente();

-- ── GTIN interno ─────────────────────────────────────────────────────────────────────────────
-- '0' (relleno a 14) + '040' (prefijo RCN de empresa) + 9 dígitos de secuencia + verificador.
-- Mil millones de códigos: no se van a terminar.
CREATE SEQUENCE logic.gtin_interno_seq;

CREATE OR REPLACE FUNCTION logic.nuevo_gtin_interno() RETURNS text AS $$
DECLARE cuerpo text;
BEGIN
  cuerpo := '0040' || lpad(nextval('logic.gtin_interno_seq')::text, 9, '0');
  RETURN cuerpo || logic.gtin_digito(cuerpo);
END $$ LANGUAGE plpgsql;

-- Todo producto nace con su GTIN interno: así cualquier producto se puede etiquetar y escanear
-- desde el primer día, tenga o no código de fabricante.
CREATE OR REPLACE FUNCTION logic.producto_gtin_interno() RETURNS trigger AS $$
BEGIN
  INSERT INTO logic.gtin (gtin, producto_id, origen) VALUES (logic.nuevo_gtin_interno(), NEW.id, 'interno');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER producto_gtin_interno AFTER INSERT ON logic.producto
  FOR EACH ROW EXECUTE FUNCTION logic.producto_gtin_interno();

-- Los productos que ya existen reciben el suyo ahora.
INSERT INTO logic.gtin (gtin, producto_id, origen)
SELECT logic.nuevo_gtin_interno(), p.id, 'interno'
  FROM logic.producto p ORDER BY p.creado_en;

-- ── Lote: código compatible con GS1 ──────────────────────────────────────────────────────────
-- El AI (10) admite hasta 20 caracteres del juego 82 de GS1 (sin espacios ni acentos). Un lote
-- que no lo cumple no se puede poner en una etiqueta ni leer de la caja del proveedor.
ALTER TABLE logic.lote ADD CONSTRAINT lote_codigo_gs1
  CHECK (codigo ~ '^[A-Za-z0-9!"%&''()*+,./:;<=>?_-]{1,20}$');
