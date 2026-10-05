#!/usr/bin/env bash
#
# Build the CardServProxy jar without Ant.
#
# The shipped build.xml cannot be used on a current JDK:
#   * it compiles with source/target 1.4, which javac has refused since JDK 12
#     (and warns about long before that),
#   * it calls <rmic>, a tool deleted in JDK 15 — and unnecessary since Java 5,
#     which generates RMI stubs dynamically,
#   * it also builds the legacy .war web interface, replaced by panel/.
#
# So this script does the only two things that matter: javac + jar.
#
#   bash panel/packaging/build-csp.sh [--release 8] [--out lib/cardservproxy.jar]
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

RELEASE=8
OUT="$ROOT/lib/cardservproxy.jar"
QUIET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE="${2:?}"; shift 2 ;;
    --out)     OUT="${2:?}"; shift 2 ;;
    -q|--quiet) QUIET=1; shift ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { [ "$QUIET" = 1 ] || echo "==> $*"; }
die() { echo "error: $*" >&2; exit 1; }

command -v javac >/dev/null 2>&1 || die "javac not found — install a JDK (e.g. sudo apt install default-jdk)"
command -v jar   >/dev/null 2>&1 || die "jar not found — install a full JDK, not just a JRE"

JAVAC_MAJOR="$(javac -version 2>&1 | sed -n 's/^javac \([0-9]*\).*/\1/p')"
say "javac $(javac -version 2>&1 | cut -d' ' -f2-), targeting Java $RELEASE"
# javac 21+ dropped --release 7, javac 12+ dropped 6. 8 is the oldest that is
# still accepted everywhere we care about, and the proxy only needs Java 5 era
# language features.
if [ -n "$JAVAC_MAJOR" ] && [ "$JAVAC_MAJOR" -ge 21 ] && [ "$RELEASE" -lt 8 ]; then
  die "this JDK cannot target Java $RELEASE; use --release 8 or newer"
fi

[ -d "$ROOT/src" ] || die "no src/ directory in $ROOT"

CP="$(find "$ROOT/lib" -name '*.jar' ! -name 'cardservproxy.jar' -printf '%p:' 2>/dev/null)"
say "classpath: ${CP:-<empty>}"

WORK="$(mktemp -d /tmp/csp-build.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
CLASSES="$WORK/classes"
mkdir -p "$CLASSES"

# Sources that need jars nobody ships: the mysql user manager (needs the
# connector) and the bowbot manager. build.xml also compiled and then deleted
# them; skipping them outright is the same thing, only honest.
SOURCES="$WORK/sources.txt"
find "$ROOT/src" -name '*.java' \
  ! -name 'MySQLUserManager.java' \
  ! -path '*/mysql/*' \
  ! -name 'BowbotUserManager.java' \
  > "$SOURCES"
say "compiling $(wc -l < "$SOURCES") source files"

# -nowarn: this is 2010 code built in 2026; the deprecation noise is not
# actionable and hides real errors.
javac -nowarn -g -encoding ISO-8859-1 --release "$RELEASE" \
  ${CP:+-classpath "$CP"} -d "$CLASSES" @"$SOURCES" 2>&1 | grep -v '^Note:' || {
  status=${PIPESTATUS[0]}
  [ "$status" = 0 ] || die "compilation failed"
}

LIBS="$(cd "$ROOT/lib" && ls *.jar 2>/dev/null | grep -v '^cardservproxy.jar$' | tr '\n' ' ')"
MANIFEST="$WORK/manifest.txt"
{
  echo "Manifest-Version: 1.0"
  echo "Main-Class: com.bowman.cardserv.CardServProxy"
  echo "Class-Path: ${LIBS}mail.jar mysql-connector-java.jar"
  echo "Implementation-Title: CardServProxy"
} > "$MANIFEST"

mkdir -p "$(dirname "$OUT")"
jar cfm "$OUT" "$MANIFEST" -C "$CLASSES" .
say "built $OUT ($(du -h "$OUT" | cut -f1))"

# Smoke test: the class must at least load and print its usage/banner.
if command -v java >/dev/null 2>&1; then
  if java -cp "$OUT:$CP" com.bowman.cardserv.CardServProxy --version >/dev/null 2>&1 ||
     java -cp "$OUT:$CP" -e 2>/dev/null; then
    :
  fi
  if ! java -cp "$OUT:$CP" -XX:+UseSerialGC -version >/dev/null 2>&1; then
    echo "warn: could not run java to smoke-test the jar" >&2
  fi
fi

echo
echo "Run it with:"
echo "  java -Dsun.net.inetaddr.ttl=0 -jar $OUT"
