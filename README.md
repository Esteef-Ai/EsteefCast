<p align="center"><img src="host/assets/icon.png" width="96" alt="EsteefCast"></p>

<h1 align="center">EsteefCast</h1>
<p align="center">Share your PC's screen and sound to your TV. 1080p at 60 fps, with 4K as an option. No accounts, no cloud.<br>By Esteef.Ai</p>

---

## Download

Get both files from the [latest release](https://github.com/Esteef-Ai/EsteefCast/releases/latest):

| File | Goes on |
|---|---|
| `EsteefCast-<version>-portable.exe` | Your Windows PC. Nothing to install: just run it. |
| `EsteefCast-TV-<version>.apk` | Your Android TV, Google TV or Fire TV. |

## How to use it

1. **PC:** run `EsteefCast-…-portable.exe`. The first time, Windows Firewall asks about it. Allow it on **Private networks**.
2. **PC:** pick a screen or window, choose a quality, and press **Share to TVs**.
3. **TV:** open EsteefCast. Your PC shows up on its own; select it.
4. **PC:** the first time a TV connects, the PC asks **Allow** or **Deny**. Allowed TVs are remembered.

If your PC doesn't show up on the TV (some mesh Wi-Fi and guest networks block that), choose **Enter address** on the TV and type the address shown in the PC app.

On the TV, press **OK** while watching to show the stream stats. Press **Back** to go back to the PC list.

Any browser on your network can also watch, at `http://<your-pc-address>:47801/`.

### Friends watching from their home

1. **PC:** under *Friends outside your home*, turn on **Let invited friends watch from their home**.
2. **PC:** press **Create invite code** and send your friend the code, for example `BEAR-4821`. It works once, within 24 hours.
3. **Friend's TV:** open EsteefCast, choose **Add a friend's PC** and type the code. Your PC then appears in their list.

The video goes straight from your PC to their TV. The EsteefCast service only introduces the two and never sees the picture. Each friend uses some of your internet upload; set the limit under **Upload limit per friend**. To stop a friend watching, press **Forget** next to their TV.

## Installing the APK on a TV

**Fire TV**
1. Settings → My Fire TV → Developer options → turn on **Install unknown apps** for the *Downloader* app. If Developer options is hidden, go to Settings → My Fire TV → About and press OK on the device name 7 times.
2. Install **Downloader** from the Amazon app store, open it, and enter the APK's download link from the release page.

**Android TV / Google TV (TCL, Sony, Chromecast with Google TV, …)**
1. Settings → System → About → press OK on **Android TV OS build** 7 times to turn on developer mode.
2. Settings → Apps → Security & restrictions → **Unknown sources**: allow *Downloader* (or your file manager).
3. Install **Downloader** from Google Play and enter the APK link. Another way: copy the APK onto a USB stick and open it with a file manager.

> Roku TVs (including TCL Roku TV models) and Fire TV devices running Vega OS can't install APKs. A Roku app is planned.

## Quality

| Setting | Bitrate cap | Notes |
|---|---|---|
| 720p · 60 fps | 10 Mbps | Weak Wi-Fi |
| **1080p · 60 fps** | 20 Mbps | Default |
| 1440p · 60 fps | 35 Mbps | |
| 4K · 60 fps | 60 Mbps | Needs a wired connection or fast Wi-Fi, and a 4K TV |

The PC encodes in hardware where it can (NVIDIA NVENC, AMD AMF, Intel Quick Sync), and the stats show which encoder is in use. Expected delay on a home network is about 60–120 ms.

## Ports

| Port | Use |
|---|---|
| UDP 47800 | TVs finding PCs |
| TCP 47801 | Connection setup and the web viewer |
| UDP (dynamic) | Video and audio (WebRTC, encrypted) |

The EsteefCast service (only for friends outside the home) uses TCP 47900 and UDP 47901. See `rendezvous/`.

## Building from source

**PC app** (Node 20+):
```
cd host
npm install
npm start          # run it
npm test           # end-to-end test: discovery, 60 fps H.264, stereo audio
npm run test:remote  # friends outside the home, through a local copy of the service
npm run dist       # build the portable exe into host/dist
```

**TV app** (JDK 17+, Android SDK 35):
```
cd tv
gradlew assembleRelease
```

**Service** (Node 18+): see `rendezvous/`. Make a certificate with `make-cert.sh`, then put `cert.pem` into both apps (see the script) and run `start-service.bat`.

See [DESIGN.md](DESIGN.md) for how it works and what's planned.
