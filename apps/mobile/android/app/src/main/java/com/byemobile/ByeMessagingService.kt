package com.byemobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/**
 * FCM delivery (spec P1.7). Bye's push gateway sends data-only messages whose `p` is the instance's
 * Web Push ciphertext; it is decrypted here with this device's keys (ByePushCrypto) and shown as a
 * notification. Google and the gateway never see the content. A message that can't be decrypted
 * still shows a generic notification rather than nothing.
 */
class ByeMessagingService : FirebaseMessagingService() {
  override fun onNewToken(token: String) {
    ByePushModule.tokenChanged()
  }

  override fun onMessageReceived(message: RemoteMessage) {
    val notice = decode(applicationContext, message.data["p"])
    show(applicationContext, notice)
  }

  data class Notice(val title: String, val body: String, val url: String?, val tag: String?)

  companion object {
    const val CHANNEL = "mail"
    const val EXTRA_URL = "email.bye.push.url"

    fun decode(context: Context, sealed: String?): Notice {
      val generic = Notice("bye", "New notification", null, null)
      if (sealed == null) return generic
      return try {
        val keys = ByePushCrypto.load(context) ?: return generic
        val plain = ByePushCrypto.decrypt(ByePushCrypto.fromBase64url(sealed), keys)
        val json = JSONObject(String(plain, Charsets.UTF_8))
        fun text(key: String) = json.optString(key, "").take(500).ifEmpty { null }
        Notice(
          title = text("title") ?: generic.title,
          body = text("body") ?: generic.body,
          url = text("url")?.takeIf { it.startsWith("https://") },
          tag = text("collapseId"),
        )
      } catch (error: Exception) {
        generic
      }
    }

    fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java)
      if (manager.getNotificationChannel(CHANNEL) != null) return
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "Mail and calendar", NotificationManager.IMPORTANCE_HIGH)
      )
    }

    fun show(context: Context, notice: Notice) {
      if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
      ensureChannel(context)
      // A tap reopens the app and hands the link to JS (ByePushModule), never to a browser.
      val open = Intent(context, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        notice.url?.let { putExtra(EXTRA_URL, it) }
      }
      val id = (notice.tag ?: notice.url ?: System.nanoTime().toString()).hashCode()
      val intent = PendingIntent.getActivity(
        context, id, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      val notification = NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle(notice.title)
        .setContentText(notice.body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(notice.body))
        .setAutoCancel(true)
        .setContentIntent(intent)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .build()
      try {
        NotificationManagerCompat.from(context).notify(id, notification)
      } catch (error: SecurityException) {
        // POST_NOTIFICATIONS was revoked between the check and the post.
      }
    }
  }
}
