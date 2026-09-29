#!/bin/sh
# Checks ByePushCrypto.decrypt against the RFC 8291 Appendix A vector (the same vector the server's
# encryptWebPush/decryptWebPush tests use). Runs on macOS with the Swift toolchain:
#   sh apps/mobile/ios/scripts/push-crypto-vector.sh
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cat > "$work/main.swift" <<'SWIFT'
import CryptoKit
import Foundation

let uaPrivate = ByePushCrypto.fromBase64url("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")!
let auth = ByePushCrypto.fromBase64url("BTBZMqHH6r4Tts7J_aSIgg")!
let body = ByePushCrypto.fromBase64url(
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")!
let keys = ByePushCrypto.Keys(
  privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: uaPrivate), auth: auth)
guard keys.p256dh
  == "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
else { fatalError("public key mismatch") }
let plain = String(decoding: try ByePushCrypto.decrypt(body, keys: keys), as: UTF8.self)
guard plain == "When I grow up, I want to be a watermelon" else { fatalError("got \(plain)") }
print("ByePushCrypto: RFC 8291 Appendix A ok")
SWIFT
swiftc -O -o "$work/vector" "$here/ByeNotify/ByePushCrypto.swift" "$work/main.swift"
"$work/vector"
