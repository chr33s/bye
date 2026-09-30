package com.byemobile

import java.io.File
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import org.json.JSONArray
import org.json.JSONObject

/**
 * The bridge contracts in packages/contracts/test/fixtures/native, shared with the TypeScript
 * (packages/native-shared/test/bridge.test.ts) and Swift (ios/ByeMobileTests) suites. The directory
 * comes from the `bye.fixtures` system property set in app/build.gradle.
 */
object Fixtures {
  fun load(name: String): JSONObject =
    JSONObject(File(System.getProperty("bye.fixtures") ?: error("bye.fixtures not set"), "$name.json").readText())

  fun cases(name: String, key: String = "cases"): List<JSONObject> {
    val array: JSONArray = load(name).getJSONArray(key)
    return (0 until array.length()).map { array.getJSONObject(it) }
  }

  /** JSON null (or absent) as Kotlin null. */
  fun JSONObject.stringOrNull(key: String): String? = if (isNull(key)) null else getString(key)

  fun JSONObject.longOrNull(key: String): Long? = if (isNull(key)) null else getLong(key)

  val rfc8291: JSONObject get() = load("webpush").getJSONObject("rfc8291")

  /** The RFC 8291 Appendix A receiver as this device's keys. */
  fun receiverKeys(): ByePushCrypto.Keys {
    val params = AlgorithmParameters.getInstance("EC")
      .apply { init(ECGenParameterSpec("secp256r1")) }
      .getParameterSpec(ECParameterSpec::class.java)
    val factory = KeyFactory.getInstance("EC")
    val point = ByePushCrypto.fromBase64url(rfc8291.getString("uaPublic"))
    val publicKey = factory.generatePublic(
      ECPublicKeySpec(ECPoint(BigInteger(1, point.copyOfRange(1, 33)), BigInteger(1, point.copyOfRange(33, 65))), params)
    ) as ECPublicKey
    val privateKey = factory.generatePrivate(
      ECPrivateKeySpec(BigInteger(1, ByePushCrypto.fromBase64url(rfc8291.getString("uaPrivate"))), params)
    ) as ECPrivateKey
    return ByePushCrypto.Keys(privateKey, publicKey, ByePushCrypto.fromBase64url(rfc8291.getString("auth")))
  }
}
