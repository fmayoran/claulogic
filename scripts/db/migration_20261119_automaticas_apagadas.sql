-- Corridas automáticas apagadas hasta terminar de probar (decisión de Fer, 03/11/2026: "prefiero ir corriendo a mano").
-- El 03/11 la del portal de Pago24 trajo noviembre con las ventas sólo hasta octubre: asentó una apertura al 31/10 y pareó
-- cobros con ventas de otros días. Ahora una cuenta o un punto de venta nuevo nacen sin automática; se prende en su ficha.
ALTER TABLE pos.integracion ALTER COLUMN sincroniza_auto SET DEFAULT false;
ALTER TABLE fin.procesador ALTER COLUMN portal_auto SET DEFAULT false;
UPDATE pos.integracion SET sincroniza_auto = false WHERE sincroniza_auto;
UPDATE fin.procesador SET portal_auto = false WHERE portal_auto;
