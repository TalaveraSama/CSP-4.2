# Manual de CSP Panel

Panel web para **CardServProxy** (CSP), **OSCam** y **NCam**, con instalador
para Ubuntu que puede montar la pila entera.

- Instalación paso a paso: [`../packaging/INSTALL.es.md`](../packaging/INSTALL.es.md)
- Notas de desarrollo: [`../README.md`](../README.md)

---

## 1. Qué es (y qué no)

El panel es **una interfaz web más un traductor**. No descifra nada, no atiende
clientes y no toca la señal: lee el XML que el softcam ya publica, lo convierte
en JSON y lo pinta. Si paras el panel, todo lo demás sigue funcionando.

```
   clientes ──newcamd:10001──▶  CSP  ──newcamd:10000──▶  NCam ──▶ lectores
                                 │                        │        (tarjeta,
                                 │  cache CSP (udp)       │         cccam,
                                 └── 54278 ◀──▶ 54279 ────┘         newcamd)
                                          ▲
                                          │ 54280
                                   csp-cache-node
                                          ▲
                                          │ :8099 (stats)
    tú ──http:8090──▶  PANEL  ──http:8082──▶ CSP status-web
                          └────http:8888──▶ NCam webif   (según BACKEND)
```

El panel habla **con un backend a la vez**, el que diga `BACKEND` en
`/etc/csp-panel/panel.env`.

### Puertos

| Puerto | Proceso | Para qué |
| --- | --- | --- |
| 8090/tcp | csp-panel | la web, tú |
| 8082/tcp | cardservproxy | status-web del proxy (loopback) |
| 10001/tcp | cardservproxy | newcamd: **aquí entran tus clientes** |
| 8888/tcp | ncam | webif de NCam (loopback) |
| 10000/tcp | ncam | newcamd: por aquí entra el proxy |
| 54278/udp | cardservproxy | ClusteredCache |
| 54279/udp | ncam | `csp_port` |
| 54280/udp | csp-cache-node | nuestro peer de cache |
| 8099/tcp | csp-cache-node | estadísticas que lee el panel (loopback) |

---

## 2. Instalación

```bash
# la pila completa: panel + NCam + proxy + cache  (el panel gestiona el proxy)
curl -fsSL https://raw.githubusercontent.com/TalaveraSama/CSP-4.2/arena/01a0f2ba-csp-4-2/install.sh | sudo bash

# solo NCam (sin proxy): el panel gestiona NCam
sudo bash install.sh --only-ncam --yes

# solo el panel, contra un softcam que ya tienes
sudo bash install.sh --backend ncam --url http://192.168.1.50:8888 --yes
```

Para que se vea desde otro PC añade `--listen 0.0.0.0` (y `ufw allow 8090/tcp`
si tienes cortafuegos). Lo recomendable en producción es publicarlo con nginx:
`--domain panel.tudominio.com` y luego `certbot --nginx -d panel.tudominio.com`.

---

## 3. Primer acceso

El panel **no tiene usuarios propios**: reenvía el login al backend.

```bash
sudo bash panel/packaging/install-ubuntu.sh --credentials
```

| Backend | Usuario y contraseña |
| --- | --- |
| `csp` | la cuenta `admin="true"` de `/etc/cardservproxy/proxy.xml` |
| `ncam` / `oscam` | `httpuser` / `httppwd` de `[webif]` en `ncam.conf` |
| `mock` | cualquier cosa; `admin` entra como administrador |

Cambiarla:

```bash
sudo bash panel/packaging/install-ubuntu.sh --reset-password            # aleatoria
sudo bash panel/packaging/install-ubuntu.sh --reset-password MiClave
```

---

## 4. La interfaz

La cabecera dice siempre **qué estás gestionando** (`CardServProxy` o
`NCam Unofficial`), con un selector de perfil y el intervalo de refresco.

| Pestaña | Con CSP | Con OSCam/NCam |
| --- | --- | --- |
| **Overview** | uptime, ECM/s, aciertos de cache, denegados, fallos, perfiles CA | lo mismo, con CAIDs en vez de perfiles |
| **Connectors** / **Readers** | conectores del proxy (NCam, peers): estado, latencia, canales que descifran | lectores: tarjeta, cccam, newcamd; relectura, habilitar/deshabilitar |
| **Sessions** | clientes conectados: IP, canal, ECM/s, tiempo de respuesta; echar a un usuario | igual, clientes de NCam |
| **Accounts** | alta/edición/baja de clientes | lo mismo, sobre `ncam.user` |
| **Channels** | servicios vistos y por qué conector se descifran | igual |
| **Events** | eventos del proxy (conector caído, cache resincronizada…) | log de eventos |
| **Logs** | log en vivo | log en vivo del softcam |
| **Config** | editor de `proxy.xml` | editor de `ncam.conf`, `ncam.user`, `ncam.server`, … |
| **Admin** | comandos de control (reset de estadísticas, OSD, reiniciar, parar) | comandos de NCam |
| **Cache** | peers del cluster, latencias, entradas vivas | igual (es independiente del backend) |

Las pestañas *Accounts*, *Config* y *Admin* solo las ven las cuentas con
permisos de administrador.

---

## 5. Cuentas de clientes

La pestaña **Accounts** escribe en sitios distintos según el montaje:

| Backend | Fichero | Cómo se aplica |
| --- | --- | --- |
| CSP con `XmlUserManager` **(recomendado)** | `/etc/cardservproxy/users.xml` | el panel escribe el fichero y lanza `update-users`: **sin recargar el proxy** |
| CSP con `SimpleUserManager` | `<user>` dentro de `proxy.xml` | se reenvía por `/cfgHandler`; el proxy recarga su configuración entera |
| OSCam / NCam | `ncam.user` | se guarda por el webif y el softcam relee las cuentas al instante |

El editor **conserva** lo que el panel no modela (`caid`, `ident`, `services`,
`cacheex`, `betatunnel`, comentarios y formato). Nunca regenera el fichero.

### Miles de usuarios

Con las cuentas dentro de `proxy.xml`, **cada alta recarga el proxy entero**.
A partir de unos cientos de clientes eso no es sostenible:

```bash
sudo bash panel/packaging/install-ubuntu.sh --migrate-users
```

Mueve los clientes a `users.xml`, deja los admin en `proxy.xml` (el login del
panel no debe depender de un fichero que el panel reescribe) y hace copia de
seguridad. Las instalaciones nuevas ya salen así.

### Desde la línea de comandos

```bash
sudo bash panel/packaging/install-ubuntu.sh --add-user cliente1           # clave aleatoria
sudo bash panel/packaging/install-ubuntu.sh --add-user cliente1 suclave
```

### Reparto correcto con proxy

En **CSP** van todos tus clientes. En **NCam** solo hace falta **una** cuenta:
`csp`, la que usa el proxy. Crear los clientes también en NCam deja dos listas
que mantener y, si el 10000 es accesible desde fuera, permite saltarse el proxy.

---

## 5b. NCam sirviendo a los clientes (sin proxy)

CSP es opcional. NCam ya es un cardserver completo: atiende clientes por
newcamd y CCcam, tiene las cuentas, los lectores y la cache. Para miles de
usuarios es lo que usa todo el mundo, y son menos piezas que mantener.

```bash
sudo bash panel/packaging/install-ubuntu.sh --serve-clients --caid 1802
sudo bash panel/packaging/install-ubuntu.sh --remove-csp      # si tenías el proxy
```

`--serve-clients` escribe en `ncam.conf`:

- `[newcamd] port = 10000@CAID:000000` con su `key`,
- `[cccam] port = 12000` con `reshare` y `version`,

y reinicia NCam. Opciones: `--newcamd-port`, `--cccam-port`, `--deskey`,
`--caid`. Las líneas que das a tus clientes quedan:

```
N: TU-IP 10000 usuario clave 01 02 03 04 05 06 07 08 09 10 11 12 13 14
C: TU-IP 12000 usuario clave
```

Las cuentas se crean en la pestaña **Accounts** del panel (o con
`--add-user`), y el `group` de cada cuenta debe coincidir con el de los
lectores. `--remove-csp` para el proxy, lo deshabilita y **devuelve el panel a
NCam** para que no te quedes sin acceso; su configuración se conserva por si
lo quieres de vuelta.

## 5c. Resellers

El panel puede tener **sus propios usuarios** además de los del softcam: los
resellers. Cada uno entra con su contraseña, ve **solo sus clientes** y vende
contra un saldo de créditos.

**1 crédito = 1 mes de una línea.** Dar de alta a un cliente por 3 meses
cuesta 3 créditos; renovarlo 1 mes, 1 crédito. Borrar **no devuelve** créditos
(si no, se reciclarían borrando y creando).

```bash
sudo bash panel/packaging/install-ubuntu.sh --add-reseller juan miclave 50
```

Eso crea el reseller con 50 créditos y, si hace falta, rellena
`BACKEND_USER`/`BACKEND_PASS` en `panel.env` (las credenciales del softcam que
el panel usa en nombre de los resellers, que no tienen cuenta en él).

| | Administrador | Reseller |
| --- | --- | --- |
| Pestañas | todas | *Accounts* y *Sessions* |
| Cuentas que ve | todas | solo las suyas |
| Crear, renovar, editar, borrar | sí, gratis | sí, descontando créditos |
| Créditos, resellers, config, cache | sí | no |

Desde la pestaña **Resellers** (solo admin) creas resellers, les recargas
créditos, les cambias la contraseña, los habilitas o deshabilitas y ves el
**historial de movimientos**. Si borras un reseller, sus clientes **no se
cortan**: pasan a ser tuyos.

La caducidad la lleva el panel en `/etc/csp-panel/resellers.json`, así que
funciona igual aunque el backend no tenga campo de expiración; en NCam además
se escribe `expdate` en la cuenta.

## 6. Lectores (las tarjetas y las líneas)

Siempre en NCam: el proxy no habla con tarjetas ni con servidores remotos.

```bash
sudo bash panel/packaging/install-ubuntu.sh --add-reader "cccam://usuario:clave@servidor.com:12000"
sudo bash panel/packaging/install-ubuntu.sh --add-reader "newcamd://usuario:clave@10.8.0.5:10000?key=0102030405060708091011121314"
```

Opciones: `--reader-label NOMBRE`, `--reader-group N` (el grupo debe coincidir
con el de la cuenta `csp` en `ncam.user`). Una tarjeta local se configura en
*Config* → `ncam.server` con `protocol = smartreader|internal|…` y
`device = /dev/ttyUSB0`.

---

## 7. Cache cluster

`csp-cache-node` es un peer de pleno derecho del cluster de cache: habla el
protocolo UDP de CSP (el mismo del `ClusteredCache` y del `csp_port` de NCam),
guarda los ecm→cw que circulan, responde a los *resend* y mide latencias.

Va en un servicio aparte **a propósito**: la cache guarda estado y debe estar
siempre arriba, mientras que reiniciar el panel no debe costar nada.

```bash
sudoedit /etc/csp-panel/cache.env     # CACHE_PORT, CACHE_PEERS, CACHE_MAX_AGE
sudo systemctl restart csp-cache-node
curl http://127.0.0.1:8099/stats      # lo mismo que ve la pestaña Cache
```

Unirse a un cluster externo sin instalar nada más:

```bash
sudo bash panel/packaging/install-ubuntu.sh --cache-peers 10.8.0.2:54278,127.0.0.1:54279 --yes
```

---

## 8. Comandos del instalador

`sudo bash panel/packaging/install-ubuntu.sh [opciones]`

### Qué instalar

| Opción | Qué hace |
| --- | --- |
| `--all` | panel + NCam + proxy + cache, cableados; el panel gestiona el proxy |
| `--only-ncam` | panel + NCam, sin proxy; el panel gestiona NCam |
| `--install-ncam` | compila e instala NCam (de `vendor/ncam`) |
| `--install-csp` | compila e instala el proxy java y lo cablea a NCam |
| `--deb FILE` | instala un `.deb` ya construido en vez de compilar |

### Qué gestiona el panel

| Opción | Por defecto |
| --- | --- |
| `--backend oscam\|ncam\|csp\|mock` | lo que ya hubiera en `panel.env` |
| `--url URL` | `http://127.0.0.1:8888` (softcam) o `:8082` (proxy) |
| `--port N` | 8090 |
| `--listen ADDR` | 127.0.0.1 (`0.0.0.0` para verlo desde la LAN) |
| `--domain HOST` | — (configura un vhost de nginx) |
| `--base-path /csp/` | — (servirlo en un subdirectorio) |
| `--no-nginx` | — |

### Softcam y proxy

| Opción | Por defecto |
| --- | --- |
| `--ncam-port / --ncam-user / --ncam-pass` | 8888 / admin / aleatoria |
| `--csp-port / --csp-user / --csp-pass` | 8082 / admin / aleatoria |
| `--csp-client-port N` | 10001 (donde entran tus clientes) |
| `--csp-caid HEX` | 0x0B00 (**pon el de tu proveedor**) |
| `--cache-peers LIST`, `--cache-port N` | — / 54280 |

### Operación del día a día

| Comando | Qué hace |
| --- | --- |
| `--serve-clients` | abre los puertos newcamd/cccam de NCam para tus clientes |
| `--remove-csp` | para y deshabilita el proxy java, y devuelve el panel a NCam |
| `--status` | revisa toda la pila y dice qué está roto, con las últimas líneas de su log |
| `--credentials` | enseña qué cuentas existen y en qué fichero |
| `--reset-password [CLAVE]` | nueva contraseña para entrar al panel |
| `--add-user NOMBRE [CLAVE]` | alta de cliente |
| `--add-reader URL` | añade una línea cccam/newcamd a `ncam.server` |
| `--add-reseller NOMBRE [CLAVE] [CRÉDITOS]` | crea un reseller con su saldo |
| `--migrate-users` | saca las cuentas de `proxy.xml` a `users.xml` |
| `--uninstall` / `--purge` | quita el paquete (conservando o no la configuración) |

### Node.js y red

| Opción | Para qué |
| --- | --- |
| `--node-major N` | línea de Node a instalar si falta (22) |
| `--node-from auto\|nodesource\|tarball\|skip` | de dónde sacar Node; `tarball` usa `NODE_MIRROR` |
| `NODE_MIRROR=…`, `NET_TIMEOUT`, `NET_MAXTIME` | mirrors y tiempos de espera |
| `-y, --yes` | no preguntar nada |
| `--force` | ejecutar en una distribución que no sea Ubuntu 20/22/24 |

---

### Diagnóstico rápido

```bash
sudo bash panel/packaging/install-ubuntu.sh --status
```

Enseña el estado de los cuatro servicios (con el final de su log si alguno
falla), qué puertos escuchan, si el panel responde, si el backend configurado
es alcanzable, y avisa si la unidad de systemd del proxy está desactualizada.

## 9. Servicios y ficheros

| Servicio | Qué es |
| --- | --- |
| `csp-panel` | el panel |
| `csp-cache-node` | peer de cache |
| `ncam` | el softcam |
| `cardservproxy` | el proxy java |

```bash
systemctl status csp-panel ncam cardservproxy csp-cache-node --no-pager
journalctl -u csp-panel -f
journalctl -u ncam -f
sudo tail -f /opt/cardservproxy/log/cardservproxy.log
```

| Fichero | Contenido |
| --- | --- |
| `/etc/csp-panel/panel.env` | configuración del panel |
| `/etc/csp-panel/cache.env` | configuración del peer de cache |
| `/etc/csp-panel/resellers.json` | resellers, créditos, dueño y caducidad de cada cliente |
| `/etc/ncam/ncam.conf` | NCam: webif, cache, puertos |
| `/etc/ncam/ncam.user` | cuentas de NCam (con proxy, solo `csp`) |
| `/etc/ncam/ncam.server` | lectores: tarjeta, cccam, newcamd |
| `/etc/cardservproxy/proxy.xml` | perfiles, conectores, cache, admin |
| `/etc/cardservproxy/users.xml` | clientes del proxy |
| `/opt/cardservproxy/` | jar, logs y cache del proxy |

### `panel.env`

| Variable | Qué hace |
| --- | --- |
| `PORT`, `HOST` | dónde escucha el panel |
| `BACKEND` | `csp`, `ncam`, `oscam` |
| `OSCAM_URL` / `NCAM_URL` / `CSP_URL` | a quién se conecta |
| `MOCK=1` | datos de demostración, sin softcam |
| `CACHE_NODE_URL` | de dónde leer las estadísticas de cache |
| `SECURE_COOKIES`, `TRUST_PROXY` | detrás de nginx/TLS |
| `INSECURE_TLS=1` | aceptar certificados autofirmados del softcam |
| `SESSION_TTL_MS` | duración de la sesión (8 h) |
| `NODE_BIN` | forzar un intérprete de Node concreto |

### `cache.env`

`CACHE_PORT`, `CACHE_PEERS`, `CACHE_BIND`, `CACHE_HTTP_HOST`,
`CACHE_HTTP_PORT`, `CACHE_MAX_AGE`, `CACHE_MAX_ENTRIES`,
`CACHE_PING_INTERVAL`, `CACHE_AUTO_ADD_PEERS`.

---

## 10. API REST (para automatizar)

Todo lo que hace la web está en `/api`, con sesión por cookie.

```bash
# login y cookie
curl -s -c /tmp/cs -X POST -H 'content-type: application/json' \
  -d '{"user":"admin","password":"TUCLAVE"}' http://127.0.0.1:8090/api/auth/login

# alta de cliente
curl -s -b /tmp/cs -X POST -H 'content-type: application/json' \
  -d '{"name":"cliente42","password":"clave42","profiles":"ncam","maxConnections":2}' \
  http://127.0.0.1:8090/api/accounts
```

| Método | Ruta | Para qué |
| --- | --- | --- |
| GET | `/api/meta` | backend, versión, capacidades |
| POST | `/api/auth/login` · `/api/auth/logout` · GET `/api/auth/me` | sesión |
| GET | `/api/overview` | tarjetas del Overview |
| GET | `/api/connectors` | conectores / lectores |
| GET | `/api/sessions` | clientes conectados |
| GET | `/api/channels` · `/api/events` · `/api/seen` · `/api/failures` | canales, eventos, último visto, fallos de login |
| GET | `/api/commands` | comandos de control disponibles |
| POST | `/api/commands/:name` | ejecutar uno (admin) |
| GET/PUT | `/api/config?file=…` | leer y guardar ficheros de configuración (admin) |
| GET/POST | `/api/accounts` | listar y crear cuentas (admin) |
| PUT/DELETE | `/api/accounts/:name` | editar y borrar (admin) |
| GET/POST | `/api/resellers` | listar y crear resellers (admin) |
| PUT/DELETE | `/api/resellers/:id` | recargar créditos, cambiar clave, habilitar, borrar |
| GET | `/api/cache` | estado del cluster de cache |
| GET | `/healthz` | sin sesión: `{"ok":true,…}` para monitorización |

En `PUT /api/accounts/:name`, una contraseña vacía significa «déjala como
está».

---

## 11. Desarrollo

```bash
cd panel
npm install
npm run dev                 # web + api con recarga
BACKEND=ncam MOCK=1 npm run dev
npm test                    # 48 pruebas
npm run typecheck
npm run build
npm run deb                 # construye el .deb
```

El modo `MOCK=1` levanta datos sintéticos de los tres backends: sirve para
mirar la interfaz sin tener nada instalado.

---

## 12. Problemas que ya nos hemos encontrado

| Síntoma | Causa y solución |
| --- | --- |
| El panel «no abre» desde otro PC | escucha en `127.0.0.1`: reinstala con `--listen 0.0.0.0` (+ `ufw allow 8090/tcp`) o publícalo con `--domain` |
| `Cannot reach CSP at …:8082` en el login | el proxy no está levantado; mientras tanto `--backend ncam --url http://127.0.0.1:8888 --yes` |
| `Startup failed: Unsupported java vm 'OpenJDK…'` | CSP solo aceptaba la JVM de Sun; hay que arrancarlo con `-Dcom.bowman.cardserv.allowanyjvm=true` (ya va en la unidad) |
| El proxy sale con `status=1` y no escribe log | no encuentra la configuración: `ProxyConfig.DEFAULT_CONFIG` es `config/proxy.xml` relativo al directorio de trabajo; la unidad le pasa la ruta |
| Guardar configuración daba *timeout* | el webif de OSCam/NCam busca literalmente `"Content-Length: "`; `fetch` la envía en minúsculas. Corregido en el panel |
| Todos los ficheros salían como solo lectura | el webif rellena el flag `writable` antes de calcularlo. El panel usa `httpreadonly` |
| El panel aparecía vacío con un softcam recién instalado | `userstats` responde `Invalid client` mientras no hay cuentas; ya no tumba el resto |
| `curl: (28)` contra `deb.nodesource.com` | red bloqueada: `--node-from tarball`, `NODE_MIRROR=…`, o `--node-from skip` |
| `Config file version '1.0' does not match application version '0.9.0'` | el atributo `ver` de `<cardserv-proxy>` tiene que ser exactamente `0.9.0`: `sudo sed -i 's/ver="1.0"/ver="0.9.0"/' /etc/cardservproxy/proxy.xml` |
| Servicio `active` pero sin puertos | arranque a medias; `--status` enseña el final de su log |
| Cuenta creada que el proxy ignora | tiene que estar dentro de `<auth-config>`; el panel y `--add-user` ya lo hacen |

---

## 13. Seguridad

- Mantén los webif en loopback (`serverip = 127.0.0.1` en NCam, `bind-ip` en
  el proxy) y expón **solo** el panel.
- `httpallowed = 127.0.0.1,::1` en NCam. Un rango como `0.0.0.0-255.255.255.0`
  deja entrar a cualquiera.
- Publica el panel con nginx + TLS si va a salir a internet; sin https las
  credenciales viajan en claro.
- Las contraseñas se guardan en texto plano en `proxy.xml`, `users.xml` y
  `ncam.conf` porque así las leen esos programas: los ficheros van con permisos
  restringidos, no los copies a sitios públicos.
- `--reset-password` es la forma rápida de rotar la contraseña del panel.
