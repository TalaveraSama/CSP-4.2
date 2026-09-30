# Desplegar el panel en aaPanel

El panel es una app Node normal (API + SPA en un solo proceso), así que encaja
directamente en aaPanel usando **Node Project Manager (PM2)** + **Nginx como
proxy inverso**. No hace falta Java, PHP ni base de datos.

Resumen: un proceso Node escuchando en `127.0.0.1:8090`, y Nginx publicándolo
en tu dominio con SSL.

---

## 0. Requisitos en aaPanel

En *App Store* instala:

- **Node.js Version Manager** → instala **Node 20 o superior** (22 recomendado).
- **Nginx** (cualquier versión soportada).
- Opcional: **PM2 Manager** (el gestor de proyectos Node ya lo usa por debajo).

El servidor de aaPanel tiene que poder **llegar al CSP o al OSCam** por red
(ping/puerto). Si OSCam está en un receptor de la LAN, aaPanel debe estar en esa
misma LAN o tener VPN/ruta hacia él.

---

## 1. Subir el código

```bash
mkdir -p /www/wwwroot/csp-panel
cd /www/wwwroot/csp-panel
git clone https://github.com/TalaveraSama/CSP-4.2.git .
# o sube un zip desde Files y descomprime
```

## 2. Construir

```bash
cd /www/wwwroot/csp-panel/panel
bash deploy/aapanel/install.sh
```

El script instala dependencias, compila el frontend y el servidor, y crea un
`.env` a partir de `.env.example` si no existe. (Si prefieres hacerlo a mano:
`npm install && npm run build`.)

> Usa la ruta completa del node de aaPanel si `node` no está en el PATH del
> shell, p.ej. `/www/server/nodejs/v22.11.0/bin/npm`.

## 3. Configurar el backend

Edita `/www/wwwroot/csp-panel/panel/.env`:

```ini
PORT=8090
HOST=127.0.0.1          # solo local: Nginx hace de puerta de entrada

# --- OSCam ---
BACKEND=oscam
OSCAM_URL=http://192.168.1.10:8888

# --- o CardServProxy ---
# BACKEND=csp
# CSP_URL=https://10.0.0.5:8082

SECURE_COOKIES=auto      # activa cookie Secure automáticamente si entras por https
TRUST_PROXY=loopback     # confía en el X-Forwarded-Proto de Nginx
```

En OSCam recuerda permitir la IP de aaPanel en `oscam.conf`:

```ini
[webif]
httpport    = 8888
httpuser    = admin
httppwd     = secret
httpallowed = 127.0.0.1,IP_DE_AAPANEL
```

## 4. Crear el proyecto Node en aaPanel

*Website → Node project → Add Node project*:

| Campo | Valor |
| --- | --- |
| Project directory (项目目录) | `/www/wwwroot/csp-panel/panel` |
| Startup file / Run command | `npm start` (o script `server/dist/index.js`) |
| Node version | 20+ |
| Project port | `8090` |
| Run user | `www` |
| Package manager install | ya hecho en el paso 2, puedes desmarcarlo |
| Enable external access / dominio | pon tu dominio aquí y aaPanel crea el proxy |

Si prefieres controlarlo tú con PM2:

```bash
cd /www/wwwroot/csp-panel/panel
pm2 start deploy/aapanel/ecosystem.config.cjs
pm2 save && pm2 startup
```

Comprobación rápida:

```bash
curl http://127.0.0.1:8090/healthz
# {"ok":true,"backend":"oscam","mock":false,"target":"http://192.168.1.10:8888"}
```

## 5. Nginx

Si aaPanel no creó el proxy automáticamente, ve a *Website → tu dominio →
Reverse proxy* y usa `http://127.0.0.1:8090`, o pega a mano el contenido de
[`nginx-subdomain.conf`](nginx-subdomain.conf) en *Config file*.

¿Quieres servirlo en un subdirectorio (`https://midominio.com/csp/`)? Recompila
indicando la ruta base y usa [`nginx-subdirectory.conf`](nginx-subdirectory.conf):

```bash
cd /www/wwwroot/csp-panel/panel
BASE_PATH=/csp/ npm run build
pm2 restart csp-panel
```

## 6. SSL y seguridad

- *Website → SSL → Let's Encrypt* y activa **Force HTTPS**. Con
  `SECURE_COOKIES=auto` la cookie de sesión pasa a `Secure` sola.
- Deja el panel escuchando en `127.0.0.1` (paso 3) para que **solo** se pueda
  entrar por Nginx; no abras el 8090 en el firewall de aaPanel.
- Las credenciales de CSP/OSCam **nunca llegan al navegador**: viven en la
  sesión del servidor; el navegador solo tiene una cookie opaca `httpOnly`.
- Si publicas el panel en internet, añade en aaPanel *Security → WAF* o una
  regla `allow/deny` por IP en la config del sitio.

---

## Actualizar

```bash
cd /www/wwwroot/csp-panel
git pull
cd panel && npm install && npm run build
pm2 restart csp-panel     # o "Restart" en el Node project de aaPanel
```

## Problemas frecuentes

| Síntoma | Causa / solución |
| --- | --- |
| `502 Bad Gateway` | El proceso Node no está arriba o el puerto no coincide: `pm2 logs csp-panel`, `curl 127.0.0.1:8090/healthz`. |
| Login OK pero recarga y pide login otra vez | Falta `proxy_set_header X-Forwarded-Proto $scheme;` en Nginx, o `SECURE_COOKIES=always` sin HTTPS. |
| `Cannot reach OSCam at ...` | `httpallowed` no incluye la IP de aaPanel, o firewall/red entre ambos. |
| `OSCam rejected the credentials` | Usuario/clave distintos de `httpuser`/`httppwd`; si usas digest, revisa que no haya otro proxy delante. |
| Pantalla en blanco en subdirectorio | Falta recompilar con `BASE_PATH=/csp/` o el `proxy_pass` no acaba en `/`. |
| Todo va pero los datos son inventados | Está en modo mock: quita `MOCK=1` del `.env` y define `OSCAM_URL`/`CSP_URL`. |
