-- Cerrar el agujero del TRUNCATE en el libro mayor.
--
-- Los triggers BEFORE UPDATE/DELETE de `movimiento` protegen fila por fila, pero TRUNCATE no es
-- un DELETE: no dispara triggers de fila y vacía la tabla entera sin que salte nada. Lo descubrí
-- usándolo para limpiar datos de prueba el 19/10/2026, y vaciar el libro mayor en silencio es
-- exactamente el agujero que la inmutabilidad existe para tapar.
--
-- Un trigger de SENTENCIA sí lo agarra. Para una limpieza legítima hay que desactivarlo a mano,
-- que es justo lo que se quiere: que borrar el historial sea un acto deliberado y no un descuido.
CREATE OR REPLACE FUNCTION logic.movimiento_sin_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'El libro mayor no se vacía. Si de verdad querés hacerlo, desactivá a mano el '
                  'trigger movimiento_sin_truncate y dejá asentado por qué.';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER movimiento_sin_truncate BEFORE TRUNCATE ON logic.movimiento
  FOR EACH STATEMENT EXECUTE FUNCTION logic.movimiento_sin_truncate();

-- Mismo criterio para la serie de temperatura: es el registro que hay que poder mostrar ante una
-- inspección, y perderlo entero por un comando apurado no puede ser tan fácil.
CREATE TRIGGER lectura_sin_truncate BEFORE TRUNCATE ON logic.lectura_temperatura
  FOR EACH STATEMENT EXECUTE FUNCTION logic.movimiento_sin_truncate();
