-- Migración inicial de ClauLogic.
-- El esquema `logic` y la tabla `logic.migracion` ya existen (los crea el alta de la base); esta
-- migración queda como punto de partida del historial para que el registro arranque desde acá.
CREATE SCHEMA IF NOT EXISTS logic;

CREATE TABLE IF NOT EXISTS logic.migracion (
  archivo     text PRIMARY KEY,
  aplicada_en timestamptz NOT NULL DEFAULT now(),
  sha256      text NOT NULL
);
