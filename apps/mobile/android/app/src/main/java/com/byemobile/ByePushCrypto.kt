package com.byemobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * This device's Web Push keys and message decryption (RFC 8291, aes128gcm per RFC 8188), used by
 * the push module (which registers the public half) and ByeMessagingService (which decrypts).
 * Instances encrypt notifications to these keys; Bye's push gateway and Google only ever see
 * ciphertext (spec P1.7). The same steps as `decryptWebPush` in
 * packages/platform-cloudflare/src/transport/push/webpush.ts and ByePushCrypto.swift, both checked
 * against the RFC 8291 Appendix A vector.
 *
 * The P-256 private key and auth secret are sealed with a non-exportable Android Keystore AES key
 * (as ByeSecureStore does) before they reach app-private preferences, which are excluded from
 * backup.
 */
object ByePushCrypto {
  class Keys(val privateKey: ECPrivateKey, val publicKey: ECPublicKey, val auth: ByteArray) {
    /** Uncompressed P-256 point (65 bytes), base64url: the subscription's `p256dh`. */
    val p256dh: String get() = base64url(uncompressed(publicKey))
    val authSecret: String get() = base64url(auth)
  }

  private const val PREFS = "bye_push"
  private const val KEYS_ENTRY = "webpushKeys"
  private const val KEY_ALIAS = "email.bye.mobile.push"
  private const val IV_BYTES = 12

  @Synchronized
  fun loadOrCreate(context: Context): Keys {
    load(context)?.let { return it }
    val generator = KeyPairGenerator.getInstance("EC")
    generator.initialize(ECGenParameterSpec("secp256r1"))
    val pair = generator.generateKeyPair()
    val auth = ByteArray(16).also { SecureRandom().nextBytes(it) }
    // [u16 length][PKCS#8 private key][u16 length][X.509 public key][16-byte auth secret]
    val blob = lengthPrefixed(pair.private.encoded) + lengthPrefixed(pair.public.encoded) + auth
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, sealKey())
    cipher.updateAAD(KEYS_ENTRY.toByteArray(Charsets.UTF_8))
    val sealed = cipher.iv + cipher.doFinal(blob)
    check(prefs(context).edit().putString(KEYS_ENTRY, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()) {
      "could not persist push keys"
    }
    return Keys(pair.private as ECPrivateKey, pair.public as ECPublicKey, auth)
  }

  /** The stored keys, or null when none were created yet (or they can't be read). */
  @Synchronized
  fun load(context: Context): Keys? {
    val stored = prefs(context).getString(KEYS_ENTRY, null) ?: return null
    return try {
      val sealed = Base64.decode(stored, Base64.NO_WRAP)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, sealKey(), GCMParameterSpec(128, sealed, 0, IV_BYTES))
      cipher.updateAAD(KEYS_ENTRY.toByteArray(Charsets.UTF_8))
      val blob = cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
      val factory = KeyFactory.getInstance("EC")
      val privateLength = u16(blob, 0)
      val privateKey = factory.generatePrivate(PKCS8EncodedKeySpec(blob.copyOfRange(2, 2 + privateLength))) as ECPrivateKey
      val publicAt = 2 + privateLength
      val publicLength = u16(blob, publicAt)
      val publicKey = factory.generatePublic(X509EncodedKeySpec(blob.copyOfRange(publicAt + 2, publicAt + 2 + publicLength))) as ECPublicKey
      val auth = blob.copyOfRange(publicAt + 2 + publicLength, blob.size)
      require(auth.size == 16) { "corrupt push keys" }
      Keys(privateKey, publicKey, auth)
    } catch (error: Exception) {
      null
    }
  }

  /** Decrypt one aes128gcm Web Push message (a single record) with this device's keys. */
  fun decrypt(message: ByteArray, keys: Keys): ByteArray {
    require(message.size > 21) { "truncated push message" }
    val salt = message.copyOfRange(0, 16)
    val idLength = message[20].toInt() and 0xff
    require(message.size > 21 + idLength + 16) { "truncated push message" }
    val serverPublicRaw = message.copyOfRange(21, 21 + idLength)
    val ciphertext = message.copyOfRange(21 + idLength, message.size)

    val agreement = KeyAgreement.getInstance("ECDH")
    agreement.init(keys.privateKey)
    agreement.doPhase(decodePoint(serverPublicRaw, keys.publicKey), true)
    val ecdhSecret = agreement.generateSecret()

    val keyInfo = "WebPush: info\u0000".toByteArray(Charsets.US_ASCII) + uncompressed(keys.publicKey) + serverPublicRaw
    val ikm = hkdf(keys.auth, ecdhSecret, keyInfo, 32)
    val cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm\u0000".toByteArray(Charsets.US_ASCII), 16)
    val nonce = hkdf(salt, ikm, "Content-Encoding: nonce\u0000".toByteArray(Charsets.US_ASCII), 12)

    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
    val record = cipher.doFinal(ciphertext)
    // Strip padding back to the last-record delimiter (0x02).
    var end = record.size - 1
    while (end >= 0 && record[end].toInt() == 0) end--
    require(end >= 0 && record[end].toInt() == 2) { "invalid record delimiter" }
    return record.copyOfRange(0, end)
  }

  fun base64url(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

  fun fromBase64url(value: String): ByteArray = Base64.decode(value, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

  /** RFC 5869 HKDF-SHA256 with a single expand block (every output here is at most 32 bytes). */
  private fun hkdf(salt: ByteArray, ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
    val extract = Mac.getInstance("HmacSHA256")
    extract.init(SecretKeySpec(salt, "HmacSHA256"))
    val prk = extract.doFinal(ikm)
    val expand = Mac.getInstance("HmacSHA256")
    expand.init(SecretKeySpec(prk, "HmacSHA256"))
    expand.update(info)
    expand.update(1)
    return expand.doFinal().copyOf(length)
  }

  private fun uncompressed(key: ECPublicKey): ByteArray =
    byteArrayOf(4) + fixed(key.w.affineX) + fixed(key.w.affineY)

  private fun fixed(value: BigInteger): ByteArray {
    val raw = value.toByteArray()
    return when {
      raw.size == 32 -> raw
      raw.size > 32 -> raw.copyOfRange(raw.size - 32, raw.size)
      else -> ByteArray(32 - raw.size) + raw
    }
  }

  private fun decodePoint(raw: ByteArray, sameCurve: ECPublicKey): ECPublicKey {
    require(raw.size == 65 && raw[0].toInt() == 4) { "invalid server key" }
    val point = ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65)))
    return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, sameCurve.params)) as ECPublicKey
  }

  private fun lengthPrefixed(bytes: ByteArray): ByteArray =
    byteArrayOf((bytes.size shr 8).toByte(), bytes.size.toByte()) + bytes

  private fun u16(bytes: ByteArray, at: Int): Int =
    ((bytes[at].toInt() and 0xff) shl 8) or (bytes[at + 1].toInt() and 0xff)

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun sealKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }
}
