package com.byemobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.security.KeyStore
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Android Keystore-backed secure store for the mobile device session (spec §10, X01). Same JS
 * interface and error kinds as the desktop/iOS `ByeSecureStore`:
 * - values are sealed with a non-exportable AES-256-GCM key that lives in the Android Keystore
 *   (hardware-backed where available); only ciphertext reaches app-private preferences;
 * - preferences are excluded from backup (`android:allowBackup="false"`);
 * - typed failures (missing, unavailable, denied, corrupt); there is no plaintext fallback.
 */
class ByeSecureStoreModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "ByeSecureStore"

  private val prefs by lazy { reactApplicationContext.getSharedPreferences("bye_secure_store", Context.MODE_PRIVATE) }

  private fun key(): SecretKey {
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

  private fun fail(promise: Promise, error: Throwable) {
    val kind = when (error) {
      is AEADBadTagException, is IllegalArgumentException -> "CorruptCredential"
      is UserNotAuthenticatedException, is SecurityException -> "StorageDenied"
      else -> "StorageUnavailable"
    }
    // Codes only; never the secret.
    promise.reject(kind, "keystore $kind (${error.javaClass.simpleName})")
  }

  @ReactMethod
  fun read(key: String, promise: Promise) {
    val sealed = prefs.getString(key, null) ?: return promise.reject("MissingCredential", "no stored credential")
    try {
      val bytes = Base64.decode(sealed, Base64.NO_WRAP)
      if (bytes.size <= IV_BYTES) return promise.reject("CorruptCredential", "stored credential truncated")
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
      cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
      promise.resolve(String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8))
    } catch (error: Throwable) {
      fail(promise, error)
    }
  }

  @ReactMethod
  fun write(key: String, value: String, promise: Promise) {
    try {
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.ENCRYPT_MODE, key())
      // The entry name is bound as associated data, so a ciphertext can't be moved between keys.
      cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
      val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
      // commit(), not apply(): report failure instead of losing the rotated credential silently.
      if (prefs.edit().putString(key, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()) promise.resolve(null)
      else promise.reject("StorageUnavailable", "could not persist credential")
    } catch (error: Throwable) {
      fail(promise, error)
    }
  }

  @ReactMethod
  fun remove(key: String, promise: Promise) {
    if (prefs.edit().remove(key).commit()) promise.resolve(null) else promise.reject("StorageUnavailable", "could not remove credential")
  }

  private companion object {
    const val KEY_ALIAS = "email.bye.mobile.session"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val IV_BYTES = 12
  }
}
