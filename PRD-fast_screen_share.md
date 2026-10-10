# Master Dev Document: fast_screen_share

## 1. Product Requirements Document (PRD)

### 1.1 Product Vision
To build the fastest, most frictionless B2B screen-sharing utility on the web. **fast_screen_share** enables professionals (Loan Officers, Sales Reps, Support Agents) to instantly share their screen, voice, and camera with a client via a Magic Link. Viewers join instantly on any device (mobile, tablet, desktop) without accounts, downloads, or installing apps.

### 1.2 Target Audience & Use Cases
*   **Mortgage Loan Officers (LOs):** Instantly walking a borrower through a complex rate breakdown or PDF application.
*   **Ad-Hoc Customer Support:** "Click this link so I can show you how to navigate the dashboard."
*   **Frictionless Sales Demos:** Sharing a presentation slide deck with a prospect in the middle of a phone call.

### 1.3 Core Principles
1.  **Absolute Minimum Clicks:** The Host selects their presentation mode and immediately sees the OS share picker. 
2.  **Viewer Friction is Zero:** Viewers click the link and see the stream. If audio is included, a single, massive "Tap to Join" button bypasses browser autoplay rules.
3.  **Room Awareness:** The Host must never wonder if they are speaking into the void. Real-time viewer counts, visual toasts, and audio chimes are mandatory.
4.  **Decentralized & Free (Infrastructure):** P2P WebRTC routes media directly between browsers. Server bandwidth costs remain $0.

### 1.4 Feature Requirements
*   **Three Presentation Modes:**
    1.  *Screen Only* (Auto-plays for viewers).
    2.  *Screen + Mic* (Requires 1-tap viewer bypass).
    3.  *Screen + Mic + PiP Camera* (Two-track WebRTC transmission with dual video rendering).
*   **The Share Hub:** 
    *   Best-effort auto-copy to clipboard.
    *   Deep links for instant sharing via SMS and Email (`mailto:`, `sms:`).
    *   Locally generated QR code for in-person/hybrid sharing.
*   **Host Room Awareness:**
    *   Synthesized audio chimes for Viewer Join/Leave (using native AudioContext, no MP3 files).
    *   Dynamic viewer count badge (🟢 1 Viewer / 🔴 0 Viewers).
    *   Connection drop detection polling `iceConnectionState` to catch "dirty" network drops.
*   **Smart Layout Geometry:**
    *   Use `object-fit: contain` on the main video element to flawlessly handle a 16:9 desktop being viewed on a 9:16 vertical mobile screen. 

### 1.5 Out of Scope (MVP)
*   User Accounts, Authentication, and Databases.
*   DRM bypassing / Off-screen rendering (Business users share PDFs and dashboards, not Netflix).
*   Google Cast SDKs (Viewers can use native OS screen mirroring if desired).
*   Chat boxes or Viewer-to-Host video/audio (This is a 1-way presentation tool).

---

## 2. Implementation Guide

### 2.1 Tech Stack
*   **Frontend:** Vanilla HTML5, CSS (CSS Variables, Grid/Flexbox), Vanilla JavaScript.
*   **Libraries:** PeerJS (WebRTC Signaling), qrcode.js (Local QR generation).
*   **Media API:** Native `navigator.mediaDevices` (`getDisplayMedia`, `getUserMedia`).
*   **Audio Synthesis:** Native `window.AudioContext`.
*   **Hosting:** Vercel, Netlify, or GitHub Pages (Must be served over HTTPS).

### 2.2 System Architecture & Flow
1.  **Initialization:** Host loads PWA -> Connects to PeerJS server -> Receives unique Host ID.
2.  **Media Acquisition:** Host selects mode -> Awaits `getDisplayMedia` -> Optionally awaits `getUserMedia` for mic/cam -> Maps to global `MediaStream` objects.
3.  **Link Generation:** Host ID is appended to the URL (`?room=HOST_ID`). QR code and Deep Links are populated.
4.  **Viewer Connection:** Viewer loads URL -> Parses `?room=` parameter -> Calls Host via PeerJS.5.  **Multi-Stream Handling (PiP):** 
    *   Viewer opens a data connection carrying `metadata: { role: 'viewer' }`. That connection is the presence channel: it tells the host who is watching.
    *   Host calls the viewer's peer with the Screen+Mic stream, `metadata: { type: 'main' }`. Viewer answers with no stream of its own.
    *   Host places a second call with the WebCam stream, `metadata: { type: 'pip' }`. Viewer answers it the same way.
    *   **Note (built instead of the original viewer-initiated calls):** the caller's offer decides the media sections, so a viewer that calls with nothing to send produces an offer with no tracks and the host's screen can never be attached to it. Calling from the host also keeps viewers from uploading anything, which matters on mobile data. Same one-way result, honest framing.
6.  **Teardown:** Native browser "Stop Sharing" bar triggers `onended` track event -> Cleans up all PeerJS calls and media tracks.

### 2.3 Critical Technical Constraints
*   **The Clipboard API Trap:** `navigator.clipboard.writeText` requires transient user activation. Because the OS screen picker interrupts the flow, auto-copy may fail. The catch block must silently fail and rely on the manual "Copy" button in the Share Hub.
*   **Mobile Autoplay Policies:** iOS Safari and Android Chrome strictly block autoplaying `<video>` tags that contain audio tracks unless the user interacts with the DOM. The `#viewer-overlay` div must sit on top of the video player with a z-index and handle the `.play()` promises on click.
*   **Connection State Polling:** WebRTC `close` events don't fire if a viewer loses cell service. You must poll `peerConnection.iceConnectionState` on active calls to check for `disconnected` or `failed` states to update the Viewer Count accurately.

---

## 3. Developer Task List

### Phase 1: Core Scaffolding
- [x] Set up single-file HTML structure (HTML/CSS/JS).
- [x] Split into `index.html`, `style.css`, and `app.js` for production scaling.
- [x] Add `manifest.json`, standard favicons, and `sw.js` for PWA installation capability.

### Phase 2: Media Pipeline
- [x] Implement Screen + Mic acquisition via `getDisplayMedia`.
- [x] Implement secondary WebCam acquisition via `getUserMedia` (capped to 320x180 resolution to save bandwidth).
- [x] Tie native browser "Stop Sharing" event to local cleanup function.

### Phase 3: Signaling & P2P Logic
- [x] Integrate PeerJS.
- [x] Build multi-track calling logic (Viewer requesting `main` and `pip` separately to prevent track conflict).
- [x] Implement Room Awareness (ICE state polling, Set() collection for active peers).

### Phase 4: UI/UX & Share Hub
- [x] Build Host Setup UI and Active Dashboard.
- [x] Implement QR Code generation via `qrcode.js`.
- [x] Implement Mailto and SMS deep link formatting.
- [x] Build AudioContext synthesized chimes for Join/Leave events.
- [x] Build animated Toast Notification system.

### Phase 5: Viewer Experience
- [x] Build massive "Tap to Join" overlay.
- [x] Implement `hasAudio` check to conditionally show/hide the Tap to Join overlay.
- [x] Implement `object-fit: contain` and PiP styling for seamless mobile viewing.

---

## 4. `agents.md` (AI Developer Context)

```markdown
# AI Developer Instructions: fast_screen_share

## Role Context
You are a Senior WebRTC & PWA Developer building "fast_screen_share", a B2B zero-friction presentation tool. The core ethos of this project is absolute simplicity. It allows professionals to share their screen, mic, and a PiP camera via a Magic Link.

## Strict Architectural Rules
1. **Vanilla Only:** DO NOT use React, Vue, Svelte, or Next.js. Keep the codebase in Vanilla JS, HTML, and CSS. The bundle size must remain microscopic. 
2. **P2P WebRTC Only:** DO NOT write Node.js, Python, or Go server code. All signaling uses the client-side `PeerJS` library. All media is strictly P2P.
3. **No External Media Assets:** DO NOT add `.mp3` or `.wav` files for sound effects. All audio chimes (Join/Leave) must be synthesized using the browser's native `AudioContext` API.
4. **No Desktop App Ports:** Do NOT attempt to wrap this in Electron or Tauri unless explicitly ordered. It is a browser-first PWA.
5. **No Databases:** Do not implement Firebase, Supabase, or any database. State exists only in the active DOM and WebRTC connection.

## Development Mandates
* **The Autoplay Rule:** Never attempt to `.play()` a video element with audio on load. Always wrap the `.play()` call in a user-initiated click event (The massive "Tap to Join" button) to bypass Safari/Chrome mobile autoplay restrictions.
* **The Drop Detection Rule:** WebRTC is finicky with dirty network drops. You must actively poll `call.peerConnection.iceConnectionState` to detect 'disconnected', 'failed', or 'closed' states. Relying solely on `call.on('close')` will result in ghost viewers in the UI.
* **Dual Stream PiP:** Standard HTML5 video elements struggle with multiple video tracks in a single stream. You must manage the Screen+Mic as one `MediaStream` and the PiP Camera as a secondary `MediaStream`, passing them through two separate PeerJS calls (`metadata: { type: 'main' | 'pip' }`).

## UI / CSS Guidelines
* Mobile-first design for the Viewer UI.
* Use `object-fit: contain` for the main screen share video to handle portrait mobile screens gracefully. 
* Professional, clean B2B color palette (e.g., Atlassian-style blues, grays, and whites).
```