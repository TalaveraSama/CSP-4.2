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

## Instalar también NCam (softcam + panel de una vez)

El repositorio trae NCam en [`vendor/ncam`](../../vendor/README.md) (copia de
`fairbird/NCam`, GPL-3). Con `--install-ncam` el instalador lo compila y lo
deja funcionando:

```bash
sudo bash panel/packaging/install-ubuntu.sh --install-ncam --backend ncam --yes
```

Eso hace, además de instalar el panel:

1. instala las dependencias de compilación (`build-essential`, `libssl-dev`,
   `libusb-1.0-0-dev`, `libpcsclite-dev`, `zlib1g-dev`),
2. compila `vendor/ncam` y copia el binario a `/usr/local/bin/ncam`,
3. si no existe, escribe `/etc/ncam/ncam.conf` con el webif en el puerto 8888,
   usuario `admin` y **contraseña aleatoria** (te la imprime al terminar), con
   `httpallowed=127.0.0.1,::1`,
4. instala y arranca `ncam.service`,
5. configura el panel con `BACKEND=ncam` y `NCAM_URL=http://127.0.0.1:8888`.

Opciones: `--ncam-port`, `--ncam-user`, `--ncam-pass`. Si ya tenías
`/etc/ncam/ncam.conf` **no se toca**: se reutiliza el puerto que ya tuvieras.

Gestión: `systemctl status ncam`, `journalctl -u ncam -f`. Los ficheros
`ncam.conf`, `ncam.user`, `ncam.server`… se editan desde la pestaña *Config*
del panel.

## Qué instalar según tu montaje

| Quiero… | Comando |
| --- | --- |
| **Proxy delante, NCam con los lectores** (lo normal) | `sudo bash install.sh --all --yes` → el panel gestiona **el proxy** |
| **Solo NCam**, sin proxy | `sudo bash install.sh --only-ncam --yes` → el panel gestiona **NCam** |
| Solo el panel, contra algo que ya tengo | `sudo bash install.sh --backend ncam --url http://IP:8888 --yes` |

Cambiar de uno a otro después es una línea y no destruye nada:

```bash
sudo bash panel/packaging/install-ubuntu.sh --backend csp  --url http://127.0.0.1:8082 --yes
sudo bash panel/packaging/install-ubuntu.sh --backend ncam --url http://127.0.0.1:8888 --yes
```

## Lectores (tarjetas y líneas) en NCam

Con el proxy delante, **los lectores van siempre en NCam**: el proxy no habla
con tarjetas ni con servidores remotos, solo le pide a NCam. Para añadir una
línea remota:

```bash
sudo bash panel/packaging/install-ubuntu.sh --add-reader "cccam://usuario:clave@servidor.com:12000"
sudo bash panel/packaging/install-ubuntu.sh --add-reader "newcamd://usuario:clave@10.8.0.5:10000?key=0102030405060708091011121314"
```

Opciones: `--reader-label NOMBRE` y `--reader-group N` (el grupo debe coincidir
con el de la cuenta `csp` en `ncam.user`). Escribe el bloque `[reader]` en
`/etc/ncam/ncam.server` y reinicia NCam; luego lo ves en la pestaña *Readers*
del panel (con `BACKEND=ncam`) o en `journalctl -u ncam -f`.

Una tarjeta local (lector USB/PCSC) se configura igual pero con
`protocol = internal|smartreader|…` y `device = /dev/ttyUSB0`; eso se edita
en la pestaña *Config* → `ncam.server`.

## Todo en uno

```bash
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/CSP-4.2/arena/01a0f2ba-csp-4-2/install.sh | sudo bash
```

Eso instala **la pila entera**: panel + NCam + CardServProxy + peer de cache,
cableados entre sí. Equivale a `install-ubuntu.sh --all --yes`, y cualquier
opción que le pases al script se reenvía al instalador:

```bash
sudo bash install.sh --all --listen 0.0.0.0 --csp-caid 0x1810 --yes
sudo bash install.sh --backend mock --yes        # solo mirar el panel
```

Si una pieza no se puede montar (por ejemplo no hay JDK para compilar el
proxy), **no aborta**: avisa, deja el resto funcionando y el panel apuntando
al softcam.

## Pila completa: CSP + NCam + panel

Topología que monta `--install-csp` (los clientes entran al proxy, NCam solo
ve al proxy, y los dos comparten cache):

```
   clientes --newcamd--> CSP :10001 --newcamd--> NCam :10000 --> tarjetas
                           |                        |
                           +---- cache CSP (udp) ---+
                          54278                   54279
```

```bash
sudo bash panel/packaging/install-ubuntu.sh --install-ncam --install-csp --yes
```

Hace, por este orden:

1. instala el panel,
2. compila e instala NCam (`/usr/local/bin/ncam`, `ncam.service`),
3. instala un JDK, compila el proxy con `panel/packaging/build-csp.sh`
   (javac directo, sin Ant: el `build.xml` original compila con `source=1.4`,
   que javac rechaza desde JDK 12, y usa `rmic`, borrado en JDK 15),
4. escribe `/etc/cardservproxy/proxy.xml`: perfil `ncam`, puerto newcamd para
   tus clientes, conector hacia NCam, `ClusteredCache` enlazada al `csp_port`
   de NCam y `status-web` en 127.0.0.1:8082 con una cuenta admin y contraseña
   aleatoria,
5. añade a `ncam.conf` lo que falta (`[newcamd] port`, `[cache] csp_port`) y
   una cuenta `csp` en `ncam.user` para el proxy — sin tocar nada de lo que ya
   tuvieras,
6. instala y arranca `cardservproxy.service`,
7. deja el panel con `BACKEND=csp` apuntando al status-web.

Opciones: `--csp-port`, `--csp-user`, `--csp-pass`, `--csp-client-port`,
`--csp-caid` (el CAID de tu proveedor, p.ej. `0x0B00`).

Con el proxy delante, **las cuentas de tus clientes se crean en el panel**
(pestaña *Accounts*): el panel edita los `<user>` de `proxy.xml` y lo reenvía
por `/cfgHandler`, y el proxy lo recarga. NCam ya no tiene cuentas de cliente.

Gestión: `systemctl status cardservproxy ncam csp-panel`,
`journalctl -u cardservproxy -f`, log del proxy en
`/opt/cardservproxy/log/cardservproxy.log`.

## El panel como peer de cache

`--install-csp` instala además `csp-cache-node`: un **proceso aparte** que se
mete en el cluster de cache por UDP hablando el mismo protocolo que el
`ClusteredCache` de CSP y el `csp_port` de NCam. El panel solo lee sus
estadísticas (pestaña *Cache*): peers vivos y su latencia, entradas
almacenadas, ecm→cw que entran y salen, y las últimas entradas con su origen.

Va en su propio servicio a propósito: una cache tiene que estar siempre
levantada y guarda estado, mientras que reiniciar el panel no debe costar
nada.

```bash
systemctl status csp-cache-node
sudoedit /etc/csp-panel/cache.env      # CACHE_PORT, CACHE_PEERS, CACHE_MAX_AGE
sudo systemctl restart csp-cache-node
curl http://127.0.0.1:8099/stats       # lo mismo que ve el panel
```

Para unirse a un cluster que ya tengas, sin instalar CSP:

```bash
sudo bash panel/packaging/install-ubuntu.sh --cache-peers 10.8.0.2:54278,127.0.0.1:54279 --yes
```

## Cuentas de clientes (los dos paneles)

La pestaña **Accounts** funciona con los dos backends:

| Backend | Dónde escribe | Cómo se aplica |
| --- | --- | --- |
| CSP (recomendado) | `/etc/cardservproxy/users.xml` | el panel escribe el fichero y lanza `update-users`: **no recarga el proxy** |
| CSP (instalación antigua) | `<user>` dentro de `proxy.xml` | se reenvía por `/cfgHandler` y el proxy recarga su configuración entera |
| OSCam / NCam | `ncam.user` | se guarda por el webif y el softcam relee las cuentas al instante |

### Miles de usuarios

Con las cuentas dentro de `proxy.xml`, **cada alta recarga el proxy entero**.
Con 1000 clientes eso no es sostenible, así que el instalador configura
`XmlUserManager`: `proxy.xml` se queda solo con los perfiles, conectores,
cache y la cuenta admin, y los clientes viven en `users.xml`.

Si ya tenías una instalación con las cuentas dentro de `proxy.xml`:

```bash
sudo bash panel/packaging/install-ubuntu.sh --migrate-users
```

Mueve los clientes a `users.xml`, deja los admin en `proxy.xml` (para que el
login del panel no dependa de un fichero que el propio panel reescribe),
cambia la clase del `user-manager` y guarda copia de seguridad del original.

## ¿Y las contraseñas?

Ninguna pieza tiene usuarios propios: **el panel reenvía el login a lo que
gestiona**, así que la contraseña está siempre en uno de estos dos ficheros.

```bash
sudo bash panel/packaging/install-ubuntu.sh --credentials
```

```
Where the passwords live

  CardServProxy  /etc/cardservproxy/proxy.xml
    admin              MiClave2026 (admin)
    the panel logs in here

  NCam web interface  /etc/ncam/ncam.conf  [webif]
    admin              RLedh7bEEFM

  NCam client accounts  /etc/ncam/ncam.user  (2)
    csp                proxy1pass
    cliente1           abc123
```

Cambiar la contraseña con la que entras al panel (aleatoria si no pones una):

```bash
sudo bash panel/packaging/install-ubuntu.sh --reset-password
sudo bash panel/packaging/install-ubuntu.sh --reset-password MiClaveNueva
```

Dar de alta un cliente (va a `proxy.xml` si tienes CSP, y si no a `ncam.user`):

```bash
sudo bash panel/packaging/install-ubuntu.sh --add-user cliente1
sudo bash panel/packaging/install-ubuntu.sh --add-user cliente1 suclave
```

Con CSP delante, lo normal es crear los clientes desde la pestaña **Accounts**
del panel; estos comandos son para cuando no puedes entrar.

En modo demo (`MOCK=1`) vale cualquier usuario y contraseña, y `admin` entra
como administrador.

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
| `--install-ncam` | compila e instala NCam (de `vendor/ncam`) y apunta el panel a él |
| `--install-csp` | compila e instala el proxy java, lo cablea a NCam (conector + cache) y apunta el panel a él |
| `--csp-port/-user/-pass` | status-web del proxy y su cuenta admin |
| `--csp-client-port`, `--csp-caid` | puerto newcamd para tus clientes y CAID del perfil |
| `--cache-peers`, `--cache-port` | se une al cluster de cache y activa la pestaña *Cache* |
| `--credentials` | enseña qué cuentas hay y en qué fichero |
| `--migrate-users` | saca las cuentas de `proxy.xml` a `users.xml` (para miles de clientes) |
| `--only-ncam` | panel + NCam, sin proxy |
| `--add-reader URL` | añade una línea cccam/newcamd a `ncam.server` |
| `--reset-password [CLAVE]` | nueva contraseña para la cuenta con la que entras al panel |
| `--add-user NOMBRE [CLAVE]` | alta de un cliente |
| `--ncam-port/-user/-pass` | ajustes del webif de NCam que se crea |
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
| `Startup failed: Unsupported java vm 'OpenJDK…'` | CSP solo aceptaba la JVM de Sun; hay que arrancarlo con `-Dcom.bowman.cardserv.allowanyjvm=true`. Ya va en `cardservproxy.service`: `sudo git pull && sudo bash panel/packaging/install-ubuntu.sh --install-csp --yes` |
| `Cannot reach CSP at …:8082` en el login | el proxy no está levantado: `systemctl status cardservproxy`. Mientras tanto, `--backend ncam --url http://127.0.0.1:8888 --yes` te devuelve el panel |
| No abre desde otro PC | el panel está en `HOST=127.0.0.1`; reinstala con `--listen 0.0.0.0` o usa nginx (`--domain`) |
| `502 Bad Gateway` en nginx | el servicio no está arrancado o `PORT`/`HOST` de `panel.env` no coinciden con el `proxy_pass` del vhost |
| Certificado autofirmado del softcam | `INSECURE_TLS=1` en `panel.env` (ya viene activado) |
| Panel en subdirectorio | reinstala con `--base-path /csp/`; el bundle se recompila con esa ruta base |

Desinstalar:

```bash
sudo bash panel/packaging/install-ubuntu.sh --uninstall   # conserva /etc/csp-panel
sudo bash panel/packaging/install-ubuntu.sh --purge       # lo borra todo
```
