# Excel Online y OneDrive personal

El archivo original conserva su ubicación y su identificador. La web descarga el `.xlsx` y, cuando se autoriza escritura, actualiza sus registros sin reconstruir todo el libro. No utiliza la API Microsoft `/workbook`, que no es la conexión elegida para esta cuenta personal.

## Registro y permisos

1. Registrar una aplicación Microsoft que admita cuentas personales y una plataforma Web con callback HTTPS `/api/onedrive/callback` en el origen público de la aplicación.
2. Configurar `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI`, `APP_ORIGIN` y `ONEDRIVE_TOKEN_KEY` como secretos del servidor. La última es una clave AES-GCM aleatoria de 32 bytes en base64. No cambiarla para actualizar el código: los tokens existentes dependen de ella.
3. **Conectar OneDrive** solicita `Files.Read` y `offline_access`. Permite Excel → web.
4. **Activar envío web → Excel** solicita `Files.ReadWrite` y `offline_access` mediante un consentimiento adicional. El permiso de Microsoft abarca los archivos de la cuenta; la aplicación escribe únicamente el libro propio seleccionado. Una conexión de lectura existente conserva ese alcance hasta que el usuario autorice la ampliación.
5. Seleccionar explícitamente el libro `.xlsx`. Si la búsqueda no lo devuelve, introducir su ruta exacta, por ejemplo `Documents/PROGRAMA  DE PEDIDOS.xlsx`; los espacios del nombre se conservan.

El flujo OAuth usa los endpoints `consumers`, PKCE, estado de un solo uso y cookie HTTP-only. Los tokens se cifran con AES-GCM y el propietario forma parte de los datos autenticados. El callback fijo se valida contra `APP_ORIGIN`; los encabezados de un proxy no definen el destino. Desconectar elimina las credenciales guardadas y conserva los registros de negocio. No permite que una autorización antigua en curso restablezca la conexión desconectada.

## Orden de sincronización

La automática comprueba el archivo al abrir la aplicación y cada 60 segundos mientras la página esté visible. No es un servicio en segundo plano cuando la web está cerrada. El botón **Sincronizar ahora** permite iniciar la misma comprobación manualmente.

1. Consultar el `eTag` y descargar el archivo, verificando que no cambió durante la descarga.
2. Leer clientes, pedidos, precios, pagos, cotizaciones y borradores. Una fila incompleta detiene la importación de todo el lote; no se importa una fracción silenciosamente.
3. Aplicar cambios de Excel dentro de una transacción PostgreSQL, con referencias por ID y comprobación de revisiones y baselines.
4. Si hay escritura autorizada, capturar los cambios pendientes de la web. Parchear los campos de entrada por ID, conservando las partes ajenas del ZIP, fórmulas, validaciones, estilos y fotos.
5. Registrar un trabajo durable con el hash de los bytes preparados y las revisiones exactas. Enviar `PUT /content` con `If-Match` del `eTag` leído. Microsoft rechaza una versión que haya cambiado.
6. Confirmar las revisiones que realmente se enviaron. Si la web cambió otra vez durante el envío, esos cambios posteriores permanecen pendientes para el siguiente ciclo.

Una respuesta incierta de Microsoft no se interpreta como éxito. El siguiente intento compara el hash exacto del archivo con el trabajo pendiente antes de confirmar o repetir. Una desconexión, cambio de cuenta o cambio de generación de la conexión impide confirmar ese trabajo en una conexión distinta.

## Conflictos y conservación

- IDs estables relacionan las hojas. El nombre y el teléfono del cliente pueden cambiar sin cambiar su ID.
- Si Excel y la web modifican el mismo registro desde la última versión compartida, la sincronización se pausa. Se deben revisar las versiones y sus revisiones antes de continuar. Reintentar sin resolver la diferencia no fuerza una sobrescritura.
- Una edición únicamente en la web se conserva durante la lectura y se envía al archivo cuando existe permiso de escritura.
- Omitir una fila de Excel no borra el registro de la web. Un movimiento ya importado no puede modificarse ni reaparecer automáticamente después de eliminarse en la web.
- Las cotizaciones no crean deuda ni un pedido comprado. Las filas de `Facturas` son borradores y nunca emiten documentos automáticamente.
- Las facturas emitidas conservan sus datos al momento de la emisión. `FacturasEmitidas` y `DetalleEmitidas` son un archivo de consulta escrito desde la web; editar esas hojas no altera las facturas guardadas.
- Se admite un `.xlsx` de hasta 5 MB. Las fotos también consumen ese límite. Conservar registros por períodos evita que el libro crezca sin control.

## Hojas del libro

| Hoja | Uso |
| --- | --- |
| Inicio | Resumen y selectores por código de cliente o pedido. |
| Clientes | Maestro de contactos con ID estable. |
| Pedidos | Artículos, cliente, estado, tienda, fechas, variante y foto. |
| Precios | Precio unitario, cargos, descuento y pago a tienda; total, abonos y saldo calculados. |
| Pagos | Abonos y devoluciones con ID propio y referencia al pedido. |
| Cotizaciones / DetalleCotizaciones | Cabecera y artículos propuestos al cliente. |
| Facturas / DetalleFacturas | Borradores y avisos de entrega para revisar y emitir en la web. |
| FacturasEmitidas / DetalleEmitidas | Copia de consulta de los documentos emitidos. |
| Cambios | Historial de sustituciones. Los cambios nuevos se realizan desde la web para conservar los movimientos. |
| Listas / Guía | Catálogos y explicación del trabajo. |
| Referencia original | Ejemplo inicial del usuario, conservado en el libro privado. |

Las cabeceras del libro diseñado están en la fila 4 y los datos empiezan en la 5. El lector también admite el formato anterior. Las celdas amarillas son entradas; las grises contienen cálculos o datos de consulta. Hay 200 filas preparadas por tabla y los selectores y resúmenes cubren hasta la fila 504; ampliar el libro más allá requiere ampliar esas referencias, no solamente añadir datos.

## API y pruebas

- `GET /api/onedrive/status`: conexión, alcance de escritura, archivo, últimas fechas y trabajo pendiente.
- `GET /api/onedrive/start` y `GET /api/onedrive/start?mode=write`: autorización de lectura o ampliación a escritura.
- `GET /api/onedrive/callback`: valida y guarda la autorización.
- `POST /api/onedrive/disconnect`: revoca la conexión guardada en esta aplicación.
- `GET /api/onedrive/files?query=...` y `POST /api/onedrive/select`: buscar y seleccionar el archivo propio.
- `GET /api/onedrive/download`: descarga verificada con `X-OneDrive-Etag` y `X-OneDrive-File-Id`; admite `If-None-Match`.
- `POST /api/onedrive/sync`: importación atómica de las colecciones y sus baselines.
- `POST /api/onedrive/push` con `{fileId,etag}`: envío condicionado de los cambios de la web y recuperación del trabajo pendiente.

Las suites PostgreSQL usan esquemas aleatorios en una rama QA y respuestas de Graph simuladas. Las pruebas de XML comprueban el archivo resultante y la conservación de partes, fórmulas, estilos, fotos y rangos. Estas pruebas no sustituyen la autorización real de Microsoft ni la comprobación del libro en Excel Online. Las pruebas de interfaz y emisión usan datos ficticios aislados; no se emiten facturas de producción para probar botones.
