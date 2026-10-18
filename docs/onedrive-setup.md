# Conexión de lectura con OneDrive personal

La aplicación está preparada para una conexión real. Hasta configurar un registro de aplicación de Microsoft, el estado devuelve `configured: false`; no se simula una cuenta conectada ni se descarga mediante cookies del navegador.

## Registro y autorización

1. Registrar una aplicación de Microsoft Entra que admita cuentas personales de Microsoft.
2. Configurar una plataforma **Web**. Su URI de redirección debe ser exactamente el origen HTTPS público de la aplicación seguido de `/api/onedrive/callback`, sin parámetros ni fragmentos.
3. Permitir Microsoft Graph con el permiso delegado `Files.Read`. El flujo también solicita `offline_access`. No se solicitan permisos de escritura ni se utiliza la API `/workbook`.
4. Configurar en las variables de entorno del servicio de Render `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI` y `ONEDRIVE_TOKEN_KEY`. Esta última debe ser una clave AES-GCM aleatoria de 32 bytes codificada en base64. La variable general `APP_ORIGIN` debe contener el origen público, por ejemplo `https://mi-app.onrender.com`, sin barra final. No guardar secretos reales en el repositorio, el navegador ni esta documentación.
5. En la aplicación, usar **Conectar OneDrive**, iniciar sesión en Microsoft y autorizar la lectura. Seleccionar explícitamente el libro propio `PROGRAMA DE PEDIDOS.xlsx` entre los resultados.

Si el buscador de Microsoft no devuelve un archivo que sí está en la cuenta, el mismo campo permite escribir su ruta de carpetas, por ejemplo `Documents/Pedidos.xlsx`. La ruta se resuelve directamente en el OneDrive autorizado, conserva los espacios del nombre y aplica la misma validación de libro propio `.xlsx`. No requiere permisos adicionales ni cambia el archivo de ubicación.

El registro de aplicación y el consentimiento son acciones externas necesarias. Publicar el código o disponer de cuentas de Render y Neon no los crea automáticamente. Las credenciales confidenciales y la clave de cifrado deben configurarse como secretos del servidor. Una clave de cifrado nueva impide abrir conexiones guardadas con otra clave; se debe volver a conectar la cuenta. El callback utiliza `APP_ORIGIN` para validar la dirección y volver a la web; no confía en el host interno del proxy ni en encabezados de origen reenviados.

## Sincronización

El flujo es **Excel → web**. No modifica el libro en OneDrive. Descarga el archivo `.xlsx` entero, con un límite de 5 MB, y el cliente utiliza el mismo lector de Excel y fotos del importador. El servidor verifica la versión antes y después de descargar y antes de confirmar la importación. Los identificadores de pedido y pago deben permanecer estables en el Excel.

Cada archivo y pedido guarda un baseline con su huella y la revisión aplicada en la web. Los siguientes cambios del mismo Excel se aplican con esa revisión, aunque la columna Revisión del libro siga en cero. Si el pedido se modificó en la web, la sincronización se detiene y conserva todos los registros. Para reconciliarlo se deben revisar ambas versiones; una fila que ya coincide con la web puede establecer un baseline nuevo. Las filas ausentes no se eliminan y los pagos/cambios existentes no se sobrescriben.

No se sincroniza una copia antigua si el Excel cambia mientras se procesa. Los movimientos ya importados también guardan su huella: si un abono se elimina en la web, leerlo de nuevo desde el Excel no lo vuelve a registrar. Esa diferencia requiere revisión. Las comprobaciones de presencia dentro de la transacción también cubren una eliminación mientras se está confirmando el lote.

Las relecturas del mismo `eTag` no duplican artículos, pagos, fotos ni eventos. Una versión sin cambios devuelve HTTP 304 y evita descargar de nuevo las imágenes. Las facturas emitidas mantienen sus snapshots.

Si una comprobación encuentra filas incompletas u otros errores de validación del Excel, conserva el aviso y no importa ninguna parte del lote. La automática vuelve a comprobar el libro cada 60 segundos mientras la página está visible, de modo que completar la fila permite continuar sin pulsar Reintentar. Los errores de autorización, servidor y conflictos sí pausan la automática hasta su revisión. El aviso de un libro que solo tiene encabezados permanece entre comprobaciones sin cambios.

Los tokens se cifran con AES-GCM y datos adicionales del propietario, los estados OAuth son de un solo uso y caducan a los 10 minutos, y el flujo utiliza PKCE y una cookie HTTP-only. Desconectar borra los tokens de acceso y renovación del servidor; conserva los pedidos y movimientos. Una autorización que estuviera en curso antes de desconectar no puede restablecer la conexión.

## API

- `GET /api/onedrive/status`: configuración disponible, conexión, archivo seleccionado, versión sincronizada y último resultado.
- `GET /api/onedrive/start`: navegación completa hacia Microsoft; requiere una sesión privada de la aplicación.
- `GET /api/onedrive/callback`: callback fijo, verifica estado y propietario.
- `POST /api/onedrive/disconnect`: elimina las credenciales guardadas del propietario.
- `GET /api/onedrive/files?query=PROGRAMA`: búsqueda de archivos propios `.xlsx`.
- `POST /api/onedrive/select` con `{fileId}`: selección explícita del archivo.
- `GET /api/onedrive/download`: bytes del archivo y encabezados `X-OneDrive-Etag` y `X-OneDrive-File-Id`; admite `If-None-Match` de la última versión sincronizada.
- `POST /api/onedrive/sync` con `{orders,payments,exchanges,fileId,etag,generatedIds:0}`: importación atómica y actualización de baselines. Devuelve HTTP 409 con una lista de conflictos cuando necesita revisión.

## Verificación

`tests/onedrive-postgres.test.mjs` ejecuta las rutas y su SQL real en un esquema temporal aislado de PostgreSQL, con respuestas simuladas de Microsoft. Comprueba PKCE, aislamiento de propietario, cifrado, código de un solo uso, renovación, selección, descarga, versiones, sincronización concurrente sin duplicados, conflictos, pagos y cambios inmutables y la desconexión durante una autorización. El esquema temporal se elimina al terminar. Se necesita `TEST_DATABASE_URL` con una conexión directa, sin pooler, para establecer su `search_path`; nunca se utilizan tablas de negocio existentes.

`tests/onedrive-unit.test.mjs` comprueba además el cifrado con propietario y detección de alteraciones, las reglas de baselines y el callback detrás de un proxy. Estas pruebas no equivalen a una autorización real contra Microsoft; esa validación queda pendiente hasta registrar la aplicación y conectar la cuenta.

`tests/onedrive-panel.test.mjs` ejecuta el componente con temporizadores y respuestas simuladas para comprobar que una fila incompleta no escribe ni sube fotos, que el sondeo visible puede recuperarse al completar los datos, que el aviso de encabezados se conserva y que los errores 401/409/500 mantienen la pausa. Está incluido en `npm run test:unit` y no utiliza datos de negocio.
