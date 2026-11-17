-- Datos para transferir al proveedor (pedido de Fer, 17/11/2026: "en el proveedor no tengo lugar para cargar los datos bancarios
-- ni el alias"). Banco, titular de la cuenta (puede no ser la razón social), CBU o CVU y alias. El CBU/CVU se guarda sin espacios
-- ni guiones y la base controla sus dos dígitos verificadores (el CVU usa el mismo cálculo).
CREATE OR REPLACE FUNCTION fin.cbu_valido(c text) RETURNS boolean AS $$
DECLARE
  p1 int[] := ARRAY[7,1,3,9,7,1,3];
  p2 int[] := ARRAY[3,9,7,1,3,9,7,1,3,9,7,1,3];
  s int := 0;
BEGIN
  IF c !~ '^\d{22}$' THEN RETURN false; END IF;
  FOR i IN 1..7 LOOP s := s + substr(c, i, 1)::int * p1[i]; END LOOP;
  IF (10 - s % 10) % 10 <> substr(c, 8, 1)::int THEN RETURN false; END IF;
  s := 0;
  FOR i IN 1..13 LOOP s := s + substr(c, 8 + i, 1)::int * p2[i]; END LOOP;
  RETURN (10 - s % 10) % 10 = substr(c, 22, 1)::int;
END $$ LANGUAGE plpgsql IMMUTABLE STRICT;

ALTER TABLE logic.proveedor
  ADD COLUMN banco   text,
  ADD COLUMN titular text,
  ADD COLUMN cbu     text CONSTRAINT proveedor_cbu_check CHECK (fin.cbu_valido(cbu)),
  ADD COLUMN alias   text CONSTRAINT proveedor_alias_check CHECK (alias ~ '^[A-Za-z0-9.-]{6,20}$');
COMMENT ON COLUMN logic.proveedor.cbu IS 'CBU o CVU para transferirle, 22 dígitos con verificadores controlados (fin.cbu_valido).';
COMMENT ON COLUMN logic.proveedor.alias IS 'Alias del CBU o CVU (6 a 20 letras, números, punto o guion).';
COMMENT ON COLUMN logic.proveedor.titular IS 'Titular de la cuenta, si no es el proveedor.';

-- El CBU cargado en el proveedor también dice de quién es una transferencia del extracto, y manda sobre el deducido.
CREATE OR REPLACE VIEW fin.proveedor_cbu AS
SELECT DISTINCT ON (cbu) cbu, proveedor_id, ultimo_pago FROM (
  SELECT p.cbu, p.id AS proveedor_id, NULL::date AS ultimo_pago, 0 AS orden, NULL::timestamptz AS creado_en
    FROM logic.proveedor p WHERE p.cbu IS NOT NULL AND p.activo
  UNION ALL
  SELECT l.cuenta_destino, c.proveedor_id, l.fecha, 1, pp.creado_en
    FROM fin.extracto_linea l
    JOIN fin.conciliacion k ON k.linea_id = l.id
    JOIN fin.pago_previo pp ON pp.movimiento_id = k.movimiento_id
    JOIN fin.comprobante c ON c.id = pp.comprobante_id
   WHERE l.cuenta_destino IS NOT NULL AND c.estado <> 'anulado'
) x
WHERE NOT EXISTS (SELECT 1 FROM fin.cuenta cu WHERE cu.cbu = x.cbu)
ORDER BY cbu, orden, ultimo_pago DESC NULLS LAST, creado_en DESC;
