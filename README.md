# Mi encargo

Web privada para organizar pedidos de Temu y SHEIN, clientes, cotizaciones, fotos, abonos, devoluciones, cambios, historial y facturas en pesos dominicanos.

## Funcionamiento

- Foto, cliente, variante, precio al cliente y pago a tienda por separado.
- Registro de clientes por ID, cotizaciones con artículos propios y borradores de factura relacionados con los pedidos.
- Importación y exportación Excel con IDs estables y fotos. Plantilla en public/plantilla-pedidos.xlsx.
- Cancelar conserva los movimientos y el saldo a favor. Los cambios conservan el ID y los pagos.
- Historial registrado en la misma transacción que cada operación.
- Facturas inmutables: precios de los artículos o monto manual, importes opcionales y aviso de entregas pendientes.
- Acceso privado con usuario y contraseña, sesiones revocables y límites de intentos persistentes.
- PostgreSQL y fotos privadas en Neon. El disco de Render no guarda datos de negocio.

## Desarrollo

Node.js 24, Next.js 16 y React 19. Configurar las variables de .env.example en .env.local para desarrollo o en Render para producción. Nunca guardar credenciales en Git.

    npm ci
    npm run db:migrate
    npm run dev

En Render: Web Service, rama main, Virginia, Free. Build: npm ci && npm run build. Inicio: npm run db:migrate && npm start. Escucha en 0.0.0.0 y respeta PORT. APP_ORIGIN es el origen HTTPS real sin ruta. Las migraciones se verifican por checksum y se ejecutan en transacción con bloqueo.

La cuenta única se crea en /setup con el usuario configurado y una clave de instalación aleatoria de 32 caracteres o más. El dueño elige un PIN de exactamente 4 dígitos directamente en la web. El acceso permite un máximo de 5 intentos fallidos por 15 minutos; un acceso correcto reinicia el contador. La clave se recibe en el fragmento del enlace y se elimina del navegador al abrir el formulario. Después de crear la cuenta, el alta queda cerrada. Las cabeceras de identidad de otros alojamientos no conceden acceso.

## Excel Online y OneDrive

La importación manual funciona sin aplicación Microsoft. La lectura automática requiere registrar y autorizar una aplicación Microsoft y configurar MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_REDIRECT_URI y ONEDRIVE_TOKEN_KEY. Render y Neon no conceden acceso a OneDrive. Ver docs/onedrive-setup.md.

La sincronización lee Excel hacia la web cuando la página está abierta y visible. El consentimiento adicional Files.ReadWrite activa el envío web → Excel, con escritura condicionada por eTag y trabajos durables. Revisiones y baselines detectan cambios simultáneos; las filas ausentes del Excel no borran pedidos de la web. Las facturas escritas en Excel llegan como borradores y solo se emiten mediante una acción explícita en la web. El archivo incluye hojas de consulta de las emitidas.

### Regenerar la plantilla

`scripts/build-workbook.mjs` genera por defecto `public/plantilla-pedidos.xlsx`: 14 hojas con resumen, consultas por ID, tablas, fórmulas y desplegables. La plantilla no incluye clientes, pedidos, fotografías ni una copia del archivo original.

Es una herramienta de desarrollo que usa `@oai/artifact-tool` del runtime de documentos de Codex. No forma parte de las dependencias ni del arranque de producción. Después de obtener la ruta de paquetes con `load_workspace_dependencies`, en PowerShell:

    $env:CODEX_WORKSPACE_NODE_MODULES = '<ruta de Node.js packages del runtime>'
    node scripts/build-workbook.mjs

`--output <ruta.xlsx>` cambia el destino y `--previews <carpeta>` guarda las vistas de verificación. El modo privado `--source <libro-original.xlsx>` conserva los dos pedidos y la hoja de referencia del formato original. Este modo exige `--output` fuera de `public/` para evitar publicar datos personales. Mantener sus archivos y vistas fuera del repositorio.

## Pruebas

    npm run test:unit
    npm run test:postgres
    npm run test:pdf
    npm run build

TEST_DATABASE_URL debe apuntar a la rama QA verificada en tests/postgres-safety.mjs. Cambiar de rama de pruebas requiere actualizar conscientemente esa lista permitida. Las suites generan esquemas aleatorios aislados y solo eliminan esos esquemas al terminar. No usar datos financieros de producción en pruebas exploratorias.

El plan gratuito de Render puede suspender el servidor por inactividad. Los datos y las fotos permanecen en Neon.
