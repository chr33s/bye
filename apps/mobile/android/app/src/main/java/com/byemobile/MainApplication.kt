package com.byemobile

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // App-local modules: device-session secure store, home-screen widget and push bridges.
          add(ByeNativePackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    // Before any FCM message is handled (the messaging service can start the app).
    ByePushModule.initializeFirebase(this)
    loadReactNative(this)
  }
}
