-- Comidas y bebidas en lo más vendido (pedido de Fer, 16/11/2026): los rankings del tablero de ventas se filtran por comidas
-- (entradas, principales, postres, guarniciones: todo lo que se come) y bebidas.
--
-- De dónde sale la clase de un artículo:
--   1. una corrección a mano por nombre (pos.articulo_clase), si la hay;
--   2. si el nombre dice que no es un producto (cubiertos, envío, descuento, artículo inexistente), "otro";
--   3. el rubro del sistema de venta: Maxirest lo trae en el informe de artículos del día (pos.articulo_dia.rubro) y Fudo en la
--      categoría del producto (pos.articulo.rubro, nuevo); PedidosYa no lo trae;
--   4. si no hay rubro o no lo dice (Sin Rubro, Promo), el nombre: bebidas conocidas (gaseosas, aguas, cervezas, vinos, tragos,
--      café); lo demás es comida.

ALTER TABLE pos.articulo ADD COLUMN rubro text;
COMMENT ON COLUMN pos.articulo.rubro IS 'Rubro o categoría del producto en el sistema de venta (Fudo: productCategory). Lo usa pos.clase_articulo.';

-- Corrección a mano: el nombre normalizado como lo agrupa el ranking (upper(btrim(nombre))), en todos los sistemas.
CREATE TABLE pos.articulo_clase (
  nombre    text PRIMARY KEY CHECK (nombre = upper(btrim(nombre)) AND nombre <> ''),
  clase     text NOT NULL CHECK (clase IN ('comida', 'bebida', 'otro')),
  cambiado_por text,
  cambiado_en  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE pos.articulo_clase IS 'Clase (comida, bebida, otro) corregida a mano de un artículo, por nombre; manda sobre lo deducido.';

CREATE FUNCTION pos.clase_deducida(p_nombre text, p_rubro text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN translate(lower(coalesce(p_nombre, '')), 'áéíóúüñ', 'aeiouun') ~ '(cubierto|\menvio\M|pedidos ?ya|descuento|art\. ?inex|propina|servicio de mesa)' THEN 'otro'
    WHEN r ~ '(bebida|vino|cerveza|aperitivo|trago|cafeter|gaseosa|licor|coctel|cocktail|infusion)' THEN 'bebida'
    WHEN r ~ '(entrada|principal|postre|guarnicion|alimento|sandwich|plato|sushi|roll|niguiri|nigiri|bodegon|parrilla|sugerencia|combo|menu|evento|pasteleria|panaderia|minuta|pizza|pasta|ensalada)' THEN 'comida'
    WHEN n ~ '\d+ ?(ml|cc|cl)\M' THEN 'bebida'
    WHEN n ~ ('\m(agua|aguas|coca|cola|sprite|fanta|schweppes|aquarius|pepsi|paso de los toros|gaseosa|soda|jugo|exprimido|limonada|licuado|'
              'cerveza|stella|corona|patagonia|quilmes|heineken|imperial|andes|brahma|budweiser|pinta|chopp|'
              'vino|malbec|cabernet|chardonnay|torrontes|rosado|blend|sauvignon|merlot|syrah|bonarda|espumante|champagne|champan|'
              'fernet|gancia|vermut|vermouth|aperol|campari|gin|whisky|vodka|ron|tonica|spritz|negroni|mojito|daiquiri|trago|'
              'cafe|coffee|espresso|expreso|cortado|capuccino|cappuccino|capucchino|perrier|chenin|santa ?julia|latte|lagrima|te|mate|submarino|chocolatada|americano|flat white|'
              'agua caliente|frappe|smoothie|batido)\M') THEN 'bebida'
    ELSE 'comida' END
  -- El nombre sin lo que va entre corchetes (el agregado elegido: "Carrot Cake [1 Cafe con leche]" es comida); para "otro",
  -- el nombre entero.
  FROM (SELECT translate(lower(split_part(coalesce(p_nombre, ''), '[', 1)), 'áéíóúüñ', 'aeiouun') AS n,
               translate(lower(coalesce(p_rubro, '')), 'áéíóúüñ', 'aeiouun') AS r) x
$$;

CREATE FUNCTION pos.clase_articulo(p_nombre text, p_rubro text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT clase FROM pos.articulo_clase WHERE nombre = upper(btrim(p_nombre))), pos.clase_deducida(p_nombre, p_rubro))
$$;
