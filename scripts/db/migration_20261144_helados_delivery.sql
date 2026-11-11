-- Pedido de Fer (11/11/2026), al clasificar los egresos: helados como subcategoría de mercadería (El Fundador) y el servicio de
-- entrega de pedidos de delivery propio (OnBox Logística) como rubro de comercialización.
INSERT INTO fin.rubro (nombre, linea, orden) VALUES
  ('Mercadería · Helados', 'cmv', 44),
  ('Envíos de delivery', 'comercializacion', 30);
INSERT INTO logic.categoria (nombre, prefijo) VALUES ('Helados', 'HEL');
