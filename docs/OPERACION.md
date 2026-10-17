# Despliegue genérico

Se incluye Docker Compose con FastAPI, almacenamiento persistente y Caddy para HTTPS. Se necesita un dominio propio y los puertos 80/443 disponibles.

```bash
cp .env.example .env
# Configura APP_DOMAIN con tu dominio y dirige su DNS al servidor.
docker compose up -d --build
```

Las claves opcionales permanecen en `.env`, excluido de Git. No se requieren para el OCR local. En ejecución nativa el backend no carga `.env` automáticamente: exporta las variables en el entorno del proceso.

Los datos residen en el volumen `accounts`. No elimines el volumen para actualizar la aplicación. Consulta `backend/app/backup.py` y `backend/app/restore.py` para copias consistentes y restauración con validación de hashes. `scripts/backup-encrypted.sh` es una referencia que requiere configurar rutas y una clave age propia.

Antes de usar datos reales, configura copias externas y comprueba su restauración. La aplicación no incorpora cifrado en reposo, segundo factor ni recuperación por correo. TLS no sustituye esas medidas.
