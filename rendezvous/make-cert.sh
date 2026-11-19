#!/bin/sh
# Makes the service's self-signed certificate (10 years). The apps pin cert.pem,
# so after making a new one, copy cert.pem to:
#   host/assets/service-cert.pem
#   tv/app/src/main/res/raw/service_cert.pem
# and rebuild both apps. Keep key.pem private: never commit it.
# Usage: sh make-cert.sh [output-dir]
set -e
out="${1:-.}"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
  -subj "/CN=EsteefCast Service/O=Esteef.Ai" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,digitalSignature,keyCertSign" \
  -keyout "$out/key.pem" -out "$out/cert.pem"
echo "wrote $out/cert.pem and $out/key.pem"
