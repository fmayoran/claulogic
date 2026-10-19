# CLAUDE.md — ClauLogic

## Qué es esto
**ClauLogic es una aplicación independiente.** No es un componente de ClaUsina ni una cápsula de
negocio: tiene su propio repo, su propia base, su propia clave de cifrado y su propio proyecto en
EasyPanel. Lo único que comparte con ClaUsina es el VPS.

**No mezclar las dos.** Si una tarea es de ClaUsina, se hace parado en `/root/clausina`, con su
propio CLAUDE.md. Acá no se leen contextos de marca de ClaUsina ni se tocan sus archivos.

## Qué hace

**Gestión de almacén y producción para un negocio gastronómico.** Identificación de productos,
compras, control de stock, ingresos y egresos de mercadería, control de cámaras de frío, control
de almacenamiento, gestión de recetas y producción.

### Las cuatro decisiones del modelo (no las deshagas sin entender por qué están)

1. **El stock NO se guarda: se deriva.** No hay ninguna columna `cantidad_actual`. El stock sale
   de sumar `logic.movimiento`, que es un libro mayor inmutable. Guardar el stock como número es
   cómodo el primer día y es el origen de todos los problemas después: dos operaciones simultáneas
   lo pisan, una corrección a mano lo desvía, y cuando el número del sistema no coincide con el de
   la estantería nadie puede saber cuál miente ni desde cuándo. Derivándolo, cada unidad tiene su
   movimiento con fecha, motivo y responsable. Se consulta por `logic.stock` y `logic.stock_producto`.

2. **El libro mayor es inmutable, y se hace cumplir en la BASE.** Triggers bloquean UPDATE, DELETE
   y TRUNCATE sobre `logic.movimiento`. Para revertir algo se asienta un movimiento nuevo con
   `anula_a`, y quedan los dos. No se reescribe el pasado — ni desde la app, ni desde pgadmin, ni
   desde un script apurado.

3. **Todo en la unidad base del producto.** Se compra en cajas, se cocina en gramos y se cuenta en
   unidades. `logic.presentacion` convierte la presentación de compra a la base. `logic.unidad`
   tiene la magnitud (masa/volumen/conteo) para que no se pueda convertir kg a litros.

4. **Cantidades y plata en NUMERIC, nunca en float.** 0,1 + 0,2 en coma flotante no da 0,3, y un
   inventario que no cierra por centésimas es un inventario que nadie vuelve a mirar.

### Reglas que impone la base

- Un producto **perecedero exige lote** en cada movimiento: sin lote no hay vencimiento ni
  trazabilidad, que es lo que de verdad se le pide a un almacén gastronómico.
- Un lote tiene que pertenecer al producto del movimiento.
- Cantidades siempre positivas; el sentido lo dan `origen_id` y `destino_id`. Origen NULL = entra
  al sistema, destino NULL = sale, los dos = traslado.
- Una **cámara, heladera o freezer no se puede dar de alta sin rango de temperatura**: sin eso no
  hay contra qué comparar y el control de frío no existe.

### Lo que falta
Pantallas (no hay ninguna todavía, sólo el esqueleto y `/salud`), recibir una compra generando los
movimientos, producir una receta (consumir ingredientes por lote + dar de alta el elaborado), FEFO
en la sugerencia de qué lote usar, y lectura de sensores de temperatura.

## Sobre Fer
- Fernando Mayorano. Lic. en Sistemas, especialista en bases de datos, Desarrollo de Negocios.
- **Siempre responder en español**, con tildes y ñ correctas. **Sin emojis bajo ninguna circunstancia.**
- Tono directo, sin vueltas. Respuestas concisas pero completas.

## Reglas de seguridad
- Pedir confirmación antes de **borrar** cualquier archivo o carpeta.
- Pedir confirmación antes de **sobrescribir** archivos existentes.
- Nada que salga a producción o a un tercero sin visto humano.

## Arquitectura

| Pieza | Dónde |
|---|---|
| Repo | `github.com/fmayoran/claulogic` (branch `main`) |
| App | EasyPanel → proyecto `claulogic`, servicio `app` (Node 22 + Express, puerto 3002) |
| Base | EasyPanel → proyecto `claulogic`, servicio `db` (PostgreSQL 17 + pgvector) |
| Dominio | `https://claulogic.clausina.ar` (A a 72.60.166.136, proxy de Cloudflare APAGADO) |
| Secretos | `claulogic.env` en la raíz — gitignored, permisos 600 |

- **Base `claulogic`, esquema `logic`** (no `public`). Misma idea que `contenido` en ClaUsina: hace
  que un dump, un GRANT o un DROP sean quirúrgicos en vez de "todo o nada".
- **Instancia de Postgres propia**, separada de la de ClaUsina. No es purismo: en el Postgres de
  ClaUsina todo entra como superusuario, así que compartirlo habría dejado a cada app con acceso
  total a los datos de la otra.

## Cómo se trabaja

**Migraciones** — SQL numerado en `scripts/db/migration_AAAAMMDD_loquesea.sql`.
```bash
scripts/migrar.sh --ver     # qué está pendiente, sin tocar nada
scripts/migrar.sh           # aplicar
```
Cada una se aplica UNA vez y queda asentada en `logic.migracion` con su sha256. **Nunca edites una
migración ya aplicada**: el corredor lo detecta y frena, porque la base y el repo pasarían a contar
historias distintas. Si hay que corregir algo, se escribe una migración nueva.

**Deploy** — `./deploy.sh`. EasyPanel construye **desde GitHub**, no desde el disco, así que el
script se niega a desplegar con cambios sin commitear o sin pushear, y al final verifica que el
contenedor corra de verdad tu código comparando los archivos adentro. Las dos comprobaciones
existen porque en ClaUsina las dos fallaron alguna vez diciendo "OK".

**Secretos** — lo de plataforma en `claulogic.env`. Lo que el usuario opera desde la app va
**cifrado en la base** (AES-256-GCM, formato `gcm$<iv>$<ct||tag>`, helper `app/crypto.js`), nunca
en claro y nunca de vuelta al navegador. `APP_ENC_KEY` es **propia de ClauLogic**: no se comparte
con ClaUsina, o la independencia entre las dos se termina ahí.

**Respaldo** — lo cubre `/root/clausina/core/scripts/db_backup.sh`, que respalda las dos bases.
Vive en ClaUsina porque el cron ya estaba armado ahí; es la única dependencia operativa entre las
dos y está anotada a propósito.

## Trampas conocidas
- El proxy de Cloudflare va **apagado** en el A record. Prendido, Traefik no puede resolver el
  desafío de Let's Encrypt y el certificado nunca sale.
- El VPS **no tiene swap** y son 7,8 GB de RAM compartidos con ClaUsina, n8n y Chatwoot. Un pico
  de memoria no se degrada: lo mata el OOM killer.
- El contenedor de la base cambia de nombre en cada deploy
  (`claulogic_db.1.<hash>`): descubrilo con `docker ps -q -f name=claulogic_db.1.`, nunca lo fijes.
