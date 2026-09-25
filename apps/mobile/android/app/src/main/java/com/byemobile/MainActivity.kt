package com.byemobile

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  override fun getMainComponentName(): String = "ByeMobile"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    shareToDeepLink(intent)
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    shareToDeepLink(intent)
    super.onNewIntent(intent)
  }

  /**
   * Converts a share-sheet ACTION_SEND into a `bye://compose` VIEW intent so React Native's Linking
   * delivers it like any deep link. Only plain text is accepted, bounded in size.
   */
  private fun shareToDeepLink(intent: Intent?) {
    // mailto: SENDTO is delivered as VIEW so Linking sees it; the shared allowlist maps it to compose.
    if (intent?.action == Intent.ACTION_SENDTO && intent.data?.scheme == "mailto") {
      intent.action = Intent.ACTION_VIEW
      return
    }
    if (intent?.action != Intent.ACTION_SEND || intent.type != "text/plain") return
    val shared = intent.getStringExtra(Intent.EXTRA_TEXT)?.take(4000) ?: return
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.take(998)
    val builder = Uri.Builder().scheme("bye").authority("compose")
    if (shared.startsWith("https://") || shared.startsWith("http://")) builder.appendQueryParameter("url", shared) else builder.appendQueryParameter("text", shared)
    if (subject != null) builder.appendQueryParameter("subject", subject)
    intent.action = Intent.ACTION_VIEW
    intent.data = builder.build()
  }
}
