-- Proveedor: nombre comercial (el `nombre` de siempre, obligatorio) y razón social (pedido de Fer, 25/11/2026).
-- La razón social es obligatoria cuando el proveedor tiene CUIT: es la que va en el libro IVA y en las retenciones.
-- Los 7 proveedores con CUIT la toman de su nombre; Pilotti, de cómo figura en el banco.
BEGIN;

ALTER TABLE logic.proveedor ADD COLUMN razon_social text;

UPDATE logic.proveedor SET razon_social = CASE WHEN cuit = '30583438412' THEN 'PILOTTI S.A. EMPRESA FRIGORIFICA' ELSE nombre END
 WHERE cuit IS NOT NULL;

ALTER TABLE logic.proveedor ADD CONSTRAINT proveedor_razon_social_ck
  CHECK (cuit IS NULL OR (razon_social IS NOT NULL AND btrim(razon_social) <> ''));

COMMENT ON COLUMN logic.proveedor.nombre IS 'Nombre comercial, con el que se lo conoce (obligatorio).';
COMMENT ON COLUMN logic.proveedor.razon_social IS 'Razón social; obligatoria si tiene CUIT. Va en el libro IVA y en las retenciones.';

COMMIT;
