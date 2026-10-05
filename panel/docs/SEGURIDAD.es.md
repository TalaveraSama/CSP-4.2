# Exponer el panel a internet

Repaso de seguridad del panel pensado para el caso real: **resellers entrando
desde cualquier parte**. Primero lo que hace el panel por ti, después lo que
tienes que hacer tú, y al final lo que conscientemente **no** está resuelto.

---

## 1. Lo que ya hace el panel

### Autenticación

- El administrador se valida contra el softcam (NCam/OSCam/CSP); sus
  credenciales no se guardan en el panel.
- Los resellers son usuarios del panel, con contraseña **scrypt** (sal de 16
  bytes, comparación en tiempo constante). El fichero nunca contiene la
  contraseña en claro.
- Sesión en **cookie opaca `httpOnly`, `SameSite=Strict`**, y `Secure` cuando
  detecta HTTPS. El navegador jamás ve credenciales.
- **Límite de intentos**: 8 fallos bloquean 15 minutos, contando *por IP y
  por nombre de usuario a la vez*. Bloquear solo por IP permitiría rociar una
  contraseña desde una botnet; bloquear solo por usuario permitiría dejar
  fuera a un reseller a propósito. Se ajusta con `LOGIN_MAX_FAILURES` y
  `LOGIN_BLOCK_MINUTES`.
- Respuesta genérica (`invalid credentials`) para no revelar qué usuarios
  existen.

### Autorización

- Un reseller solo alcanza `/api/accounts`, `/api/sessions`, `/api/expiring`,
  `/api/auth` y `/api/meta`. **Cualquier otra ruta responde 403**, no solo se
  oculta en la interfaz.
- Sus listados están filtrados por propietario; pedir un cliente ajeno
  devuelve **404, no 403**, para no confirmar que existe.
- En *Sessions* se le quitan las estadísticas del proxy, los conectores y los
  fallos de login: solo ve a sus clientes conectados.
- **Los grupos/perfiles se le imponen**: si le asignas `group = 1`, todas las
  cuentas que cree o edite llevan ese grupo, mande lo que mande la petición.
  Sin eso podría dar acceso a lectores que no paga.

### Validación de entrada

- Nombres de cuenta: `[A-Za-z0-9._@-]`, con longitud máxima.
- **Todo valor que acaba en un fichero de configuración se revisa**: se
  rechaza cualquier carácter de control o salto de línea, y hay longitudes
  máximas por campo.
  Esto cierra una escalada real: `ncam.user` es un fichero de líneas, así que
  una contraseña como `x\ngroup = 1,2,3,4\nmonlevel = 4` escribía claves
  arbitrarias en la cuenta — lectores ajenos y acceso de monitor al softcam.
- En XML se escapan `& < > "`; una contraseña `" admin="true` no convierte a
  nadie en administrador.
- Créditos y meses: enteros con rango (1–60 meses), y el cobro ocurre antes
  de crear; si falla la escritura, se devuelve.

### Cabeceras y CSRF

- `Content-Security-Policy` estricta (`default-src 'self'`,
  `frame-ancestors 'none'`, `object-src 'none'`, sin orígenes externos),
  `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy:
  no-referrer`, `Permissions-Policy` y `Strict-Transport-Security` cuando hay
  HTTPS.
- Toda petición que modifica algo **debe llevar cuerpo JSON**: un formulario
  en una web ajena no puede enviarlo, y con `SameSite=Strict` la cookie ni
  siquiera viaja.
- Límites de cuerpo: 2 MB en JSON, 8 MB en los ficheros de configuración.

### Datos en reposo

- `/etc/csp-panel/panel.env` → `root:csp-panel`, `640`.
- `/var/lib/csp-panel/resellers.json` → `csp-panel:csp-panel`, `640`,
  escritura atómica (fichero temporal + rename).
- El panel corre como usuario de sistema sin shell, con `NoNewPrivileges`,
  `PrivateTmp` y `ProtectSystem` en su unidad systemd.

---

## 2. Lo que tienes que hacer tú

### HTTPS, obligatorio

Sin TLS las contraseñas de tus resellers viajan en claro. No publiques el
8090 directamente:

```bash
sudo bash panel/packaging/install-ubuntu.sh --domain panel.tudominio.com --yes
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d panel.tudominio.com
```

Y en `/etc/csp-panel/panel.env`:

```ini
HOST=127.0.0.1          # que solo escuche nginx
SECURE_COOKIES=always
TRUST_PROXY=loopback    # para que el límite de intentos vea la IP real
```

> ⚠️ **`SECURE_COOKIES=always` solo si entras por https.** Con esa opción la
> cookie de sesión lleva el flag `Secure`, y un navegador que entra por
> `http://192.168.1.x:8090` **la tira sin decir nada**: el login responde
> correctamente y vuelves a la pantalla de login, una y otra vez. Si quieres
> seguir entrando por IP y sin TLS desde la red local, deja
> `SECURE_COOKIES=auto`, que pone el flag solo cuando la conexión es segura.
> Desde la versión actual el panel lo detecta y te lo dice en vez de dejarte
> en bucle, y `--status` también avisa.

### Cortafuegos

Fuera todo lo que no sea el panel y los puertos de tus clientes:

```bash
sudo ufw allow 443/tcp          # panel por nginx
sudo ufw allow 10000/tcp        # newcamd de tus clientes
sudo ufw allow 12000/tcp        # cccam de tus clientes
sudo ufw deny 8090/tcp          # el panel directo, no
sudo ufw enable
```

**Nunca** expongas a internet: `8888` (webif de NCam), `8082` (status-web del
proxy), `8099` (stats de la cache) ni los puertos UDP de cache. Deben quedar
en loopback (`serverip = 127.0.0.1` en `ncam.conf`, `bind-ip` en el proxy).

### Contraseñas

- Cambia la del administrador: `--reset-password` genera una aleatoria.
- Da a cada reseller una contraseña larga; el panel exige 4 caracteres como
  mínimo, que es poco para internet.
- Rota la del webif de NCam si alguna vez la pegaste en un chat o un foro.

### Mantenimiento

```bash
sudo bash panel/packaging/install-ubuntu.sh --status   # servicios, puertos, backend
sudo journalctl -u csp-panel -f                        # intentos fallidos, 429, errores
sudo apt update && sudo apt upgrade                    # nginx, node, openssl
```

Haz copia de `/var/lib/csp-panel/resellers.json` (créditos y clientes) y de
`/etc/ncam/` o `/etc/cardservproxy/`.

---

## 3. Lo que no está resuelto, y por qué

Para que lo sepas antes de que te lo encuentres:

- **No hay segundo factor.** Para un panel con dinero de por medio sería lo
  siguiente que añadiría. Mitigación hoy: contraseñas largas y el límite de
  intentos.
- **Las contraseñas de los clientes se guardan en claro** en `ncam.user` o
  `users.xml`, porque es como las leen NCam y CSP: el protocolo newcamd las
  necesita para derivar su clave. No es decisión del panel. Protege los
  ficheros y el acceso al servidor.
- **No hay registro de auditoría por administrador.** El movimiento de
  créditos sí queda registrado (quién, cuánto, cuándo y por qué), pero las
  ediciones de configuración no.
- **La sesión no se invalida al cambiar la contraseña** de un reseller: su
  sesión abierta sigue viva hasta que caduca (8 h, `SESSION_TTL_MS`). Si
  necesitas echarlo ya: deshabilítalo y reinicia el panel.
- **El límite de intentos vive en memoria**: reiniciar el panel lo borra. Para
  un servidor es razonable; en un cluster haría falta algo compartido.
- **No hay protección contra un reseller que agota recursos** creando y
  borrando cuentas en bucle. Los créditos limitan el alta, no el ritmo.

---

## 4. Comprobación rápida

```bash
# ¿qué está publicado de verdad?
sudo ss -lntp | grep -vE '127\.0\.0\.1|::1'

# ¿responde el panel solo por https?
curl -sI https://panel.tudominio.com | head -3
curl -sI http://TU-IP-PUBLICA:8090/ --max-time 5    # debería fallar

# ¿están las cabeceras?
curl -sI https://panel.tudominio.com | grep -iE 'content-security|x-frame|strict-transport'

# ¿aguanta el bloqueo?
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{http_code} " -X POST -H 'content-type: application/json' \
    -d '{"user":"juan","password":"mala"}' https://panel.tudominio.com/api/auth/login
done; echo    # debe acabar en 429
```
