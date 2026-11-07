# Mi tienda — inventario individual

Aplicación derivada de Mi encargo. Conserva su base de autenticación y PostgreSQL y añade una caja local con IndexedDB, inventario, movimientos y comprobantes internos. No integra NCF/e-CF en esta entrega, por instrucción del usuario del 6 de noviembre de 2026.

## Perfiles de tienda

La aplicación ofrece tres perfiles: Librería Valencia, Electrónica Valencia y Decoraciones Valencia. Cada perfil tiene su propio catálogo, existencias, ventas, movimientos, cola de sincronización, datos del negocio y respaldos. El selector superior cambia el perfil sin combinar datos. Librería conserva la clave de inventario que ya usaba la versión anterior para mantener sus datos; los otros perfiles usan claves independientes en IndexedDB y espacios separados en PostgreSQL. El modo de demostración también tiene un conjunto aislado por perfil.

## Separación

- Rama de desarrollo y despliegue: `inventario-individual`. No fusionar con `main` de Pedidos.
- Espacio Render: Inventario Tiendas, distinto de TEMU.
- Proyecto Neon: mi-tienda-inventario, distinto de temu-mi-encargo.
- No copiar variables, cuenta, PIN, datos ni enlaces de OneDrive de Mi encargo.
- No necesita Excel/OneDrive como base de datos. CSV se usa para importar artículos nuevos y exportar existencias.

## Operación

1. El propietario crea un solo acceso y selecciona el perfil de la tienda.
2. Desde la computadora de caja, elige **Configurar esta PC como principal**. Solo se permite una PC principal por instalación.
3. Registra productos individualmente o importa CSV UTF-8. Cada código es único. Cantidades: hasta tres decimales; moneda: centavos de RD$.
4. Entradas y salidas de ajuste exigen motivo. No se permiten existencias negativas.
5. Una venta se guarda junto con los descuentos y los movimientos en una sola transacción local IndexedDB. Un reintento conserva el identificador y no duplica el descuento.
6. La anulación conserva el comprobante y reintegra la mercancía una sola vez.
7. Cada comprobante tiene opciones separadas **Descargar PDF** e **Imprimir**. La descarga de PDF requiere que el comprobante esté sincronizado; la impresión del navegador puede usar impresoras físicas o un controlador de PDF instalado.
8. La PC sincroniza cuando la aplicación está abierta. Si falta internet, conserva sus datos y continúa operando. No se promete sincronización con la aplicación cerrada.
9. El celular consulta la copia de la nube. Solo solicita ventas cuando la PC está disponible; no confirma la venta hasta que la PC la haya guardado y el comprobante se haya subido. Los pedidos pendientes de atender expiran, y una operación en procesamiento conserva su identidad para resolver respuestas inciertas.

## Respaldo y recuperación

Descargar el JSON al cerrar la jornada y guardarlo fuera del equipo. La recuperación solo está habilitada sobre una copia local vacía y para la misma cuenta. No sustituir la PC principal con operaciones pendientes. Esta primera versión no incluye un asistente de traslado a otra PC sin el respaldo original.

El modo de demostración (`?demo=1`) usa otra clave de IndexedDB y nunca sincroniza con la tienda real. El programa debe abrirse y preparar su caché al menos una vez antes del primer uso sin internet.

Cada perfil de demostración se carga con 10 artículos y 4 comprobantes internos por artículo para revisar la separación, el descuento de existencias y la impresión/guardado a PDF. Estos registros son ficticios y no se envían a la base real.

## Desarrollo y validación

- Node 24 y las dependencias bloqueadas del proyecto original.
- `npm ci`, `npm run test:inventory`, `npm run build`.
- Variables nuevas e independientes: DATABASE_URL (pooled), DATABASE_URL_UNPOOLED (migraciones), APP_ORIGIN, APP_DATA_OWNER_ID, APP_OWNER_USERNAME y APP_SETUP_TOKEN. Nunca publicar sus valores.
- Migraciones en `db/migrations/`; no alterar migraciones ya aplicadas.
- Comprobar lectura local después de cerrar/abrir, interrupción real del servidor, reintentos, dos ventas sobre la última unidad y sincronización de PC a nube a celular.
- Las pruebas PostgreSQL deben apuntar a la rama QA del proyecto nuevo. Nunca utilizar la base Temu para estas pruebas.

## Límites de esta versión

Comprobantes internos, sin validez fiscal. Una caja principal y celulares dependientes de su confirmación. Respaldo JSON completo y sincronización por instantáneas hasta el límite de cuerpo de 8 MB. Antes de superar ese tamaño se requiere migrar a sincronización incremental. La continuidad depende del almacenamiento del navegador, del disco y del equipo; no borrar los datos del navegador con operaciones pendientes.
