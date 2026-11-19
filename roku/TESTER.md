# EsteefCast on Roku: tester guide

Thanks for testing! This is the first Roku build, so nothing has run on a real Roku yet.
Your notes are what makes it work.

You need a **Windows PC** and a **Roku** on the **same home network**.

## 1. Install the PC app
1. Download `EsteefCast-0.4.0-portable.exe` from the release page and run it. There's nothing to install.
2. The first time, Windows Firewall asks about it. Allow **Private networks**.
3. Pick a screen and press **Share to TVs**.

## 2. Turn on developer mode on the Roku (once)
1. On the Roku remote, press: **Home ×3, Up ×2, Right, Left, Right, Left, Right**.
2. On the Developer Settings screen, note the **IP address** it shows, choose **Enable installer and restart**, agree, and set a **developer password**. Write it down.
3. Wait for the Roku to restart.

## 3. Install the EsteefCast channel
1. On the PC, open a browser at `http://<the Roku's IP address>`.
2. Sign in with the user name `rokudev` and the password you set.
3. **Upload** `EsteefCast-Roku-0.4.0.zip`, then press **Install with zip**.
4. EsteefCast opens on the Roku. (It also appears at the end of the Home screen list as a dev channel.)

## 4. Test
1. On the Roku, your PC should show up in the list. Select it.
   If it doesn't show up, choose **Enter address** and type the address the PC app shows under "Connect a TV".
2. The PC asks **Allow / Deny** for the Roku. Choose **Allow**.
3. The picture should start within a few seconds.

While it plays, please note:
- **Did the picture start?** How long did it take?
- **Delay:** open a stopwatch on the PC screen (for example, search "stopwatch" in a browser), then take one phone photo that shows both the PC screen and the TV. The difference between the two times is the delay.
- **Smoothness:** is motion smooth, or does it stutter or pause? Does the sound play?
- Press **OK** on the Roku remote to show the stats box, and take a photo of it.
- Try **Back**, then select the PC again. Does it start again?
- On the PC, try **Stop sharing**, then share again.

## 5. Send back
- The **Roku log**: right-click the EsteefCast icon in the PC's system tray, choose **Open Roku log**, and send that file.
- Your notes and photos.
- The Roku model: Settings → System → About.

## If the picture won't play
On the PC, try **Roku picture → 1080p · 30 fps (older Rokus)**, then select the PC again on the Roku. Tell us which setting worked.
