package com.byemobile

import com.byemobile.Fixtures.stringOrNull
import java.util.Base64
import kotlin.random.Random
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ByePushCryptoTest {
  private val v = Fixtures.rfc8291

  @Test
  fun rfc8291AppendixA() {
    val keys = Fixtures.receiverKeys()
    assertEquals(v.getString("uaPublic"), keys.p256dh)
    assertEquals(v.getString("auth"), keys.authSecret)
    val plain = ByePushCrypto.decrypt(ByePushCrypto.fromBase64url(v.getString("body")), keys)
    assertEquals(v.getString("plaintext"), String(plain, Charsets.UTF_8))
  }

  @Test
  fun rejectsTruncatedAndTamperedMessages() {
    val keys = Fixtures.receiverKeys()
    val body = ByePushCrypto.fromBase64url(v.getString("body"))
    assertThrows(IllegalArgumentException::class.java) { ByePushCrypto.decrypt(body.copyOf(21), keys) }
    assertThrows(Exception::class.java) { ByePushCrypto.decrypt(body.copyOf(body.size - 1), keys) }
    val tampered = body.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
    assertThrows(Exception::class.java) { ByePushCrypto.decrypt(tampered, keys) }
  }

  @Test
  fun base64urlMatchesTheJdk() {
    val encoder = Base64.getUrlEncoder().withoutPadding()
    val random = Random(8291)
    for (size in 0..100) {
      val bytes = random.nextBytes(size)
      val encoded = ByePushCrypto.base64url(bytes)
      assertEquals(encoder.encodeToString(bytes), encoded)
      assertArrayEquals(bytes, ByePushCrypto.fromBase64url(encoded))
      assertArrayEquals(bytes, ByePushCrypto.fromBase64url(Base64.getUrlEncoder().encodeToString(bytes)))
    }
    assertThrows(IllegalArgumentException::class.java) { ByePushCrypto.fromBase64url("a+b/") }
    assertThrows(IllegalArgumentException::class.java) { ByePushCrypto.fromBase64url("abcde") }
  }

  @Test
  fun registrationMatchesTheSharedContract() {
    val keys = Fixtures.receiverKeys()
    val produced = Fixtures.cases("push-token", "produced").filter { it.getString("platform") == "fcm" }
    assert(produced.isNotEmpty())
    for (fixture in produced) {
      val emitted = JSONObject(ByePushCrypto.registration(fixture.getString("token"), keys))
      val expected = fixture.getJSONObject("expected")
      val keys = expected.keys().asSequence().toSet()
      assertEquals(fixture.getString("name"), keys, emitted.keys().asSequence().toSet())
      for (key in keys) assertEquals(key, expected.get(key), emitted.get(key))
    }
  }

  @Test
  fun messagingServiceDecodesGatewayNotices() {
    val keys = Fixtures.receiverKeys()
    for (fixture in Fixtures.cases("webpush", "notices")) {
      val expected = fixture.getJSONObject("expected")
      assertEquals(
        fixture.getString("name"),
        ByeMessagingService.Notice(
          expected.getString("title"),
          expected.getString("body"),
          expected.stringOrNull("url"),
          expected.stringOrNull("tag"),
        ),
        ByeMessagingService.decode(fixture.getString("message")) { keys },
      )
    }
  }

  @Test
  fun messagingServiceShowsTheGenericNoticeWhenItCannotDecrypt() {
    val keys = Fixtures.receiverKeys()
    val generic = ByeMessagingService.Notice("bye", "New notification", null, null)
    val message = Fixtures.cases("webpush", "notices").first().getString("message")
    var keysRead = false
    assertEquals(generic, ByeMessagingService.decode(null) { keysRead = true; keys })
    assert(!keysRead) { "keys are read only when there is ciphertext" }
    assertEquals(generic, ByeMessagingService.decode(message) { null })
    assertEquals(generic, ByeMessagingService.decode("not*base64") { keys })
    assertEquals(generic, ByeMessagingService.decode(message.dropLast(4)) { keys })
  }
}
