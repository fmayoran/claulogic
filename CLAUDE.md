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

### Alcance ampliado (decidido el 20/10/2026)
Un **grupo gastronómico** con varios **locales** (puntos de venta) y gestión centralizada: la
administración financiera (tesorería, compras, pago a proveedores) y la logística, que opera desde
un **centro de abastecimiento y producción** (puede tener varios almacenes y varias unidades
productivas). ClauLogic NO es un punto de venta: se **integra** con los POS para traer las ventas,
por el lado financiero (cobros por medio de pago) y por el de consumo (artículo vendido → receta de
venta → descuento teórico de stock).

Decisiones de Fer:
- **Varios POS distintos** entre locales: formato de importación propio + un adaptador por sistema.
  La importación entra a una tabla de recepción idempotente (reimportar un cierre no duplica).
- **Stock por local**: cada local tiene almacén; centro → local es un traslado con remito interno.
  Ventas descuentan consumo teórico; los conteos del local dan la diferencia teórico vs. real.
- **Una sola razón social** (si aparecen más, se agrega con migración a facturas, cuentas y pagos).
- **Contabilidad afuera**: exportaciones para el sistema del contador, sin plan de cuentas propio.
- Los saldos financieros (cuenta corriente de proveedores, cajas y bancos) **se derivan de un libro
  mayor inmutable**, como el stock.
- Esquemas por área: `org` (sedes, usuarios), `logic` (lo existente), `fin` (proveedores, cuentas a
  pagar, tesorería), `pos` (importación de ventas).

Fases: 0 autenticación y permisos por sede → 1 sedes, almacenes por sede, unidades productivas,
traslados → 2 facturas de proveedor y cuenta corriente → 3 tesorería (pagos, retenciones,
conciliación) → 4 integración POS → 5 tablero (food cost, CMV, teórico vs. real, flujo de caja).

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

- Todo producto pertenece a una **categoría**; toda ubicación (heladera, cámara) a un **almacén**.
- Un **ajuste** no escribe el stock: se registra lo contado y `logic.ajustar_stock` asienta el
  movimiento por la diferencia. El conteo queda en `logic.ajuste` aunque la diferencia sea cero.
- El **costo vigente** sí se guarda (`producto.costo_base`, por unidad base): actualizarlo es una
  decisión al recibir la compra (`compra_item.costo_decision`). Cada cambio lo asienta un trigger
  en `logic.costo_historial`, inmutable.
- El **stock puede quedar negativo** por ahora: decisión de Fer (20/10/2026), a revisar.

- **Compra y factura son cosas distintas**: la compra es la mercadería (pedido y recepción, precios netos,
  total con IVA estimado por la alícuota habitual de cada producto); la factura (`fin.comprobante`) tiene
  número, IVA real y percepciones, y puede no coincidir. Desde la compra recibida, quien tiene finanzas ve
  "Factura y pago": **Cargar factura** abre el comprobante con la compra vinculada y sus renglones
  copiados (`comprobantes.html?compra=&proveedor=`), y **Pagar** abre la orden de pago con el comprobante
  tildado por lo pendiente (`ordenes-pago.html?proveedor=&comprobante=`).
- **Pago rápido** (`pagoRapido` en `comun.js`, decisión de Fer: pocos usuarios, menos pasos): "Pagar" en la
  compra o el comprobante abre un diálogo con cuenta (banco = transferencia, caja = efectivo), importe y
  fecha; arma la orden de pago y la registra en un paso (si no se puede registrar, borra el borrador).
  Con cheques o retenciones, la orden de pago completa. La compra estima IVA sólo si el proveedor es
  responsable inscripto.
- Las **compras recibidas** no se editan ni se borran, y sus movimientos (como los de una
  producción) no se anulan sueltos. Recibir crea lote sólo para perecederos; los no perecederos se
  mueven sin lote.
- **Producir** recalcula el plan FEFO adentro de la transacción con los ingredientes bloqueados
  (`logic.bloquear_stock`) y no produce si algo no alcanza. La merma de la receta se suma sobre la
  cantidad neta: neto / (1 - merma).
- Las **unidades del sistema** (g, kg, ml, l, u) no cambian de equivalencia; las demás tampoco si
  son base de algún producto. La de **referencia** (una por magnitud) es la que muestra costos.
- La conexión fija la zona horaria en `America/Argentina/Buenos_Aires`: "hoy" es el de la cocina.

### Identificación (GS1)
- **SKU** = `producto.codigo`, propio del negocio. Si se deja vacío al crear, lo genera la base con el
  **prefijo de la categoría** (`LAC-0001`, trigger `producto_sku` con candado por categoría): sigue al mayor
  número con ese prefijo, así que uno tipeado con el mismo formato no se pisa. Las categorías tienen su
  pantalla (`categorias.html`): nombre, prefijo (2 a 6, único, se sugiere del nombre) y activa. **GTIN** en `logic.gtin`, siempre en 14 dígitos
  con dígito verificador validado en la base.
- El GTIN de **fabricante** va en la **presentación** (cada nivel de empaque tiene el suyo: sachet
  y caja son códigos distintos). Escanearlo resuelve producto y cantidad.
- Todo producto nace con un **GTIN interno** con prefijo **040** (rango GS1 de circulación
  restringida dentro de una empresa, 040-049). No hay prefijo de empresa GS1 Argentina todavía:
  si se tramita, los elaborados pasan a GTIN reales. Los 04x los genera sólo la secuencia; un 04x
  tipeado o de otro fabricante se rechaza.
- **Código de lote** limitado a 20 caracteres del juego GS1 (sin espacios ni acentos): es el AI (10).
- **Etiqueta de lote** = QR con **GS1 Digital Link** (`/01/<GTIN>/10/<lote>?17=<AAMMDD>`); la app
  resuelve esa ruta y abre la trazabilidad. Etiqueta de góndola = EAN-13 del GTIN interno. Los
  códigos se generan en el servidor con `bwip-js`, con zona de silencio incluida.
- La lectura (`app/gs1.js`) entiende GTIN suelto, cadenas de AIs con o sin separador GS (los
  lectores en modo teclado lo mandan como Ctrl+]), formato entre paréntesis y Digital Link. Cámara:
  BarcodeDetector si el navegador lo trae; si no, `@zxing/library`, servido desde la app.
- La URL que va en los QR sale de `APP_URL` si está definida; si no, del pedido (`trust proxy`).
- **Catálogo externo** (`app/catalogo.js`): al escanear en Productos un GTIN desconocido se consulta
  **Open Food Facts** (base pública de la comunidad, 3 s de espera máxima) y se precompletan
  nombre, unidad base y presentación. Es sugerencia: nada se guarda en el producto sin que el
  encargado lo revise y guarde. Caché en `logic.catalogo_externo` (encontrados 180 días, no
  encontrados 30). Es la única llamada de la app a un tercero; si algún día hay prefijo GS1,
  la fuente oficial es Verified by GS1.
- **Foto de producto** (`app/fotos.js`, `logic.producto_foto`): una por producto, en la BASE (el
  disco del contenedor se pierde en cada deploy). Propia (el navegador la achica a 800 px + miniatura
  de 160 antes de subirla) o **copia** de Open Food Facts con atribución CC BY-SA obligatoria; nunca
  se enlaza al servidor de ellos. Sólo JPEG/PNG/WebP verificados por contenido (un SVG ejecutaría
  código). La descarga de afuera toma la URL de la caché, nunca del navegador, y exige el host.
  Su servidor de imágenes tarda 5-9 s: la vista previa la baja y la deja en la caché, y guardar
  la copia desde ahí.

### Autenticación y permisos (fase 0, 20/10/2026)
- Esquema `org`: `sede` (centro | local), `usuario`, `usuario_sede` (rol por sede), `sesion`,
  `dispositivo`, `acceso` (registro inmutable de entradas, fallos y cambios de permisos).
  `logic.almacen.sede_id` ata cada almacén a una sede; hoy hay una sola, "Centro".
- **Roles por sede**: encargado, operador, consulta. El **administrador** es global. El catálogo
  (productos, recetas, proveedores, unidades, compras) lo gestiona el **encargado del centro**.
  Anular un movimiento y configurar almacenes o ubicaciones es de encargado de esa sede. Mover el
  costo vigente al recibir una compra también es del catálogo: un operador recibe manteniendo costo.
- **La firma y el permiso por sede los pone la BASE**: la app fija `logic.usuario` en cada conexión
  que presta el pool (`db.js`, AsyncLocalStorage) y los triggers de `movimiento`, `ajuste` y
  `lectura_temperatura` verifican rol de encargado u operador en la sede de la ubicación y escriben
  `registrado_por`. Desde la app (`logic.origen=app` en la cadena de conexión) sin usuario, la base
  rechaza: falla cerrado. Desde psql no se verifica.
- Permiso por ruta en `app/auth.js` (`POLITICA`): una ruta que modifica y no está en la lista exige
  `catalogo`. Una ruta nueva arranca cerrada.
- Entrada con **usuario y clave** (scrypt N=2^15, ojo con la RAM antes de subirlo). Cookie HttpOnly,
  SameSite=Lax, en la base sólo el sha256 del token. Las mutaciones exigen `application/json` (CSRF).
  12 h de inactividad, 7 días como máximo. Al quinto fallo, 15 min de bloqueo; además, freno por IP.
- **PIN** (4-6 dígitos, sin series) sólo en un **dispositivo de cocina** que habilitó un encargado o
  admin entrando con su clave. Ahí las sesiones duran 30 min sin uso. Al quinto PIN malo se
  inhabilita hasta entrar con clave. Los dispositivos se revocan desde Usuarios.
- El nombre de usuario no cambia (firma el historial), un usuario no se borra (se desactiva) y la
  base no deja quedar sin administrador activo.
- **Primer administrador o recuperación** desde la consola del contenedor, que imprime una clave
  temporal: `docker exec -it $(docker ps -q -f name=claulogic_app.1.) node admin.js admin <usuario> "<Nombre>"`
  (o `... node admin.js clave <usuario>` para blanquear).

### Sedes, remitos y pedidos (fase 1, 21/10/2026)
- **Sedes**: las da de alta el administrador (`sedes.html`); un local nuevo nace con almacén
  "Depósito" y ubicación "General". El nombre de almacén es único **dentro de la sede**. Una sede con
  stock o con remitos abiertos no se desactiva.
- **Lo que cada uno ve**: stock, movimientos, ajustes, frío, producciones, remitos, pedidos, almacenes
  y unidades productivas, sólo de sus sedes (`filtroSedes` en `auth.js`, que además acepta
  `?sede=`). El catálogo es común. Las compras sólo las ve quien tiene rol en un centro.
- **Un traslado entre sedes sólo con remito**: lo rechaza el trigger `movimiento_firma` si no trae
  `remito_id`. Con remito, el permiso se verifica en la punta de la sede que despacha.
- **Remito** (`logic.remito`, `RI-000001`): borrador → despachado → recibido, o anulado. Decisión
  de Fer: **traslado directo**, sin stock en tránsito: despachar asienta los traslados al local en el
  momento. El local confirma lo recibido; la diferencia exige motivo y queda como **merma** (faltante)
  o **ajuste** (sobrante) atados al remito. Despachado y sin recibir, sólo el encargado de origen
  anula (vuelven los traslados). Recibido no se anula: remito de devolución. Despachar exige stock
  suficiente por lote y ubicación (a diferencia de los egresos sueltos).
- **Nota de pedido** (`logic.pedido`, `NP-000001`): manual, sin mínimos por local (decisión de Fer).
  El local la arma y la envía; el centro la convierte en remito con lotes por FEFO y avisa lo que
  no alcanza. Si se anula el remito, el pedido vuelve a "enviado".
- **Unidad productiva** (`logic.unidad_productiva`): sector de una sede con almacén de insumos y
  ubicación de salida de la misma sede. Recetas y producciones se asignan a una (opcional).
- Pendiente: mínimos de stock por sede (hoy el mínimo es uno por producto, y en una vista de varias
  sedes compararlo es orientativo).

### Finanzas: comprobantes y cuenta corriente (fase 2, 21/10/2026)
- Esquema `fin`. **Permiso de finanzas** global por usuario (`org.usuario.finanzas`, lo da un admin):
  todo `/api/fin/` lo exige, también para leer, y `fin.registrar_comprobante` y
  `fin.anular_comprobante` lo vuelven a verificar en la base. Un usuario sólo de finanzas no
  necesita sedes. Decisión mía, avisada a Fer: la deuda no la ve un operador.
- **Comprobante** (`fin.comprobante`): factura, nota de crédito o de débito, letra A/B/C/M, renglón por
  renglón (decisión de Fer) con producto opcional, precio neto, descuento y alícuota; más percepciones
  e impuestos. Vinculado a compras recibidas **sólo como referencia**, sin control de importes
  (decisión de Fer). La razón social es **responsable inscripta**: A y M discriminan IVA; en B y C la
  base no admite alícuota. El IVA se calcula por alícuota sobre el neto sumado (como la factura), en
  la base, también para la vista previa (`/fin/comprobantes/calcular`). Se carga el total impreso:
  hasta $1 de diferencia se guarda como redondeo; más, no se registra.
- Borrador → registrado → anulado. Registrado no se edita: se anula (movimiento inverso) y se recarga,
  o se hace nota de crédito. No se anula una factura con notas registradas asociadas. Mismo número,
  mismo proveedor: no se carga dos veces (salvo que el anterior esté anulado).
- **Cuenta corriente** = libro mayor inmutable `fin.movimiento_cc` (haber: lo que se debe; debe: lo que
  lo baja). El saldo se deriva (`fin.saldo_proveedor`), como el stock. `fin.comprobante_pendiente`:
  hasta la fase 3, pendiente = total menos notas de crédito asociadas.
- **Factura directa** (sin compra): en los renglones, la descripción ofrece los productos (trae unidad de
  referencia y alícuota habitual, y queda vinculada) o acepta un concepto libre (flete, servicio). Registra la
  deuda; la mercadería entra al stock sólo al recibir una compra. **Recibir mercadería** (factura que llega
  con la mercadería, decisión de Fer): desde la factura directa (borrador o registrada, con renglones de
  producto y sin compra vinculada) `POST /compras/desde-comprobante/:id` arma la compra pedida con esos
  renglones (unidad del renglón = código de unidad o nombre de presentación; precio = importe redondeado),
  la vincula y abre la recepción (`compras.html#<id>/recibir`). A una factura registrada se le puede
  SUMAR un vínculo con compra (migración 20261102); guardar un borrador no borra el vínculo con una
  compra todavía sin recibir. **Vencimiento** propuesto: fecha del
  comprobante + plazo del proveedor (sin plazo, la misma fecha), editable.
- **Proveedor nuevo** desde la factura o la compra (`nuevoProveedor` en `comun.js`): lo mínimo, el resto en
  Proveedores. Alta y edición de proveedores: permiso `proveedor` = catálogo o finanzas.
- **CUIT** validado con dígito verificador en la base y guardado sin guiones; único entre proveedores.
  Factura A exige CUIT del proveedor. Proveedor con condición IVA y plazo de pago (propone vencimiento).
  Producto con **alícuota habitual** (21 por defecto; 10,5 para carnes, frutas, verduras, harinas).
- **Libro IVA compras** del mes en CSV (`;` y coma decimal, con BOM), notas de crédito en negativo.
- Sin importación de ARCA por ahora (decisión de Fer). Moneda: sólo pesos.
- **Comprobante no fiscal** (decisión de Fer, 22/10/2026): tilde "Comprobante fiscal" al cargarlo; sin tilde es
  **letra X**: precio final sin IVA discriminado, sin CAE ni exigencia de CUIT, punto de venta y número
  opcionales (sin número, la base pone `00000-` + `fin.comprobante_x_seq`). Mismo circuito que el fiscal
  (compra, cuenta corriente, pago); sólo queda fuera del libro IVA.
- El cliente manda cuerpo JSON en toda modificación (también DELETE): el servidor exige JSON contra
  CSRF y un DELETE sin cuerpo no lleva tipo de contenido. Estaba roto desde la fase 0.

### Tesorería (fase 3, 21/10/2026)
- **Cuentas** (`fin.cuenta`): bancos, una caja por sede (decisión de Fer) y una sola cartera de cheques
  de terceros (cuenta del sistema, no se edita; la pantalla lo explica). **Saldo derivado** de `fin.movimiento_tes`, libro mayor inmutable; todo insert exige
  permiso de finanzas en la base (`fin.movimiento_tes_firma`). Movimientos manuales (ingreso/egreso con
  concepto obligatorio), transferencias (dos patas, se anulan juntas) y **arqueo de caja** por diferencia
  (`fin.arquear`, como el conteo de stock).
- **Orden de pago** (`fin.orden_pago`, `OP-000001`): aplica a facturas y notas de débito pendientes
  (total o parcial) y puede usar notas de crédito sin factura asociada (`fin.credito_pendiente`).
  **Retenciones cargadas a mano** con certificado (decisión de Fer: sin cálculo de escalas ni padrones).
  Valores: transferencia (banco), efectivo (caja), cheque propio o e-cheq (banco), cheque de tercero
  de la cartera (se endosa entero). Lo que sobra sobre lo aplicado queda **a cuenta**.
  `fin.registrar_orden_pago` valida contra lo pendiente con lock por proveedor, mueve tesorería,
  emite o endosa cheques y baja la deuda por el **bruto** (valores + retenciones).
  `fin.anular_orden_pago` revierte todo; no se puede si un cheque propio ya se debitó. Una factura con
  pagos registrados no se anula. Los números de OP pueden tener huecos (un borrador borrado consume
  el suyo).
- **Cheques** (`fin.cheque`): propio emitido → debitado (recién ahí sale del banco; el saldo proyectado
  lo descuenta antes); tercero en cartera → endosado o depositado. CUIT del librador validado.
- **Conciliación**: extracto en **CSV** (sin Excel: la librería usual de npm tiene vulnerabilidades),
  mapeo de columnas en el navegador, importes y fechas normalizados en el servidor (el separador
  decimal lo dice el usuario). `fin.extracto_linea` con clave única + `ocurrencia`: reimportar no
  duplica. Pareo sugerido por importe exacto y fecha cercana (±10 días), incluido el débito de cheques
  propios; una línea sin pareo se registra como movimiento desde ahí. `fin.conciliacion` se puede deshacer.
- **Retenciones practicadas** del mes en CSV para el contador.
- **Montos en pesos enteros** (decisión de Fer, 22/10/2026): la plata se tipea sin coma ni centavos y el punto
  es separador de miles ("20.000" = veinte mil). En el servidor, `monto()` (`util.js`) rechaza coma y centavos;
  en el navegador, `pesos()` muestra al peso y `miles()` precarga los campos ("15.000"). Lo calculado (IVA,
  costo por unidad) queda exacto en la base y se muestra redondeado; la diferencia contra el total impreso
  entra en el redondeo de hasta $1. Al copiar renglones de la compra a la factura, si el unitario no da
  entero va 1 por el total con la cantidad en la descripción. Los archivos importados (extractos, POS)
  conservan su separador decimal. Cantidades: la coma es decimal (decisión de Fer): "1,5" kg son 1500 g.

### Proceso de abastecimiento (24/10/2026)
- Idea de Fer: un **asistente paso a paso** para usuarios no técnicos, que **convive** con las pantallas de
  Compras y Facturas (decisión de Fer). `abastecimiento.html` + `app/abastecimiento.js`. **El flujo manda** y
  arranca en el Panel ("Necesito comprar" / "Llegó mercadería"); una sola entrada en el menú. Seis pasos:
  **Necesidad** (la lista de compras, `#lista`) → **Proveedor** (`#lista/proveedor`, agrupado por proveedor;
  "generar pedidos" sigue con el único pedido o deja elegir con cuál) → **Pedido** (proveedor y productos; se cargan UNA vez y arman la compra y los
  renglones del comprobante; el precio puede faltar en un pedido pero es obligatorio para recibir) →
  **Recepción** (ubicación, lote, vencimiento, costo propuesto en "actualizar") → **Comprobante** (fiscal o X,
  datos; fecha y vencimiento arrancan hoy y el plazo del proveedor se muestra como referencia; percepciones
  sólo si es fiscal; total impreso y registrar) → **Pago** (caja o banco, o "pagar después"). El comprobante
  se puede cargar antes de recibir (la factura que llega primero).
- **No hay tablas nuevas**: cada paso guarda en `logic.compra`, `fin.comprobante` y órdenes de pago. La compra
  nace `pedida`; el comprobante se arma desde la compra (`POST /abastecimiento/:id/comprobante`, renglones con
  `compra_item_id`). El pedido se corrige hasta recibir (`PUT /abastecimiento/:id`): si ya hay borrador de
  comprobante, se rehace con los productos nuevos y su misma cabecera. Dos entradas: "Llegó mercadería" y
  "Hacer un pedido".
- **Bandeja** dentro del Panel, común por ahora (decisión de Fer; después, por rol): **se deduce** del
  estado (`GET /abastecimiento/pendientes`), como el stock: pedido sin terminar, esperando mercadería, falta
  el comprobante, comprobante sin registrar, por pagar (primero lo vencido), más las facturas por pagar
  cargadas sin compra. Cada pendiente abre el asistente en el paso que falta (`#<compra>/<paso>`). Los
  importes, sólo para finanzas.
- Segunda vuelta (decisión de Fer): mandar el pedido al proveedor (imprimir, PDF o WhatsApp). Mismo molde
  para el abastecimiento del local (pedido, remito, recepción) y el cierre de ventas del POS.
- En Facturas también: vencimiento por defecto = fecha del comprobante; sin tilde fiscal no hay percepciones.
- **Lista de compras** (decisión de Fer, 24/10/2026: primero qué hace falta, después a quién): una sola lista
  del centro (`logic.necesidad`, pasos 1 y 2 del asistente; `lista-compras.html` sólo redirige), a la que más adelante se suman los pedidos de los
  locales (origen `local`). Se carga a mano o con el botón "sumar lo que está bajo el mínimo" (contra el stock
  de las sedes centro, en unidad de referencia; nunca automático, decisión de Fer). Cada renglón sugiere el
  proveedor de la última compra con su último precio, y lista los demás que lo vendieron. "Generar pedidos"
  arma una compra `pedida` por proveedor con precio estimado (último costo de ese proveedor); lo que queda sin
  proveedor sigue en la lista. Si un pedido se borra o se anula, sus renglones vuelven a la lista (trigger).
- **Entrega parcial** (`POST /abastecimiento/:id/recibir`): en la recepción cada producto tiene "recibido";
  la compra se ajusta a lo que llegó (cantidad y precio en proporción; lo que no llegó se quita) y lo que
  faltó vuelve a la lista como `faltante` (sin proveedor) o se descarta. Si el comprobante ya está registrado
  por lo pedido, no se admite parcial. La recepción en sí es `recibirCompra` de `compras.js`.

### Puntos de venta (fase 4, 21/10/2026)
- Esquema `pos`. Fer: **Fudo y Maxirest**, por **API o archivo según haya**, **ticket por ticket**, y lo que
  no alcanza **queda en negativo**.
- **Fudo por API** (`app/fudo.js`): token en `auth.fu.do/api` (apiKey + apiSecret, 24 h), ventas de
  `api.fu.do/v1alpha1/sales` con `filter[closedAt]`, `include=items.product,payments.paymentMethod`,
  páginas de 500. Requiere plan Pro y habilitar "API Pública General". Su OpenAPI no es del todo
  JSON:API (las relaciones a veces vienen como lista de `{data}`): el adaptador acepta las dos formas.
  **Verificado con la cuenta real de Fer el 25/10/2026** contra lo que muestra Fudo:
  - El **día de una venta es el de su apertura** (`createdAt`), como lo cuenta Fudo: así coinciden ventas,
    cobros y medios (por cierre, la mesa cobrada después de medianoche caía en el día siguiente). Se pide
    `filter[createdAt]=and(gte.<desde>,lte.<hasta>)` (este filtro exige `lte`; el de cierre exige `lt`).
    `pos.ticket.abierto_en` y `pos.ticket.dia` (migración 20261106): `dia` es la apertura, o la fecha si el
    POS no la trae (archivos); cobros por día y tablero agrupan por `dia`.
  - En Fudo, el `price` de un renglón es el **total del renglón**, no el unitario: se guarda como `importe` y
    el unitario es price / cantidad.
  - Las **ventas vacías** (sin productos ni pagos) se ignoran. Una mesa todavía abierta llega al volver a
    sincronizar ese día. **Abierta = ni CLOSED ni CANCELED**: Fudo anula sin `closedAt` los deliveries
    descartados (el 22/10 dos así figuraban como abiertos); una anulada sin cierre toma la apertura.
  - `saleType`: `EAT-IN` salón, `TAKEAWAY` para llevar, `DELIVERY` delivery (antes del 25/10 el delivery se
    guardaba como salón; los tickets ya importados no se reescriben).
  Las ventas traen además `discounts`, `tips` y `shippingCosts`, que todavía no se leen. Los errores de Fudo
  llevan su detalle (`errors[].detail`). `FUDO_AUTH_URL` y `FUDO_API_URL` existen para las pruebas (el
  simulador también rechaza `lte`). Credenciales cifradas con `crypto.js`.
- **Maxirest no tiene API pública**: va por archivo (sus informes de ventas salen a Excel; se guardan
  como CSV). La importación por archivo sirve para cualquier POS: renglones de venta y pagos, con mapeo
  de columnas que se recuerda por integración (`pos.integracion.mapeo`).
- **Recepción idempotente**: `pos.ticket` único por (integración, id del POS); reimportar no duplica y
  una importación sin tickets nuevos no se guarda.
- **Plato de carta** (`logic.plato`): la receta de venta, lo que consume una porción (insumos o
  elaborados, con merma). `pos.articulo` lo vincula con el artículo del POS, o lo marca sin consumo.
- **Procesar es aparte y en dos partes**: el **consumo** (operación, permiso en la sede) descuenta del
  almacén del local por FEFO sin lotes vencidos, un movimiento `venta` por producto y lote (no por
  ticket), y lo que falta va en negativo: en el último lote conocido si es perecedero, sin lote si no.
  Un perecedero que nunca tuvo lote frena el proceso. Los **cobros** (finanzas) entran por cuenta y por
  día a la cuenta de cada medio (`pos.medio.cuenta_id`): efectivo a la caja del local, tarjetas y QR
  a una cuenta de tipo **cobranza**, que pasa al banco con una transferencia cuando se acredita.
- Anular una importación revierte consumo y cobros y borra sus tickets para reimportar. Con cobros
  procesados, la anula finanzas. Finanzas ve las integraciones de todos los locales.
- **Sede central, puntos de venta y medios de pago** (decisiones de Fer, 25/10/2026; migración 20261104):
  - **Sede central** (`org.sede.es_central`, una sola, configurable en Sedes para usar la app en otro negocio;
    hoy CF CENTRAL): consolida las finanzas del grupo y **no tiene puntos de venta**.
  - **Una sede tipo "punto de venta" (`tipo = 'local'`) ES un sistema de venta** (decisión de Fer, 25/10/2026;
    migración 20261105): su configuración (sistema, modo, código, credenciales), sus artículos y sus medios se
    cargan en la **ficha de la sede** (`sedes.html`, sólo el administrador); no hay pantalla de puntos de
    venta (`puntos-venta.html` redirige). Por debajo sigue `pos.integracion`, **una por sede**
    (`integracion_sede_ux`), con el nombre de la sede y su única ubicación. Si un local tiene dos sistemas, son
    dos sedes. El tipo de una sede no cambia. Un local tiene **un solo almacén y una sola ubicación, de tipo
    depósito** (triggers `local_un_almacen` y `local_una_ubicacion`): lo de adentro del local está fuera de
    control; **stock y frío se gestionan sólo en el centro**. Nace con su **cuenta de efectivo**
    (`Efectivo · <sede>`, `cuenta_efectivo_id`): su saldo es lo que tiene pendiente de rendir a la central;
    rendir es una transferencia a la caja de la central.
  - **Medios de pago globales** (`fin.procesador` + `fin.medio_pago`, pantalla `medios-pago.html`):
    procesador (Mercado Pago, Getnet, Fudo Pagos) × tipo de operación (QR, transferencia, débito, crédito), más
    el efectivo. Cada procesador acredita en **una** cuenta (si no se elige, se crea "<procesador> a
    acreditar"); el tipo queda en cada cobro (`pos.ticket_pago` → `pos.medio.medio_pago_id`) para calcular
    después el costo de cada operación.
  - Cada texto del sistema ("TARJETA DEBITO") se asigna a un medio global en Puntos de venta (encargado o
    finanzas; finanzas puede dar de alta un medio desde la última opción). La cuenta del medio **se deriva**
    (trigger `pos.medio_cuenta`: la del procesador, o la de efectivo del punto de venta) y se recalcula si
    cambia la cuenta del procesador. El procesamiento de cobros no cambió: usa `pos.medio.cuenta_id`.
- **El día del punto de venta es la unidad financiera** (decisiones de Fer, 25/10/2026; migración 20261107):
  - Estado **deducido** (`pos.jornada`, como el stock): *con pendientes* (algún pago con un medio del sistema
    sin su medio de pago) → *diferencia* (lo cobrado no coincide con lo vendido) → *listo para cobrar* →
    *cobrado*. Alertas: medios sin asignar, diferencia, ventas anuladas, y ventas que seguían **abiertas** al
    sincronizar (`pos.sincronizacion_dia`, lo único que se guarda: ese día no está completo).
  - **Los días sin observaciones se procesan solos** (decisión de Fer, 25/10/2026): al sincronizar o importar,
    si quien lo hace tiene finanzas, `procesarListos` procesa cada día del rango con medios asignados, cobrado
    = vendido y sin ventas abiertas, cada uno en su transacción; la respuesta trae `cobros.procesados` y
    `cobros.revisar` (con el motivo). Sin finanzas quedan "listos" y finanzas los procesa todos con
    `POST /pos/jornadas/:integracion/procesar` (botón en Procesar ventas). A mano sólo lo que tiene algo.
  - Los **cobros se procesan por día y todo o nada** (`POST /pos/jornadas/:integracion/:dia/cobros`, finanzas):
    con un medio sin asignar no se procesa; con diferencia, sólo con un **motivo**, que queda en `pos.cobro`
    con la diferencia. La ruta vieja por importación procesa cada día que trae, con las mismas reglas.
  - Anular una importación revierte enteros los cobros que tocan sus pagos (los de otras importaciones del día
    vuelven a pendientes). La anula el encargado del local o finanzas (antes un usuario sólo de finanzas no
    podía, aunque la regla decía que era suya).
  - En Procesar ventas, la lista de **Días** con su estado y el detalle del día (cifras, alertas, medios y su cuenta,
    procesar). Lo financiero no depende del consumo: los artículos y las recetas quedan para después (Fer).
  - Un día con un medio sin asignar queda bloqueado, pero **se corrige desde el detalle del día**: quien procesa
    (finanzas o el administrador) asigna ahí el medio de pago, con "+ Agregar medio de pago…" al final
    (`nuevoMedioPago` en `comun.js`), y termina de cobrar. Por eso `PUT /pos/medios/` es admin o finanzas.
  - **El día en curso no se importa** (decisión de Fer): ni Fudo (el rango tiene que terminar ayer) ni un
    archivo con ventas de hoy. Procesar ventas propone ayer por defecto.
- **Ventas = tablero; Procesar ventas = back office** (decisión de Fer, 25/10/2026). `ventas.html` es para ver y
  analizar, con estilo de tablero (pedido de Fer: moderno, minimalista, gráficos de resumen y el detalle a medida
  que se navega): período en botones (ayer, 7 días, este mes, mes anterior, fechas) y local; **cifras** (vendido,
  ventas, ticket promedio, cubiertos, por cubierto) con **variación contra el período anterior** de la misma
  duración y mini curva por día; **área** de ventas por día con el anterior punteado (un solo día: columnas por
  hora); **dona** de medios de pago (global, o el nombre del sistema si falta asignarlo) con cobrado contra vendido;
  por hora, **dona** por tipo de venta y ranking por mozo (por local si hay varios). **Tocar** un día, medio, hora,
  tipo o mozo agrega un filtro (chips) y abre el detalle; una venta se abre en un panel lateral. El promedio por
  cubierto es lo vendido en las ventas con personas sobre esas personas (para llevar y delivery no traen
  cubiertos). Sólo lectura: `GET /pos/ventas/resumen` (con `anterior`), `/pos/ventas` (filtros `medio`, `tipo`,
  `hora`, `mozo`; máximo 1.000) y `/pos/ventas/:id`, con el alcance por sede de las importaciones. Horas en la de
  Buenos Aires. `procesar-ventas.html` tiene importar, días y cobros, importaciones y consumo.
- **Gráficos de los tableros**: `graficos.js` (`Graf.area`, `columnas`, `dona`, `mini`, `ranking`, `variacion`) y
  `graficos.css` (tarjetas, cifras, botones de período, chips, panel lateral `dialog.panel-lado`; ojo: la clase
  `lateral` es la barra del menú). Paleta categórica de 6 en orden fijo validada para claro y oscuro contra los
  fondos de la app; la leyenda lleva valor y porcentaje porque en claro tres colores quedan bajo 3:1.
- **Acreditación de los procesadores** (decisiones de Fer, 25/10/2026; migración 20261108). Dos cuentas por
  procesador: la **"a acreditar"** (cobranza: lo vendido que todavía no depositó) y la **cuenta real** donde deposita
  (`fin.procesador.cuenta_acredita_id`, tipo banco; Pago24: "Pago24 · 210973"), que se elige en Medios de pago. Su
  extracto se importa en **Conciliación** (con la columna de **saldo**: toma el inicial y el final; si la cuenta no
  tiene movimientos, el inicial queda como **apertura** el día anterior) y **"Conciliar automáticamente"**:
  1. compensa cada línea con su **reverso** (`extracto_linea.compensa_a`, sin movimientos);
  2. parea cada **ingreso** con un pago de venta de ese procesador ya procesado (mismo importe, del día de la venta
     hasta 4 días después, el más cercano): transferencia de "a acreditar" a la cuenta real, conciliada, y
     `ticket_pago.acreditado_linea_id`;
  3. asienta **cargos** (`gasto = comision`, con `iva` incluido si el procesador no lo cobra en línea aparte: el
     "Cargo de Pago24" de las transferencias es 3% + IVA), **IVA** (`iva_credito`), **impuesto a los débitos y
     créditos** (`imp_debitos_creditos`) y **retenciones**, atados al pago por el **número de operación** del
     procesador (`extracto_linea.operacion`, sacado de la referencia: "#1580009466", "Pago Cliente - …");
  4. lo demás queda pendiente (la **Recaudación** de Pago24 son pagos que salen de esa cuenta: se conciliarán con
     las órdenes de pago a proveedores, decisión de Fer).
  El resumen muestra saldo del sistema contra el del extracto (la diferencia la explican las líneas pendientes), lo
  vendido sin acreditar por día y el **costo real por tipo de operación** (en la prueba con el extracto real:
  transferencia 4,23%, débito 6,5%, crédito 10,2%). Deshacer una línea conciliada así anula su movimiento (las dos
  patas de la acreditación) y el pago vuelve a pendiente; esos movimientos no se anulan desde Cajas y bancos.
  **La pantalla pone el foco en lo que falta resolver** (pedido de Fer): arriba el estado en una frase ("Faltan
  resolver N líneas" o "Todo conciliado") con el saldo del sistema contra el del extracto; luego "Para resolver",
  agrupado (egresos sin identificar, ingresos sin identificar, en el sistema pero no en el extracto) con qué puede
  ser cada cosa y su acción; el costo por tipo y lo vendido sin acreditar en una tarjeta chica; lo conciliado,
  cerrado, como respaldo (`GET /fin/conciliacion/hechas`, de a 100 y con búsqueda). Importar un extracto en la
  cuenta de un procesador concilia en el mismo paso. Los movimientos sin conciliar sólo cuentan desde el inicio de
  los extractos y sin los anulados.
  **Pareos sugeridos** (decisión de Fer, 26/10/2026; nunca automáticos, se confirman con un toque): una venta
  pagada en partes (2 o 3 ingresos pendientes que suman exacto un cobro) y un ingreso que difiere del cobro hasta
  el 10% o $5.000 (el mayor), con motivo obligatorio. `POST /fin/conciliacion/acreditar`: el cobro sale entero de
  "a acreditar" y entra lo que llegó, una pata por línea (con diferencia, las patas no son iguales y el motivo
  queda en el concepto). Deshacer una parte deshace el grupo. El costo por tipo ata los gastos al cobro por el
  número de operación del extracto (no por el movimiento), así cuentan también los cargos asentados antes de
  confirmar. Las propinas de Fudo (`tips`) siguen sin leerse (Fer: por ahora no).
  **Mercado Pago**: se importan juntos (selección múltiple) el **resumen de cuenta** (account_statement: saldo
  inicial y final, y cada movimiento por su neto, con destinatario en transferencias y pagos) y el reporte de
  **liquidaciones** (settlement: por operación, bruto, comisión e impuestos). El resumen es el extracto; cada
  "Liquidación de dinero" se busca por su número en las liquidaciones y se abre en cobro (bruto), comisión (IVA
  incluido) e impuesto a los débitos y créditos, que suman exacto el neto. "Pago de impuestos <destinatario>" es el
  impuesto a los débitos y créditos de una transferencia enviada (0,6%), no una retención. El de liquidaciones solo
  no se importa (se duplicaría al llegar el resumen); el resumen solo sí, pero los cobros quedan por el neto.
  Verificado con los de Fer de octubre: QR y transferencia 1,57%, débito 2,23%, crédito 7,85%.
  Pago24 (verificado con su extracto de octubre): un movimiento por transacción; las tarjetas (Prisma) liquidan con
  "Gasto Transaccion" + "AR_IVA" aparte: débito en el día, crédito a los 2 días.
- Pendiente: sincronización automática programada (hoy es a pedido), modificadores de Fudo
  (subitems), propinas; acreditación de Mercado Pago y Fudo Pagos (con sus extractos); rendición del efectivo.

### Tablero (fase 5, 21/10/2026)
- **No guarda nada**: `logic.kardex` abre cada movimiento en una fila por punta (sede, signo, costo) y
  `logic.kardex_concepto` le pone para qué sirvió: teórico (ventas del POS), pérdida (merma, vencimiento),
  diferencia (ajustes de conteo y sobrantes de remito), consumo interno, venta manual, producción, compra,
  transferencia (remito entre sedes) e interno. Las anulaciones se cancelan solas al sumar.
- **Valorización**: al costo del lote; lo que no tiene lote, al costo vigente de hoy (aproximación, avisada
  en pantalla). Lo que no tiene costo no suma y se cuenta aparte.
- **Food cost** sobre ventas netas: las ventas del POS se toman con IVA incluido (21% por defecto, se
  cambia en la pantalla). Real = teórico + pérdida + diferencia + consumo interno + venta manual. Por
  producto, dónde está el desvío; por plato, costo de la porción con costo vigente, food cost y margen.
- **Flujo de caja** (sólo finanzas): entradas y salidas por semana desde `fin.movimiento_tes` (sin
  transferencias ni depósitos de cheques, que no son flujo) y saldo proyectado a 8 semanas: disponible
  (bancos + cajas) menos lo vencido, menos facturas por vencimiento y cheques propios por fecha de pago,
  más cheques de terceros en cartera. No proyecta ventas futuras.
- Lo ve el encargado (sus sedes), finanzas y el administrador (todas). `app/tablero.js`, `tablero.html`.
- **Mismo estilo que Ventas** (pedido de Fer, 25/10/2026), con `graficos.js`: período en botones (este mes, mes
  anterior, 7 días, fechas), sede e IVA arriba, y dos pestañas (**Food cost** y **Flujo de caja**, ésta sólo
  finanzas; se recuerda la última). Cifras con variación contra el período anterior de la misma duración (se
  pide `operativo` dos veces; en costos, subir es malo, y el food cost varía en puntos); food cost por local en
  barra con el teórico como marca (`Graf.referencia`; "alto" si el real pasa al teórico por más de 3 puntos;
  tocar un local abre sus productos); dona de la composición del consumo real (tocar una parte ordena los
  productos por ese concepto); productos con desvío y platos (food cost, "alto" sobre 35%) en barras, cada uno
  con su tabla en "Ver como tabla". Caja: entradas y salidas por semana (`Graf.columnasSeries`) y saldo
  proyectado en área (admite negativos y avisa la semana en que baja de cero). Sin cambios en la API.
- **Pendiente de definir con Fer cuando avancen las pruebas** (21/10/2026): verificar Fudo con una cuenta
  real; confirmar la valorización de los no perecederos a costo vigente; confirmar el IVA 21% incluido
  por defecto en las ventas del POS; probar usuarios y permisos por rol (después del circuito básico).

### Lo que hay y lo que falta
Hay: panel, stock y conteos, movimientos (histórico, egresos, traslados, anulación), compras con
recepción y decisión de costo, recetas, producción con FEFO, trazabilidad por lote, frío,
productos (SKU y GTIN), etiquetas A4 con QR Digital Link y EAN-13, almacenes, proveedores y unidades,
login con roles por sede, PIN en tablet de cocina, Mi cuenta y administración de usuarios,
sedes, notas de pedido, remitos internos y unidades productivas, comprobantes de proveedor,
cuenta corriente, libro IVA compras, órdenes de pago, tesorería, cheques, conciliación bancaria,
platos de carta, integración con POS (Fudo por API, archivo para cualquiera), consumo teórico y tablero
(food cost, teórico contra real, rentabilidad por plato, flujo de caja).
Lectura de códigos con lector USB/Bluetooth o cámara en productos, compras, conteos y egresos. API en `app/*.js` (helpers comunes en `app/util.js`); pantallas
en `app/public/` con estilos y helpers compartidos en `comun.css` y `comun.js`.

**Interfaz.** `comun.js` arma la navegación de todas las pantallas: barra lateral agrupada desde
900 px; en el celular, barra inferior (Panel, Stock, Escanear, Productos, Más). **Escanear** es
global: producto abre su ficha, lote su trazabilidad, código desconocido va al alta
(`productos.html#nuevo/<gtin>`). Productos usa rutas en el `#` (`#p/<id>`, `#nuevo`) para que en
el celular listado y ficha sean pantallas separadas con el botón atrás funcionando.
El menú va en **grupos desplegables**: abierto el de la pantalla actual y los que el usuario abrió
(`localStorage`). La descripción bajo el título (`h1 + p.sub` sin id) queda detrás de un botón "?".
**Celular primero** (gran parte de la operación es desde el teléfono): tablas con clase `movil` + `etiquetarTabla`
pasan a tarjetas; botones a todo el ancho en el asistente. **"Agregar nuevo…" como última opción** de una lista
de valores, nunca un botón al costado (decisión de Fer): `opcionesConAlta` / `opcionesProveedor` en `comun.js`
(proveedor en todas las pantallas, categoría en Productos) y "+ Crear producto nuevo" al final de la lista de
productos del asistente (`nuevoProducto`: nombre, categoría, unidad, perecedero, IVA; SKU automático).
**Guardar sólo con cambios**: `comun.js` apaga (clase `sin-cambios`, no `disabled`, que las pantallas
usan mientras esperan al servidor) todo botón submit que empieza con "Guardar" o "Crear" hasta que hay
un cambio, y lo vuelve a apagar cuando el guardado sale bien. Un cambio que no pasa por un campo
(foto, renglón agregado por código) se avisa con `marcarCambios(form)`; al abrir un registro, `sinCambios(form)`. Tipografía
Archivo servida desde el paquete npm (`/vendor/archivo`), nunca de Google Fonts. Campos a 16 px en
el celular: con menos, el iPhone hace zoom al tocarlos.

Falta: recepción en varias entregas de una misma compra (hoy lo que falta pasa a la lista de compras), anular una compra recibida o una
producción entera, mínimos por sede, lectura de sensores de temperatura, importación de ARCA,
extractos en Excel, cheques de terceros rechazados, sincronización automática de POS, y costeo histórico de los no perecederos (hoy van a costo vigente).

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
- **Nunca responder 502 desde la app**: el proxy de EasyPanel (`bad-gateway-error-page` en
  `/etc/easypanel/traefik/config/main.yaml`) reemplaza todo 502 por su propia página HTML y el detalle se
  pierde (el navegador veía "respuesta inválida"). Para fallas de un servicio externo (Fudo, Open Food Facts)
  se usa **424** con el mensaje, y se registra en el log. Si al navegador le llega algo que no es JSON,
  `api()` muestra el código HTTP.
- El proxy de Cloudflare va **apagado** en el A record. Prendido, Traefik no puede resolver el
  desafío de Let's Encrypt y el certificado nunca sale.
- El VPS **no tiene swap** y son 7,8 GB de RAM compartidos con ClaUsina, n8n y Chatwoot. Un pico
  de memoria no se degrada: lo mata el OOM killer.
- El contenedor de la base cambia de nombre en cada deploy
  (`claulogic_db.1.<hash>`): descubrilo con `docker ps -q -f name=claulogic_db.1.`, nunca lo fijes.
