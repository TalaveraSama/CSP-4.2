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
   22.04, 18 en 24.04) y el panel necesita >= 20. Si no encuentra una válida
   prueba, por este orden:
   1. el repositorio **NodeSource** (`deb.nodesource.com`),
   2. si no responde, el **tarball oficial** de `nodejs.org`, que descarga,
      verifica con SHA-256 y descomprime en `/opt/node` (enlaces en
      `/usr/local/bin`).

   Las descargas tienen *timeout* corto y reintentan **forzando IPv4**, que es
   la causa habitual de los `Connection timed out`. Opciones:
   `--node-major 20` (otra línea de Node), `--node-from nodesource|tarball|skip`,
   `NODE_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/nodejs-release` (espejo),
   o `https_proxy=...` si sales por proxy.
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
| `--node-from auto\|nodesource\|tarball\|skip` | de dónde sacar Node; `skip` = ya lo tienes instalado |
| `-y, --yes` | sin preguntas, valores por defecto |
| `--force` | ejecutar en una distro no soportada (Debian) |
| `--uninstall` / `--purge` | desinstalar (conservando / borrando la config) |

## Actualizar

Volver a ejecutar el instalador reinstala la versión nueva y **conserva
`/etc/csp-panel/panel.env`** (es un conffile de dpkg); el servicio solo se
reinicia si ya estaba en marcha:

```bash
cd CSP-4.2 && git pull
sudo bash panel/packaging/install-ubuntu.sh --yes
```

El historial de cambios viaja en el paquete: `apt changelog csp-panel` o
`zcat /usr/share/doc/csp-panel/changelog.Debian.gz`.

## "Instalé y no me abre"

Por seguridad el panel escucha **solo en loopback** (`HOST=127.0.0.1`): se abre
desde el propio servidor, no desde tu portátil. Tres salidas:

```bash
# a) abrirlo a la LAN  ->  http://<ip-del-servidor>:8090/
sudo bash panel/packaging/install-ubuntu.sh --listen 0.0.0.0 --yes
sudo ufw allow 8090/tcp          # solo si tienes ufw activo

# b) publicarlo con nginx (recomendado, permite HTTPS con certbot)
sudo bash panel/packaging/install-ubuntu.sh --domain panel.midominio.com --yes

# c) sin tocar nada, túnel ssh desde tu portátil
ssh -L 8090:127.0.0.1:8090 root@<ip-del-servidor>   # y abre http://127.0.0.1:8090/
```

Re-ejecutar el instalador **no cambia lo que ya tenías**: si no pasas
`--backend`/`--url`, toma los valores actuales de `panel.env` como predeterminados.

Comprobaciones rápidas en el servidor:

```bash
curl http://127.0.0.1:8090/healthz     # debe responder {"ok":true,...}
ss -lntp | grep 8090                   # 127.0.0.1:8090 = solo local, 0.0.0.0:8090 = LAN
systemctl status csp-panel
```

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
| `Failed to connect to deb.nodesource.com ... timed out` | NodeSource bloqueado en tu red. El instalador ya cae solo al tarball de `nodejs.org`; si eso también está bloqueado usa un espejo (`NODE_MIRROR=...` con `--node-from tarball`), un proxy (`export https_proxy=...` + `sudo -E`), o instala Node a mano y repite con `--node-from skip` |
| Sin salida a internet en el servidor | compila el `.deb` en otra máquina (`bash panel/packaging/build-deb.sh`), cópialo y ejecuta `sudo bash install-ubuntu.sh --deb csp-panel_*_all.deb --node-from skip` |
| No abre desde otro PC | el panel está en `HOST=127.0.0.1`; reinstala con `--listen 0.0.0.0` o usa nginx (`--domain`) |
| `502 Bad Gateway` en nginx | el servicio no está arrancado o `PORT`/`HOST` de `panel.env` no coinciden con el `proxy_pass` del vhost |
| Certificado autofirmado del softcam | `INSECURE_TLS=1` en `panel.env` (ya viene activado) |
| Panel en subdirectorio | reinstala con `--base-path /csp/`; el bundle se recompila con esa ruta base |

Desinstalar:

```bash
sudo bash panel/packaging/install-ubuntu.sh --uninstall   # conserva /etc/csp-panel
sudo bash panel/packaging/install-ubuntu.sh --purge       # lo borra todo
```
