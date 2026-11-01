-- Maxirest por API (pedido de Fer, 01/11/2026: SORELLE CIUCIO SA trabaja con Maxirest Cloud). Hasta ahora la base exigía
-- que Maxirest fuera por archivo, porque no tiene API pública; ahora se usa el servicio de su propia página (app/maxirest.js),
-- con usuario y clave cifrados como las credenciales de Fudo. Sólo "otro" queda siempre por archivo.
ALTER TABLE pos.integracion DROP CONSTRAINT integracion_check;
ALTER TABLE pos.integracion ADD CONSTRAINT integracion_api_check CHECK (sistema <> 'otro' OR modo = 'archivo');
