-- El tablero de tesorería busca, para cada movimiento del período, la otra pata de su transferencia (fin.movimiento_tes con el
-- mismo transferencia_id). Sin índice era un recorrido entero de la tabla por movimiento y por cada vez que la consulta lo nombra:
-- octubre tardaba 14 s (y el tablero lo pide dos veces, el período y el anterior). Con el índice y la consulta materializada, 55 ms.
CREATE INDEX movimiento_tes_transferencia_ix ON fin.movimiento_tes (transferencia_id) WHERE transferencia_id IS NOT NULL;
