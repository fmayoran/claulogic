-- Conexión con el portal de Pago24 (pedido de Fer, 03/11/2026: traer solo el extracto de la Cta. Cte. Disponible, como las ventas de
-- Maxirest). Pago24 no tiene API: se entra al portal con el usuario y la clave de la empresa. La dirección del portal va en claro;
-- usuario y clave, cifrados con la clave propia de ClauLogic (app/crypto.js) y nunca de vuelta al navegador.
ALTER TABLE fin.procesador
  ADD COLUMN portal_url text,
  ADD COLUMN portal_credenciales text,
  ADD CONSTRAINT procesador_portal_cifrado CHECK (portal_credenciales IS NULL OR portal_credenciales LIKE 'gcm$%'),
  ADD CONSTRAINT procesador_portal_url CHECK (portal_url IS NULL OR portal_url ~ '^https://'),
  ADD CONSTRAINT procesador_portal_marca CHECK ((portal_url IS NULL AND portal_credenciales IS NULL) OR marca = 'pago24');
