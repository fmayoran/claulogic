-- Subcategorías de mercadería (decisión de Fer, 10/11/2026): cada una es un rubro de Costo de mercadería, para ver en el estado
-- cuánto se va en carnes, bebidas, etc. "Compras de mercadería" pasa a ser "Mercadería varios" (mayoristas de todo un poco).
-- Las mismas categorías van en Productos, así el costo del consumo se abre igual que la historia.
UPDATE fin.rubro SET nombre = 'Mercadería varios', orden = 99 WHERE nombre = 'Compras de mercadería' AND linea = 'cmv' AND clave IS NULL;
INSERT INTO fin.rubro (nombre, linea, orden) VALUES
  ('Mercadería · Carnes', 'cmv', 31),
  ('Mercadería · Aves', 'cmv', 32),
  ('Mercadería · Pescados y mariscos', 'cmv', 33),
  ('Mercadería · Fiambres y embutidos', 'cmv', 34),
  ('Mercadería · Lácteos, quesos y huevos', 'cmv', 35),
  ('Mercadería · Frutas y verduras', 'cmv', 36),
  ('Mercadería · Almacén', 'cmv', 37),
  ('Mercadería · Aceites y grasas', 'cmv', 38),
  ('Mercadería · Panadería y pastelería', 'cmv', 39),
  ('Mercadería · Congelados', 'cmv', 40),
  ('Mercadería · Café e infusiones', 'cmv', 41),
  ('Mercadería · Bebidas sin alcohol', 'cmv', 42),
  ('Mercadería · Bebidas con alcohol', 'cmv', 43);

UPDATE logic.categoria SET nombre = 'Lácteos, quesos y huevos' WHERE prefijo = 'LAC';
UPDATE logic.categoria SET nombre = 'Panadería y pastelería' WHERE prefijo = 'PAN';
INSERT INTO logic.categoria (nombre, prefijo) VALUES
  ('Aves', 'AVE'), ('Pescados y mariscos', 'PES'), ('Fiambres y embutidos', 'FIA'), ('Frutas y verduras', 'FYV'),
  ('Almacén', 'ALM'), ('Aceites y grasas', 'ACE'), ('Congelados', 'CONG'), ('Café e infusiones', 'CAF'), ('Bebidas con alcohol', 'BAL');
