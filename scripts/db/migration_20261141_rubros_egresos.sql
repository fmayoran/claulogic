-- Rubros de egresos (decisiones de Fer, 10/11/2026), para reconstruir la historia desde los extractos y después cargar los
-- egresos en la app. Práctica de gastronomía: separar el prime cost (mercadería + personal) de la locación y la estructura.
-- Líneas nuevas del estado: Personal, Locación, Comercialización, Administración e Inversiones (imputadas al mes, sin amortizar).
ALTER TABLE fin.rubro DROP CONSTRAINT rubro_linea_check;
ALTER TABLE fin.rubro ADD CONSTRAINT rubro_linea_check CHECK (linea IN
  ('ventas','cmv','personal','cobro','locacion','operativos','comercializacion','administracion','impuestos','bancarios',
   'inversiones','diferencias','otros','fuera'));

-- Publicidad pasa a Comercialización.
UPDATE fin.rubro SET linea = 'comercializacion', orden = 10 WHERE clave = 'marketing';

INSERT INTO fin.rubro (nombre, linea, orden) VALUES
  -- Sólo para la historia: sin facturas ni consumo, el costo de la mercadería se aproxima por lo pagado.
  ('Compras de mercadería', 'cmv', 30),
  ('Sueldos y jornales', 'personal', 10),
  ('Cargas sociales (F.931)', 'personal', 20),
  ('Sindicato y obra social', 'personal', 30),
  ('ART y seguro de vida', 'personal', 40),
  ('SAC y vacaciones', 'personal', 50),
  ('Eventuales y extras', 'personal', 60),
  ('Indemnizaciones', 'personal', 70),
  ('Comida y uniformes del personal', 'personal', 80),
  ('Alquiler', 'locacion', 10),
  ('Expensas', 'locacion', 20),
  ('Luz', 'locacion', 30),
  ('Gas', 'locacion', 40),
  ('Agua', 'locacion', 50),
  ('Tasas municipales (ABL, Seguridad e Higiene)', 'locacion', 60),
  ('Descartables y packaging', 'operativos', 10),
  ('Limpieza', 'operativos', 20),
  ('Vajilla y utensilios', 'operativos', 30),
  ('Lavandería y blanquería', 'operativos', 40),
  ('Mantenimiento y reparaciones', 'operativos', 50),
  ('Control de plagas', 'operativos', 55),
  ('Gas envasado y combustible', 'operativos', 57),
  ('Fletes', 'operativos', 58),
  ('Música (SADAIC, AADI-CAPIF)', 'comercializacion', 20),
  ('Honorarios profesionales', 'administracion', 10),
  ('Sistemas y software', 'administracion', 20),
  ('Internet y telefonía', 'administracion', 30),
  ('Seguros', 'administracion', 40),
  ('Seguridad y alarma', 'administracion', 50),
  ('Librería y varios', 'administracion', 60),
  ('Equipamiento', 'inversiones', 10),
  ('Obras e instalaciones', 'inversiones', 20),
  ('Mobiliario', 'inversiones', 30),
  ('Pagos a proveedores', 'fuera', 20),
  ('Transferencias propias', 'fuera', 30),
  ('Anticipos al personal', 'fuera', 40);
