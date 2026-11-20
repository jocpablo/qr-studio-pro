# QR Studio Pro

Generador, lector y gestor de códigos QR: diseño avanzado, verificación real de legibilidad, lotes (ZIP), hojas de impresión (PDF), caducidad y **QR dinámicos** con servidor propio.

## Archivos

| Archivo | Descripción |
|---|---|
| `qr-studio-pro.html` | La aplicación (la sirve el servidor; instalable como PWA) |
| `qr-studio-pro-standalone.html` | Versión de un solo archivo: doble clic y funciona sin conexión |
| `qr-server.js` | Servidor de QR dinámicos (Node.js 18+, sin dependencias) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Archivos de la PWA |
| `Dockerfile`, `render.yaml`, `fly.toml` | Despliegue |

## Uso local

```bash
npm start            # o: node qr-server.js
```

Abre `http://localhost:8787`. La clave de administración aparece en la consola (o defínela con `ADMIN_TOKEN`).
En la app: **Caducidad → Dinámico**, pega la clave y pulsa **Conectar**.

## Publicar en Render

1. En [render.com](https://render.com): **New → Blueprint** y elige este repositorio.
2. Render lee `render.yaml`: construye la imagen Docker, genera `ADMIN_TOKEN` y monta un disco en `/data`.
3. Copia la clave desde **Environment → ADMIN_TOKEN** y úsala en la app.
4. Opcional: dominio propio → define `PUBLIC_URL=https://qr.tudominio.com`.

> El plan gratuito no tiene disco persistente: los enlaces y estadísticas se perderían al reiniciar.

## Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `8787` | Puerto HTTP |
| `ADMIN_TOKEN` | generada | Clave de la API |
| `DATA_FILE` | `./qr-data.json` | Archivo de datos |
| `PUBLIC_URL` | detectada | URL pública para construir los enlaces cortos |
