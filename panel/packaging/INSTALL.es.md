# Instalar el panel en Ubuntu 20.04 / 22.04 / 24.04

Un solo comando deja el panel instalado como servicio del sistema, sin Java,
sin Tomcat y sin tocar nada de la instalación legacy.

```bash
git clone https://github.com/TalaveraSama/CSP-4.2.git
cd CSP-4.2
sudo bash panel/packaging/install-ubuntu.sh
```

El instalador va preguntando (backend, URL del softcam, puerto, dominio) y
acepta los valores por defecto con Enter. Para desatendido:

```bash
# OSCam en la misma máquina, publicado en un subdominio
sudo bash panel/packaging/install-ubuntu.sh \
     --backend oscam --url http://127.0.0.1:8888 \
     --domain panel.midominio.com --yes

# NCam (fork de OSCam) — local o en otra máquina
sudo bash panel/packaging/install-ubuntu.sh \
     --backend ncam --url http://192.168.1.10:8888 --yes

# CardServProxy
sudo bash panel/packaging/install-ubuntu.sh \
     --backend csp --url http://127.0.0.1:8082 --yes

# Solo probarlo, con datos de demo y sin softcam
sudo bash panel/packaging/install-ubuntu.sh --backend mock --yes
```

Sin clonar nada (descarga las fuentes él solo):

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/CSP-4.2/arena/01a0f2ba-csp-4-2/panel/packaging/install-ubuntu.sh \
  | sudo bash -s -- --backend oscam --url http://127.0.0.1:8888 --yes
```

## Qué hace, paso a paso

1. Comprueba que es Ubuntu 20.04, 22.04 o 24.04 (`--force` para Debian 11/12).
2. Instala `curl`, `ca-certificates` y `python3` si faltan.
3. **Node.js**: Ubuntu trae versiones demasiado viejas (10 en 20.04, 12 en
   22.04, 18 en 24.04) y el panel necesita >= 20. Si no encuentra una válida,
   añade el repositorio oficial de NodeSource y instala Node 22
   (`--node-major 20` para fijar otra línea).
4. Compila el paquete (`packaging/build-deb.sh`) **como el usuario dueño del
   checkout**, para no dejar `node_modules` propiedad de root, y lo instala con
   `apt install ./csp-panel_*.deb`.
5. Escribe `/etc/csp-panel/panel.env` respetando lo que ya hubiera (solo cambia
   las claves que tocan: `BACKEND`, `OSCAM_URL`/`CSP_URL`, `MOCK`, `PORT`,
   `HOST`) y lo deja en `root:csp-panel 0640`.
6. `systemctl enable --now csp-panel` y espera a que `/healthz` responda.
7. Si le pasas `--domain`, instala nginx si hace falta, crea el vhost
   (con `X-Forwarded-Proto`, que es lo que activa la cookie `Secure`),
   valida con `nginx -t` y recarga.

## Opciones

| Opción | Para qué |
| --- | --- |
| `--backend oscam\|ncam\|csp\|mock` | qué softcam gestiona el panel (`ncam` = fork de OSCam) |
| `--url URL` | interfaz web del softcam, local o remota (OSCam/NCam `httpport`, CSP status-web) |
| `--port N` / `--listen ADDR` | dónde escucha el panel (por defecto `127.0.0.1:8090`) |
| `--domain HOST` | además configura un vhost de nginx para ese dominio |
| `--base-path /csp/` | servir el panel en un subdirectorio en vez de un dominio |
| `--no-nginx` | no tocar nginx |
| `--deb FICHERO` | instalar un `.deb` ya compilado en lugar de compilar |
| `--node-major N` | línea de Node a instalar si falta (por defecto 22) |
| `-y, --yes` | sin preguntas, valores por defecto |
| `--force` | ejecutar en una distro no soportada (Debian) |
| `--uninstall` / `--purge` | desinstalar (conservando / borrando la config) |

## Después de instalar

```bash
sudo systemctl status csp-panel      # estado
journalctl -u csp-panel -f           # logs
sudoedit /etc/csp-panel/panel.env    # configuración (luego: systemctl restart csp-panel)
curl http://127.0.0.1:8090/healthz   # comprobación rápida
```

### Softcam local o remoto

Da igual dónde esté: `--url http://127.0.0.1:8888` para la misma máquina,
`--url http://192.168.1.10:8888` (o un host público/VPN) para otra. En el lado
remoto hay que añadir la IP del panel a `httpallowed` y dejar el puerto del
webif accesible; si va por internet, usa TLS en el softcam (`httpport=+8443`,
con `INSECURE_TLS=1` si el certificado es autofirmado) o un túnel/VPN.

Entra con las credenciales de la interfaz web de tu softcam: nunca se guardan
en el navegador, el panel las mantiene en una sesión de servidor detrás de una
cookie `httpOnly`.

TLS con Let's Encrypt (después de `--domain`):

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d panel.midominio.com
```

## Problemas típicos

| Síntoma | Causa / solución |
| --- | --- |
| El panel arranca pero el login da 403 | en `oscam.conf`/`ncam.conf` `[webif]` falta la IP del panel en `httpallowed`, o `httpuser`/`httppwd` no coinciden |
| Instalé NCam y el panel da 404 | NCam usa `/ncamapi.html`: asegúrate de `BACKEND=ncam` (no `oscam`) en `panel.env` |
| `no node interpreter found` | Node instalado con nvm (solo visible para tu usuario): pon `NODE_BIN=/ruta/a/node` en `/etc/csp-panel/panel.env` |
| `502 Bad Gateway` en nginx | el servicio no está arrancado o `PORT`/`HOST` de `panel.env` no coinciden con el `proxy_pass` del vhost |
| Certificado autofirmado del softcam | `INSECURE_TLS=1` en `panel.env` (ya viene activado) |
| Panel en subdirectorio | reinstala con `--base-path /csp/`; el bundle se recompila con esa ruta base |

Desinstalar:

```bash
sudo bash panel/packaging/install-ubuntu.sh --uninstall   # conserva /etc/csp-panel
sudo bash panel/packaging/install-ubuntu.sh --purge       # lo borra todo
```
