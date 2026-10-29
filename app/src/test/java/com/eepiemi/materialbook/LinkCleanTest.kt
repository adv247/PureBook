package com.eepiemi.materialbook

import com.eepiemi.materialbook.utils.cleanLink
import com.eepiemi.materialbook.utils.isShortLink
import com.eepiemi.materialbook.utils.stripAffiliateParams
import com.eepiemi.materialbook.utils.unwrapRedirectors
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The two-pass link cleaner that every link leaving the app goes through (pure JVM, no Android). */
class LinkCleanTest {

    @Test
    fun facebookWrappedShopeeLinkLosesTrackingAndCommissionParams() {
        val link = "https://l.facebook.com/l.php?u=https%3A%2F%2Fshopee.vn%2Fproduct%2F123%3Futm_source%3Dx" +
            "%26smtt%3D0.0.9%26spm%3Da.b%26id%3D7&h=AT0&fbclid=Qz"
        assertEquals("https://shopee.vn/product/123?id=7", cleanLink(link))
    }

    @Test
    fun amazonAffiliateTagIsRemovedButProductParamsStay() {
        assertEquals(
            "https://www.amazon.com/dp/B000?th=1&psc=1",
            cleanLink("https://www.amazon.com/dp/B000?tag=foo-20&linkCode=ll1&th=1&psc=1"),
        )
    }

    @Test
    fun shoppingOnlyParamsSurviveOnOtherSites() {
        val link = "https://example.com/search?q=a&spm=1&tag=x"
        assertEquals(link, stripAffiliateParams(link))
        assertEquals(link, cleanLink(link))
    }

    @Test
    fun googleRedirectorIsUnwrappedAndTheDestinationCleaned() {
        assertEquals(
            "https://example.com/a",
            cleanLink("https://www.google.com/url?q=https://example.com/a?aff_id=9&sa=t"),
        )
    }

    @Test
    fun nestedRedirectorsAreUnwrappedAllTheWayDown() {
        val link = "https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.google.com%2Furl%3Fq%3D" +
            "https%253A%252F%252Fexample.org%252F%253Futm_x%253D1"
        assertEquals("https://example.org/", cleanLink(link))
    }

    @Test
    fun unwrapRedirectorsLeavesPlainLinksAlone() {
        assertEquals("https://example.com/page?id=5", unwrapRedirectors("https://example.com/page?id=5"))
    }

    @Test
    fun fragmentAndOrderOfKeptParamsAreUntouched() {
        assertEquals(
            "https://shopee.vn/p?b=2&a=1#top",
            cleanLink("https://shopee.vn/p?b=2&smtt=1&a=1#top"),
        )
    }

    @Test
    fun shortLinkHostsAreRecognised() {
        listOf(
            "https://shope.ee/abc", "https://vt.tiktok.com/ZS1/", "https://bit.ly/x",
            "https://www.tiktok.com/t/ZT1/", "https://amzn.to/3x",
        ).forEach { assertTrue(it, isShortLink(it)) }
    }

    @Test
    fun ordinaryLinksAreNotShortLinks() {
        listOf(
            "https://example.com/", "https://shopee.vn/product/1", "https://www.tiktok.com/@a/video/1",
            "not a url",
        ).forEach { assertFalse(it, isShortLink(it)) }
    }
}
