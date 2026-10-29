package com.eepiemi.materialbook

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Guards the PureBook rebrand (app_name, theme style) from silently reverting
 * to "Materialbook" or "Faceboost" on a future upstream merge that touches strings.xml/themes.xml.
 * Uses startsWith so the test is robust to the debug-build suffix ("PureBook Debug").
 */
@RunWith(AndroidJUnit4::class)
class AppIdentityTest {

    @Test
    fun appNameIsPureBook() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        assertTrue(
            "app_name should start with \"PureBook\" but was \"${context.getString(R.string.app_name)}\"",
            context.getString(R.string.app_name).startsWith("PureBook")
        )
    }
}
