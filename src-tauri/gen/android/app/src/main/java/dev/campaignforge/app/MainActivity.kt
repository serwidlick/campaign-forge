package dev.campaignforge.app

import android.content.Context
import android.graphics.Color
import android.net.wifi.WifiManager
import android.os.Bundle
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  /**
   * Finding a GM's table uses mDNS, which is multicast. Android drops
   * multicast packets unless an app holds a multicast lock, so hold one
   * while the app is on screen: that is when the player is looking for a
   * table.
   */
  private var multicastLock: WifiManager.MulticastLock? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    // Light status bar icons over the page: the app's default themes are
    // dark, whatever the system's own light/dark setting says. The
    // navigation bar keeps the system's style, which draws the three-button
    // bar below the page and the gesture pill over it.
    enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT))
    super.onCreate(savedInstanceState)
  }

  override fun onStart() {
    super.onStart()
    val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    multicastLock = wifi?.createMulticastLock("campaign-forge-mdns")?.apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  override fun onStop() {
    multicastLock?.takeIf { it.isHeld }?.release()
    multicastLock = null
    super.onStop()
  }
}
