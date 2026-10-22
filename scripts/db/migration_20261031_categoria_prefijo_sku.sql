-- SKU automático. Cada categoría tiene un PREFIJO (2 a 6 letras o números, único) y un producto
-- que se da de alta sin SKU recibe el siguiente de su categoría: LAC-0001, LAC-0002...
--
-- Lo numera la BASE y no la app: dos altas simultáneas en la misma categoría pedirían el mismo
-- número. El candado por prefijo las pone en fila. El SKU sigue siendo editable y se puede tipear
-- uno propio; el siguiente automático sale del mayor número con ese prefijo, así que uno tipeado
-- con el mismo formato no se pisa.

-- Prefijo sugerido a partir del nombre: las tres primeras letras, sin acentos ni espacios (si el
-- nombre no da para dos, se completa con X: el formato pide al menos dos).
CREATE FUNCTION logic.prefijo_de(nombre text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(x) < 2 THEN rpad(x, 2, 'X') ELSE x END
    FROM (SELECT left(regexp_replace(upper(translate(nombre, 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN')), '[^A-Z0-9]', '', 'g'), 3) AS x) s
$$;

ALTER TABLE logic.categoria ADD COLUMN prefijo text;

-- Las existentes: el sugerido, y si se repite, con un número al final.
UPDATE logic.categoria c SET prefijo = x.p
  FROM (SELECT id, logic.prefijo_de(nombre) || CASE WHEN n > 1 THEN n::text ELSE '' END AS p
          FROM (SELECT id, nombre, row_number() OVER (PARTITION BY logic.prefijo_de(nombre) ORDER BY creado_en) AS n
                  FROM logic.categoria) s) x
 WHERE x.id = c.id;

ALTER TABLE logic.categoria ALTER COLUMN prefijo SET NOT NULL,
  ADD CONSTRAINT categoria_prefijo_formato CHECK (prefijo ~ '^[A-Z0-9]{2,6}$');
CREATE UNIQUE INDEX categoria_prefijo_ux ON logic.categoria (prefijo);

-- Una categoría nueva sin prefijo recibe el sugerido; si ya está tomado, con 2, 3...
CREATE FUNCTION logic.categoria_prefijo() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE base text; n int := 1;
BEGIN
  IF NEW.prefijo IS NOT NULL AND btrim(NEW.prefijo) <> '' THEN
    NEW.prefijo := upper(btrim(NEW.prefijo));
    RETURN NEW;
  END IF;
  base := logic.prefijo_de(NEW.nombre);
  NEW.prefijo := base;
  WHILE EXISTS (SELECT 1 FROM logic.categoria WHERE prefijo = NEW.prefijo AND id <> NEW.id) LOOP
    n := n + 1; NEW.prefijo := base || n;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER categoria_prefijo BEFORE INSERT OR UPDATE OF prefijo ON logic.categoria
  FOR EACH ROW EXECUTE FUNCTION logic.categoria_prefijo();

-- El siguiente SKU de una categoría.
CREATE FUNCTION logic.siguiente_sku(p_categoria uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT c.prefijo || '-' || lpad((COALESCE(max(substring(p.codigo FROM '^' || c.prefijo || '-([0-9]+)$')::int), 0) + 1)::text, 4, '0')
    FROM logic.categoria c
    LEFT JOIN logic.producto p ON p.codigo ~ ('^' || c.prefijo || '-[0-9]+$')
   WHERE c.id = p_categoria
   GROUP BY c.prefijo
$$;

CREATE FUNCTION logic.producto_sku() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.codigo IS NULL OR btrim(NEW.codigo) = '' THEN
    PERFORM pg_advisory_xact_lock(hashtext('sku:' || NEW.categoria_id::text));
    NEW.codigo := logic.siguiente_sku(NEW.categoria_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER producto_sku BEFORE INSERT ON logic.producto
  FOR EACH ROW EXECUTE FUNCTION logic.producto_sku();
