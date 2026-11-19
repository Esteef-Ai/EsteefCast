# EsteefCast — design

An Esteef.Ai product. Share a PC's screen and sound to a TV, at home or at a friend's house, in a way that just works.

## Scope of version 1
- Watching only. No controller or mouse input goes back to the PC.
- 1080p60 with system audio by default. 720p60, 1440p60 and 4K60 (2160p60) are options.
- Viewers: Android TV / Google TV (including TCL Google TV models) and Fire TV devices that run Fire OS.
- Not in v1: Roku (phase 4) and Fire TV devices that run Vega OS (they can't install APKs).

## Parts
| Part | What it is | Tech |
|---|---|---|
| Host (`host/`) | Portable Windows exe in the system tray. Captures a screen or window plus system audio, encodes, serves viewers. | Electron, WebRTC, hardware H.264 (NVENC / AMF / QSV via Media Foundation) |
| TV viewer (`tv/`) | Android TV APK. Full-screen player, works with the D-pad. | Kotlin, libwebrtc (`stream-webrtc-android`), MediaCodec H.264 decode |
| Web viewer (`host/web/`) | Viewer page the host serves at `http://<pc>:47801/`. | Browser WebRTC |
| Service (`rendezvous/`) | Introduces TVs away from home to PCs: invite codes, presence, a relay for connection setup, and STUN. Never carries video. | Node + `ws`, TLS with a pinned self-signed certificate |

## Home network flow (built)
1. The TV broadcasts `ESTEEFCAST_DISCOVER` on UDP 47800. Each host replies with its name, port and what it is sharing.
2. The TV lists every host it finds. The user picks one.
3. The TV opens `ws://<pc>:47801/ws` and sends `hello`. The WebRTC media goes directly from host to TV.
4. A TV the host hasn't seen before triggers an "Allow / Deny" prompt on the PC. Allowed TVs are remembered and can be removed with Forget.
5. Fallback when discovery is blocked (mesh systems, guest Wi-Fi, separate network segments): the PC shows its address, and the TV's **Enter address** saves it.

### Signaling messages
| From | Type | Meaning |
|---|---|---|
| viewer | `hello {deviceId, name, kind}` | Identify; asks for approval if this device is new |
| host | `pending`, `denied`, `welcome {sharing, title}`, `state {sharing, title}` | Approval and sharing state |
| host | `offer {sdp}`, `stopped` | Start or stop a stream |
| viewer | `answer {sdp}`, `request` | Answer an offer, or ask for a fresh one after a failure |
| both | `candidate {candidate, sdpMid, sdpMLineIndex}` | ICE candidates |

## Remote flow (phase 2, built)
1. With **Let invited friends watch from their home** turned on, the PC keeps a connection to the service (`wss://<service>:47900/host`). It registers with its host ID and a secret only it knows.
2. **Create invite code** makes a code like `BEAR-4821`. It works once, within 24 hours.
3. The friend's TV chooses **Add a friend's PC** and sends the code (`/viewer`, `redeem`). The PC creates a 256-bit key for that TV and keeps only its hash. The TV stores the key.
4. To watch, the TV sends `open {hostId, deviceId, token}`. The PC checks the key and accepts. After that, the service passes the normal protocol messages (`hello`, `offer`, `answer`, `candidate`, …) both ways without reading them.
5. Both sides use the service's STUN (UDP 3478) to learn their public addresses, so the video goes straight from PC to TV.
6. If both networks block direct connections, the TV says so plainly. A TURN relay and UPnP port mapping are possible later additions.

Each friend's stream is limited by the PC's **Upload limit per friend** (default 8 Mbps), and starts at 2.5 Mbps.

### Service security
- TLS on every connection. The apps trust only the certificate they ship with (`host/assets/service-cert.pem`, `tv/.../res/raw/service_cert.pem`).
- The service stores a hash of each PC's secret. Another machine can't take over a PC's ID.
- Codes: single use, 24 hours, at most 10 open per PC, 10 tries per minute per IP address.
- Keys for friends' TVs exist only on the TV and, hashed, on the PC. **Forget** on the PC removes access.

## Video and quality
- One WebRTC connection per viewer, so each viewer gets its own bitrate.
- Bitrate caps: 720p60 10 Mbps, 1080p60 20 Mbps, 1440p60 35 Mbps, 4K60 60 Mbps. The host edits the answer SDP to add `x-google-start-bitrate`, so the stream starts sharp instead of ramping up.
- H.264 is preferred, high profile first. Weak TV chips decode it in hardware, whereas VP8/VP9 can stutter there.
- `maintain-framerate`: when bandwidth is short, resolution drops before frame rate does.
- Audio: Opus stereo, 510 kbps, no echo cancellation, noise suppression or automatic gain.
- Electron is started with `WebRtcHideLocalIpsWithMdns` disabled so TVs see real local addresses.
- The capture/encode part can later be replaced by a Moonlight-class native engine (about 20–40 ms).

## Security
- WebRTC encrypts media end to end (DTLS-SRTP).
- New viewers need approval on the PC.
- Phase 2: invite codes are single-use and expire, and the rendezvous service never sees video.

## Phases
1. Home network: host and viewer, discovery, 1080p60 with a 4K option, audio, multiple TVs, Allow prompt, address fallback. **Built (v0.1.0).**
2. Remote viewing: service, invite codes, friends' TVs, upload limit. **Built (v0.2.0).** Next: UPnP, TURN.
3. Packaging: a real APK signing key, code-signed exe, sideload guide, a cap on how many viewers can watch at once.
4. Roku watch-only app (BrightScript, low-latency HLS from the host, 1–3 s delay).
