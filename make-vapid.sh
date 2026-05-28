#!/bin/bash
# Generates a VAPID key pair for Web Push, output as base64url strings.
# Requires openssl (built-in on macOS).
# Usage:  ./make-vapid.sh
set -e
TMP=$(mktemp -d); trap "rm -rf '$TMP'" EXIT

# 1) Generate a P-256 private key (PEM) and a matching public key.
openssl ecparam -name prime256v1 -genkey -noout -out "$TMP/priv.pem"
openssl ec -in "$TMP/priv.pem" -pubout -outform DER -out "$TMP/pub.der" 2>/dev/null

# 2) Convert the private key to PKCS#8 (DER) and the public key to raw bytes.
openssl pkcs8 -topk8 -nocrypt -in "$TMP/priv.pem" -outform DER -out "$TMP/priv.der"

# Strip the X.509 SPKI header to get the raw 65-byte uncompressed public key.
# (DER SPKI for prime256v1 has a 26-byte prefix before the public point.)
PUBLEN=$(wc -c < "$TMP/pub.der")
RAWLEN=$((PUBLEN - 26))
tail -c $RAWLEN "$TMP/pub.der" > "$TMP/pub.raw"

# 3) base64url encode both.
b64u() { openssl base64 -A -in "$1" | tr -d '=' | tr '/+' '_-'; }
PRIV=$(b64u "$TMP/priv.der")
PUB=$(b64u "$TMP/pub.raw")

cat <<EOM
VAPID keypair (keep these safe — the PRIVATE key is a secret):

PUBLIC  (paste into Settings → Push, and as Worker env VAPID_PUBLIC):
$PUB

PRIVATE (paste only into the Worker secret VAPID_PRIVATE; never into the
client / repo / sheet):
$PRIV

Next:
 1. Deploy push-worker.js as a Cloudflare Worker.
 2. In the Worker dashboard → Settings → Variables:
      VAPID_PUBLIC  = the public string above
      VAPID_SUBJECT = mailto:your-email@example.com
      VAPID_PRIVATE = (as encrypted secret, paste the private string)
 3. Copy the Worker's URL (ends in workers.dev) and the public key into
    Settings → Push in the app; tap "Enable push on this device".
EOM
