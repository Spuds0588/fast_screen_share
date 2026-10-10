# fast_screen_share

Share your screen, voice and camera with a client through one magic link. Viewers open the link on a phone, tablet or laptop, tap once, and they are watching. No account, no download, no app to install.

Live at https://spuds0588.github.io/fast_screen_share/

## Why it is different

- The viewer does nothing but tap a link.
- Media goes browser to browser over WebRTC, so there is no video server to pay for and no bandwidth bill that grows with every viewer.
- There are no accounts, no database and no recording. State lives in the open tab.

## How it works, for the host

1. Pick a mode: screen only, screen plus mic, or screen plus mic plus a picture in picture camera.
2. Your operating system's own share picker opens. Choose the window or the whole display.
3. You land on a dashboard with a magic link, a QR code and buttons to send the link by text or email.
4. The viewer opens the link. If you are sending audio they tap once to let the browser play it.
5. You hear a chime as each viewer joins or leaves, and the count badge next to your preview updates as they come and go.

## Run it locally

The site is plain static files, so any web server over the repository root works.

```bash
python3 -m http.server 8137
# then open http://localhost:8137
```

Screen and camera capture only work in a secure context, which means an https URL or localhost. Opening `index.html` straight from the file system will not work.

## Demo mode

Add `?demo=1` to the URL, or click "Run a demo screen" on the setup screen, to present a synthetic animated screen with a generated tone instead of your real one. It skips the OS picker, which makes it useful for testing the viewer experience, the join chime and the tap to join overlay.

## Install as an app

The site ships a `manifest.json` and a service worker, so the browser offers to install it. Installed, it opens in its own window and the app shell keeps working offline.

## Architecture

Vanilla HTML, CSS and JavaScript with no build step. [PeerJS](https://peerjs.com/) carries signalling, `getDisplayMedia` and `getUserMedia` capture the screen, mic and camera, [qrcode.js](https://github.com/davidshimjs/qrcodejs) draws the QR code locally, `AudioContext` synthesises the join and leave chimes (there are no sound files), and `sw.js` caches the app shell. A viewer opens a data connection to announce itself, then the host calls it back with the screen stream and, in camera mode, a second stream for the corner video.

Nothing about your screen is uploaded. Tracks are exchanged directly between the two browsers, and a session ends when the host closes the tab or stops sharing.
