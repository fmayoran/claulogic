-- La marca del procesador (decisión de Fer, 03/11/2026): Mercado Pago es uno solo aunque cada empresa tenga su cuenta. Lo que
-- hoy es `fin.procesador` es la CUENTA DE COBRO de una empresa en un procesador (con su "a acreditar" y la cuenta donde
-- deposita: la conciliación sigue pareando por ahí); la marca es de una lista fija y es por la que se agrupan los reportes
-- ("Mercado Pago · QR"), sin depender del nombre que se le puso a la cuenta. Los tipos de operación ya eran una lista fija.
ALTER TABLE fin.procesador ADD COLUMN marca text;
UPDATE fin.procesador SET marca = CASE
  WHEN nombre ~* 'mercado\s*pago' THEN 'mercadopago'
  WHEN nombre ~* 'pago\s*24' THEN 'pago24'
  WHEN nombre ~* 'fudo' THEN 'fudo'
  WHEN nombre ~* 'getnet' THEN 'getnet'
  ELSE 'otro' END;
ALTER TABLE fin.procesador ALTER COLUMN marca SET DEFAULT 'otro', ALTER COLUMN marca SET NOT NULL,
  ADD CONSTRAINT procesador_marca_check CHECK (marca IN ('mercadopago', 'pago24', 'fudo', 'getnet', 'otro'));

-- "SIN NOMBRE SORELLE" fue una cuenta provisoria: sus cobros resultaron ser de Mercado Pago y ya no la usa ningún medio.
UPDATE fin.procesador p SET activo = false
 WHERE p.nombre = 'SIN NOMBRE SORELLE'
   AND NOT EXISTS (SELECT 1 FROM pos.medio m JOIN fin.medio_pago mp ON mp.id = m.medio_pago_id WHERE mp.procesador_id = p.id);
