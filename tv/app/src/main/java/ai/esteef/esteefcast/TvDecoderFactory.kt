package ai.esteef.esteefcast

import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.EglBase
import org.webrtc.VideoCodecInfo
import org.webrtc.VideoDecoder
import org.webrtc.VideoDecoderFactory

/**
 * libwebrtc only advertises H.264 High profile for decoders on its own allow-list
 * (Qualcomm, Exynos). Fire TV (MediaTek) and most TV chips decode High profile fine
 * in hardware but are left at Baseline, and a Baseline answer makes the PC's
 * Chromium fall back to its slow software encoder (OpenH264). So we advertise
 * High as well and hand every H.264 stream to the same hardware decoder:
 * MediaCodec's "video/avc" decoder isn't tied to a profile.
 */
class TvDecoderFactory(egl: EglBase.Context) : VideoDecoderFactory {
    private val inner = DefaultVideoDecoderFactory(egl)

    private fun h264(profile: String) = VideoCodecInfo(
        "H264",
        mapOf("level-asymmetry-allowed" to "1", "packetization-mode" to "1", "profile-level-id" to profile),
        emptyList<String>(),
    )

    override fun getSupportedCodecs(): Array<VideoCodecInfo> {
        val base = inner.supportedCodecs.toList()
        if (base.none { it.name.equals("H264", ignoreCase = true) }) return base.toTypedArray()
        val have = base.mapNotNull { c: VideoCodecInfo -> if (c.name.equals("H264", true)) c.params["profile-level-id"]?.lowercase()?.take(4) else null }.toSet()
        val extra = listOf("640c1f", "64001f").filter { it.take(4) !in have }.map { h264(it) }
        // High profile first so the PC picks it (and its hardware encoder).
        return (extra + base).toTypedArray()
    }

    override fun createDecoder(info: VideoCodecInfo): VideoDecoder? {
        if (info.name.equals("H264", ignoreCase = true)) {
            return inner.createDecoder(info) ?: inner.createDecoder(h264("42e01f"))
        }
        return inner.createDecoder(info)
    }
}
