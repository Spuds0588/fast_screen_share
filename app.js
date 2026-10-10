/* fast_screen_share
 * Zero-friction peer-to-peer screen sharing.
 *
 * Host: captures screen (+ mic, + camera) and hands out a magic link.
 * Viewer: opens the link, taps once if there is audio, and watches.
 *
 * Transport: PeerJS handles signalling. Media never touches a server.
 * The viewer opens a data connection to announce itself, then the host
 * calls that viewer back with the screen stream (and a second call for
 * the picture-in-picture camera). One-way media, no upload from viewers.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Config                                                             */
  /* ------------------------------------------------------------------ */

  var HOST_PREFIX = 'fss-';
  var VIEWER_PREFIX = 'fsv-';
  var ID_BODY = 'abcdefghijkmnpqrstuvwxyz23456789'; // no l, o, 0, 1
  var ID_BODY_LENGTH = 7;
  var MAX_ID_ATTEMPTS = 3;

  // Public STUN only. TURN would be needed for strict corporate networks,
  // but this app stays serverless on purpose.
  var ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];

  var PING_INTERVAL = 3000;      // viewer -> host keepalive
  var PONG_GRACE = 15000;        // viewer gives up on the host after this
  var HEALTH_INTERVAL = 2000;    // iceConnectionState polling
  var VIEWER_TIMEOUT = 25000;    // no word from a viewer in this long
  var TIMEOUT_STRIKES = 2;       // consecutive quiet polls before dropping
  var ICE_GRACE_STRIKES = 2;     // tolerated 'disconnected' polls

  var MODES = {
    'screen': { label: 'Screen only', mic: false, cam: false },
    'screen-mic': { label: 'Screen + Mic', mic: true, cam: false },
    'screen-mic-cam': { label: 'Screen + Mic + Camera', mic: true, cam: true }
  };

  /* ------------------------------------------------------------------ */
  /* State                                                              */
  /* ------------------------------------------------------------------ */

  var S = {
    role: null,          // 'host' | 'viewer'
    peer: null,
    peerId: null,
    peerAttempts: 0,
    peerOpen: false,
    room: null,
    mode: null,
    demo: false,
    live: false,
    media: null,         // { main, pip, dispose }
    main: null,
    pip: null,
    viewers: {},         // viewerPeerId -> entry
    startedAt: 0,
    shareUrl: '',
    conn: null,          // viewer: data connection to the host
    lastPong: 0,
    unstableWarned: false,
    shareStatusWarning: false,
    hasAudio: false,
    needsTap: false,
    tapDone: false,
    ended: false,
    audioCtx: null,
    wakeLock: null,
    started: false,
    pingTimer: null,
    healthTimer: null,
    dimTimer: null
  };

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                      */
  /* ------------------------------------------------------------------ */

  function $(id) { return document.getElementById(id); }

  function show(el) { if (el) el.hidden = false; }
  function hide(el) { if (el) el.hidden = true; }

  function randomId(prefix) {
    var out = '';
    var bytes = new Uint8Array(ID_BODY_LENGTH);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    for (var j = 0; j < bytes.length; j++) out += ID_BODY.charAt(bytes[j] % ID_BODY.length);
    return prefix + out;
  }

  function toast(message, kind, ttl) {
    var host = $('toasts');
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'toast toast--' + (kind || 'info');
    el.textContent = message;
    host.appendChild(el);
    while (host.children.length > 3) host.removeChild(host.firstElementChild);
    window.setTimeout(function () {
      el.classList.add('is-out');
      window.setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 340);
    }, ttl || 4200);
  }

  function isSecure() {
    if (window.isSecureContext) return true;
    var h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '';
  }

  function humanDuration(ms) {
    var secs = Math.max(1, Math.round(ms / 1000));
    if (secs < 60) return secs + 's';
    var mins = Math.round(secs / 60);
    if (mins < 60) return mins + ' min';
    return Math.round(mins / 60) + ' hr';
  }

  function plural(n, one, many) { return n === 1 ? one : (many || one + 's'); }

  /* ------------------------------------------------------------------ */
  /* Audio: chimes and demo tone, all synthesised on the fly            */
  /* ------------------------------------------------------------------ */

  function audioCtx() {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      if (!S.audioCtx) S.audioCtx = new Ctor();
      if (S.audioCtx.state === 'suspended' && S.audioCtx.resume) S.audioCtx.resume();
      return S.audioCtx;
    } catch (err) {
      return null;
    }
  }

  // Called from inside a click handler so the context unlocks on mobile.
  function primeAudio() { audioCtx(); }

  function playNote(ctx, freq, at, dur, peak, type) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.03);
  }

  function chime(kind) {
    var ctx = audioCtx();
    if (!ctx) return;
    var now = ctx.currentTime + 0.01;
    if (kind === 'leave') {
      playNote(ctx, 622.25, now, 0.20, 0.07);
      playNote(ctx, 415.30, now + 0.13, 0.26, 0.06);
    } else {
      playNote(ctx, 587.33, now, 0.16, 0.07);
      playNote(ctx, 880.00, now + 0.11, 0.22, 0.06);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Connection pill (host)                                             */
  /* ------------------------------------------------------------------ */

  function setConn(stateName, label) {
    var pill = $('conn-pill');
    var text = $('conn-label');
    if (!pill) return;
    pill.setAttribute('data-state', stateName);
    if (text) text.textContent = label || ({
      connecting: 'Connecting…',
      ready: 'Ready to share',
      offline: 'Signalling offline',
      error: 'Signalling error'
    })[stateName] || '';
  }

  // kind: 'ok' (copied), 'info' (neutral next step), 'warn' (needs attention).
  function setShareStatus(message, kind) {
    var el = $('copy-status');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('is-warn', kind === 'warn');
    el.classList.toggle('is-info', kind !== 'ok');
    S.shareStatusWarning = kind === 'warn';
  }

  /* ------------------------------------------------------------------ */
  /* Host: media acquisition                                            */
  /* ------------------------------------------------------------------ */

  function stopStream(stream) {
    if (!stream) return;
    stream.getTracks().forEach(function (track) {
      try { track.stop(); } catch (err) { /* already gone */ }
    });
  }

  // Real capture: screen first (the click ends in the OS picker), then the
  // optional mic and camera. Missing mic or camera downgrade the session
  // instead of killing it.
  function acquireCapture(mode, done, fail) {
    var cfg = MODES[mode] || MODES['screen'];
    var cleanup = { display: null, mic: null, cam: null };

    var constraints = {
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'exclude'
    };

    navigator.mediaDevices.getDisplayMedia(constraints).then(function (display) {
      cleanup.display = display;
      var tracks = display.getVideoTracks().slice();

      function withCam() {
        if (!cfg.cam) return finish();
        navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 320 }, height: { ideal: 180 }, frameRate: { ideal: 15, max: 15 }, facingMode: 'user' },
          audio: false
        }).then(function (cam) {
          cleanup.cam = cam;
          finish();
        }, function () {
          toast('Camera unavailable. Sharing without picture in picture.', 'info');
          finish();
        });
      }

      function withMic() {
        if (!cfg.mic) return withCam();
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false
        }).then(function (mic) {
          cleanup.mic = mic;
          tracks = tracks.concat(mic.getAudioTracks());
          withCam();
        }, function () {
          // No mic is not a reason to lose the camera too: keep going.
          toast('Microphone unavailable. Sharing without sound.', 'info');
          withCam();
        });
      }

      function finish() {
        done({
          main: new MediaStream(tracks),
          pip: cleanup.cam || null,
          dispose: function () {
            stopStream(cleanup.display);
            stopStream(cleanup.mic);
            stopStream(cleanup.cam);
          }
        });
      }

      withMic();
    }, function (err) {
      stopStream(cleanup.display);
      stopStream(cleanup.mic);
      stopStream(cleanup.cam);
      fail(err);
    });
  }

  // Demo capture: a synthetic animated screen plus an optional tone and a
  // synthetic camera. Exists so the viewer experience can be tried, and
  // tested, without an OS picker.
  function acquireDemo(mode, done) {
    var cfg = MODES[mode] || MODES['screen-mic-cam'];

    function makeCanvasStream(width, height, label, accent, fps) {
      var canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      var ctx = canvas.getContext('2d');
      var startedAt = Date.now();
      var timer = null;

      function paint() {
        var t = (Date.now() - startedAt) / 1000;
        var g = ctx.createLinearGradient(0, 0, width, height);
        g.addColorStop(0, '#0a2540');
        g.addColorStop(1, '#123c63');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);

        // drifting dots
        ctx.fillStyle = 'rgba(255,255,255,.10)';
        for (var i = 0; i < 26; i++) {
          var x = (i * 71 + t * 14) % (width + 40) - 20;
          var y = (i * 103 + Math.sin(t + i) * 26 + height) % height;
          ctx.beginPath();
          ctx.arc(x, y, 3 + (i % 3), 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.fillStyle = accent;
        ctx.fillRect(0, height - 14, width, 14);

        var unit = Math.max(12, Math.round(height / 14));
        ctx.fillStyle = '#ffffff';
        ctx.font = '700 ' + unit + 'px -apple-system, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(label, unit, unit * 2);
        ctx.font = '400 ' + Math.round(unit * 0.62) + 'px -apple-system, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,.75)';
        ctx.fillText('fast_screen_share demo · ' + new Date().toLocaleTimeString(), unit, unit * 3.2);

        // travelling progress bar
        var barW = width * 0.6;
        var barX = (t * 160) % (width + barW) - barW;
        ctx.fillStyle = 'rgba(255,255,255,.18)';
        ctx.fillRect(width * 0.2, height * 0.62, barW, Math.max(8, height * 0.03));
        ctx.fillStyle = accent;
        ctx.fillRect(Math.max(width * 0.2, Math.min(barX, width * 0.8)), height * 0.62, Math.min(barW * 0.5, Math.max(0, width * 0.8 - barX)), Math.max(8, height * 0.03));

        ctx.beginPath();
        ctx.arc(width * 0.5 + Math.sin(t) * width * 0.28, height * 0.82, Math.max(9, height * 0.035), 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.fill();
      }

      paint();
      timer = window.setInterval(paint, Math.round(1000 / (fps || 12)));

      var stream = canvas.captureStream(fps || 12);
      var stopper = function () {
        window.clearInterval(timer);
        stopStream(stream);
      };
      return { stream: stream, stop: stopper };
    }

    var screen = makeCanvasStream(1280, 720, 'DEMO SCREEN', '#3ba3ff', 12);
    var tracks = screen.stream.getVideoTracks().slice();
    var tone = null;

    if (cfg.mic) {
      var ctx = audioCtx();
      if (ctx) {
        try {
          var dest = ctx.createMediaStreamDestination();
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(196, ctx.currentTime);
          osc.frequency.linearRampToValueAtTime(392, ctx.currentTime + 6);
          gain.gain.setValueAtTime(0.0001, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.4);
          osc.connect(gain);
          gain.connect(dest);
          osc.start();
          tone = { osc: osc, gain: gain, dest: dest };
          tracks = tracks.concat(dest.stream.getAudioTracks());
        } catch (err) { /* no demo audio, still fine */ }
      }
    }

    var cam = cfg.cam ? makeCanvasStream(320, 180, 'DEMO CAM', '#7ad0ff', 8) : null;

    done({
      main: new MediaStream(tracks),
      pip: cam ? cam.stream : null,
      dispose: function () {
        screen.stop();
        if (cam) cam.stop();
        if (tone) {
          try { tone.osc.stop(); } catch (err) { /* stopped */ }
          stopStream(tone.dest.stream);
        }
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Host: peer and session                                             */
  /* ------------------------------------------------------------------ */

  function createPeer(role) {
    if (typeof window.Peer !== 'function') {
      if (role === 'viewer') viewerFatal('This browser cannot open the presentation (WebRTC unavailable).');
      else toast('This browser cannot share a screen (WebRTC unavailable).', 'error');
      return null;
    }
    var id = randomId(role === 'host' ? HOST_PREFIX : VIEWER_PREFIX);
    var peer = new window.Peer(id, { debug: 0, config: { iceServers: ICE_SERVERS } });
    S.peer = peer;
    S.peerId = id;
    S.peerOpen = false;

    peer.on('open', function (openId) {
      S.peerId = openId;
      S.peerOpen = true;
      S.peerAttempts = 0;
      if (role === 'host') {
        setConn('ready');
        if (S.live) {
          refreshShareHub();
          // Clear a stale 'server unreachable' warning once signalling is back.
          if (S.shareStatusWarning) setShareStatus('Copy the link and send it to your client.', 'info');
        }
      } else {
        connectToHost();
      }
    });

    peer.on('disconnected', function () {
      S.peerOpen = false;
      if (role === 'host') setConn('offline');
      window.setTimeout(function () {
        if (S.peer && !S.peer.destroyed) { try { S.peer.reconnect(); } catch (err) { /* retry on next idle */ } }
      }, 1200);
    });

    peer.on('error', function (err) { onPeerError(err, role); });

    if (role === 'host') {
      setConn('connecting');
      peer.on('connection', onViewerConnection);
    } else {
      peer.on('call', onIncomingCall);
    }
    return peer;
  }

  function onPeerError(err, role) {
    var type = err && err.type;

    if (type === 'unavailable-id') {
      S.peerAttempts++;
      if (S.peerAttempts <= MAX_ID_ATTEMPTS) {
        try { S.peer.destroy(); } catch (e) { /* fine */ }
        S.peer = null;
        createPeer(role);
        return;
      }
    }

    if (type === 'peer-unavailable') {
      if (role === 'viewer') viewerFatal('That link is not live. Ask the host for a fresh one.');
      return;
    }

    if (type === 'browser-incompatible') {
      if (role === 'viewer') viewerFatal('This browser cannot play the presentation.');
      else toast('This browser cannot share a screen. Try Chrome, Edge or Safari.', 'error');
      return;
    }

    if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
      if (role === 'host') {
        setConn('error');
        setShareStatus('Signalling server unreachable. Retrying…', 'warn');
      } else {
        viewerFatal('Could not reach the presentation service. Check your connection.');
      }
      return;
    }

    if (window.console) window.console.warn('peer error', err);
  }

  function startHostSession() {
    S.role = 'host';
    document.body.setAttribute('data-role', 'host');
    hide($('viewer-root'));
    show($('host-root'));

    createPeer('host');

    var buttons = document.querySelectorAll('.mode');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () {
        startPresentation(this.getAttribute('data-mode'), false);
      });
    }

    var demoBtn = $('demo-btn');
    if (demoBtn) demoBtn.addEventListener('click', function () { startPresentation('screen-mic-cam', true); });

    var copyBtn = $('copy-btn');
    if (copyBtn) copyBtn.addEventListener('click', function () { copyLink(true); });

    var stopBtn = $('stop-btn');
    if (stopBtn) stopBtn.addEventListener('click', function () { endSession('stopped'); });

    var restartBtn = $('restart-btn');
    if (restartBtn) restartBtn.addEventListener('click', function () { location.reload(); });

    var linkField = $('share-link');
    if (linkField) {
      linkField.addEventListener('focus', function () { this.select(); });
      linkField.addEventListener('click', function () { this.select(); });
    }

    // Closing the tab mid-session should end the show for viewers rather than
    // leave them staring at a frozen frame.
    window.addEventListener('pagehide', function () {
      if (!S.live) return;
      for (var id in S.viewers) {
        if (!Object.prototype.hasOwnProperty.call(S.viewers, id)) continue;
        try { S.viewers[id].conn.send({ type: 'bye' }); } catch (err) { /* leaving anyway */ }
      }
    });
  }

  function setModeButtonsBusy(busy, pendingMode) {
    var buttons = document.querySelectorAll('.mode');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      btn.disabled = busy;
      var isPending = busy && pendingMode && btn.getAttribute('data-mode') === pendingMode;
      btn.classList.toggle('is-pending', !!isPending);
    }
  }

  function startPresentation(mode, demo) {
    if (S.live || S.started) return;
    mode = MODES[mode] ? mode : 'screen';
    S.started = true;

    primeAudio(); // unlocks audio while the click is still fresh
    setModeButtonsBusy(true, demo ? null : mode);
    if (demo) toast('Demo screen starting. Share the link to see it as a viewer.', 'info');

    var onReady = function (media) {
      S.mode = mode;
      S.demo = !!demo;
      S.media = media;
      S.main = media.main;
      S.pip = media.pip || null;
      S.live = true;
      S.startedAt = Date.now();
      setModeButtonsBusy(false, null);
      goLive();
    };

    var onFail = function (err) {
      S.started = false;
      setModeButtonsBusy(false, null);
      if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        toast('Screen sharing was cancelled.', 'info');
      } else if (err && err.name === 'NotReadableError') {
        toast('The screen could not be captured. Close other sharing apps and try again.', 'error');
      } else {
        toast('Could not start sharing: ' + ((err && err.message) || 'unknown error'), 'error');
      }
    };

    if (demo) acquireDemo(mode, onReady);
    else acquireCapture(mode, onReady, onFail);
  }

  function goLive() {
    hide($('setup-screen'));
    hide($('ended-screen'));
    show($('dashboard'));

    var chip = $('mode-chip');
    if (chip) chip.textContent = MODES[S.mode].label + (S.demo ? ' · demo' : '');

    var preview = $('local-preview');
    if (preview) {
      preview.srcObject = S.main;
      var p = preview.play();
      if (p && p.catch) p.catch(function () { /* muted autoplay is normally fine */ });
    }

    renderLocalPip();
    bindScreenEnded();
    updateViewerPill();
    requestWakeLock();
    refreshShareHub();
    startHealthPolling();

    var url = shareUrl();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      // The OS picker usually eats the transient activation, so this is
      // best effort only. The Copy button is the guaranteed path.
      navigator.clipboard.writeText(url).then(function () {
        setShareStatus('Link copied. Paste it to your client.', 'ok');
      }, function () {
        setShareStatus('Copy the link and send it to your client.', 'info');
      });
    } else {
      setShareStatus('Copy the link and send it to your client.', 'info');
    }
  }

  // Local camera preview inside the stage, styled inline so this file does
  // not depend on the stylesheet's stage rules.
  function renderLocalPip() {
    var stage = document.querySelector('.stage');
    if (!stage || !S.pip) return;
    var existing = document.getElementById('local-pip');
    if (existing) existing.parentNode.removeChild(existing);
    var el = document.createElement('video');
    el.id = 'local-pip';
    el.muted = true;
    el.autoplay = true;
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.srcObject = S.pip;
    stage.appendChild(el);
    var p = el.play();
    if (p && p.catch) p.catch(function () { /* fine */ });
  }

  function bindScreenEnded() {
    if (!S.main) return;
    var video = S.main.getVideoTracks()[0];
    if (!video) return;
    video.onended = function () { endSession('stopped'); };
  }

  function shareUrl() {
    var base = location.origin + location.pathname;
    return base + '?room=' + encodeURIComponent(S.peerId || '');
  }

  function refreshShareHub() {
    var url = shareUrl();
    S.shareUrl = url;

    var field = $('share-link');
    if (field && field.value !== url) field.value = url;

    var sms = $('sms-link');
    var mail = $('email-link');
    var body = 'Watch my screen: ' + url;
    if (sms) sms.setAttribute('href', 'sms:?&body=' + encodeURIComponent(body));
    if (mail) {
      mail.setAttribute('href', 'mailto:?subject=' + encodeURIComponent('Watch my screen') +
        '&body=' + encodeURIComponent(body + '\n\nOpen it on any device. No app, no account.'));
    }

    renderQr(url);
  }

  function renderQr(url) {
    var holder = $('qr-code');
    if (!holder) return;
    holder.innerHTML = '';
    if (typeof window.QRCode !== 'function' || !url) {
      var figure = holder.closest ? holder.closest('.qr') : null;
      if (figure) hide(figure);
      return;
    }
    try {
      new window.QRCode(holder, {
        text: url,
        width: 200,
        height: 200,
        colorDark: '#101b26',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel ? window.QRCode.CorrectLevel.M : 0
      });
    } catch (err) {
      if (window.console) window.console.warn('qr render failed', err);
    }
  }

  function copyLink(manual) {
    var url = S.shareUrl || shareUrl();
    var field = $('share-link');
    var fallback = function () {
      if (!field) return false;
      field.focus();
      field.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      return ok;
    };
    var succeed = function () {
      setShareStatus('Link copied. Paste it to your client.', 'ok');
      if (manual) toast('Link copied.', 'info');
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(url).then(succeed, function () {
        if (fallback()) succeed();
        else if (manual) setShareStatus('Press Ctrl/Cmd + C to copy the selected link.', 'warn');
      });
    }
    if (fallback()) { succeed(); return; }
    if (manual) setShareStatus('Press Ctrl/Cmd + C to copy the selected link.', 'warn');
  }

  /* ------------------------------------------------------------------ */
  /* Host: viewers                                                      */
  /* ------------------------------------------------------------------ */

  function onViewerConnection(conn) {
    var meta = conn.metadata || {};
    if (meta.role !== 'viewer') {
      try { conn.close(); } catch (err) { /* ignore */ }
      return;
    }

    var registered = false;

    conn.on('open', function () {
      if (registered) return;
      registered = true;
      S.viewers[conn.peer] = {
        conn: conn,
        calls: {},
        strikes: 0,
        quiet: 0,
        hadCalls: false,
        lastSeen: Date.now(),
        joinedAt: Date.now()
      };
      updateViewerPill();
      chime('join');
      toast(viewerCount() === 1 ? 'Your first viewer joined.' : 'Another viewer joined.', 'join');
      callViewer(conn.peer);
    });

    conn.on('data', function (data) {
      var entry = S.viewers[conn.peer];
      if (entry) entry.lastSeen = Date.now();
      if (!data) return;
      if (data.type === 'ping') {
        try { conn.send({ type: 'pong', t: data.t, viewers: viewerCount() }); } catch (err) { /* ignore */ }
      } else if (data.type === 'bye') {
        // A viewer closing its tab says goodbye, so the count drops at once
        // instead of waiting for the connection to time out.
        dropViewer(conn.peer, 'left');
      }
    });

    conn.on('close', function () { if (registered) dropViewer(conn.peer, 'left'); });
    conn.on('error', function () { if (registered) dropViewer(conn.peer, 'error'); });
  }

  function viewerCount() {
    var n = 0;
    for (var k in S.viewers) if (Object.prototype.hasOwnProperty.call(S.viewers, k)) n++;
    return n;
  }

  function callViewer(viewerId) {
    var entry = S.viewers[viewerId];
    if (!entry || !S.peer || S.peer.destroyed) return;
    var pairs = [['main', S.main], ['pip', S.pip]];
    for (var i = 0; i < pairs.length; i++) {
      var type = pairs[i][0];
      var stream = pairs[i][1];
      if (!stream || !stream.getTracks().length) continue;
      var call = null;
      try {
        call = S.peer.call(viewerId, stream, { metadata: { type: type, room: S.peerId, mode: S.mode } });
      } catch (err) {
        if (window.console) window.console.warn('call failed', err);
      }
      if (!call) continue;
      entry.hadCalls = true;
      entry.calls[type] = call;
      (function (t, c) {
        c.on('close', function () { deleteCall(viewerId, t); });
        c.on('error', function () { deleteCall(viewerId, t); });
      })(type, call);
    }
  }

  function deleteCall(viewerId, type) {
    var entry = S.viewers[viewerId];
    if (!entry) return;
    if (entry.calls[type]) {
      try { entry.calls[type].close(); } catch (err) { /* already closed */ }
      delete entry.calls[type];
    }
    // Every media path to this viewer is gone, so treat them as gone.
    if (entry.hadCalls && openCallCount(entry) === 0) dropViewer(viewerId, 'media');
  }

  function openCallCount(entry) {
    var n = 0;
    for (var k in entry.calls) if (Object.prototype.hasOwnProperty.call(entry.calls, k)) n++;
    return n;
  }

  function dropViewer(viewerId, why) {
    var entry = S.viewers[viewerId];
    if (!entry) return;
    delete S.viewers[viewerId];

    for (var type in entry.calls) {
      if (!Object.prototype.hasOwnProperty.call(entry.calls, type)) continue;
      try { entry.calls[type].close(); } catch (err) { /* ignore */ }
    }
    try { entry.conn.close(); } catch (err) { /* ignore */ }

    updateViewerPill();
    if (why === 'left' || why === 'media' || why === 'timeout') {
      chime('leave');
      toast('A viewer left.', 'leave');
    }
  }

  function updateViewerPill() {
    var pill = $('viewers-pill');
    var label = $('viewers-label');
    var hint = $('stage-hint');
    var n = viewerCount();

    if (pill) {
      pill.setAttribute('data-state', n === 0 ? 'empty' : (n === 1 ? 'live' : 'multi'));
      if (label) {
        label.textContent = n === 0
          ? 'No viewers yet'
          : n + ' ' + plural(n, 'viewer') + (n === 1 ? ' watching' : ' watching');
      }
    }
    if (hint) {
      hint.textContent = n === 0
        ? 'This is what viewers see. Send the link to invite someone.'
        : (n === 1 ? 'This is what your viewer sees.' : 'This is what your ' + n + ' viewers see.');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Host: health polling                                               */
  /* ------------------------------------------------------------------ */

  function startHealthPolling() {
    if (S.healthTimer) window.clearInterval(S.healthTimer);
    S.healthTimer = window.setInterval(pollHealth, HEALTH_INTERVAL);
  }

  function pollHealth() {
    if (S.role !== 'host' || !S.live) return;
    var visible = document.visibilityState !== 'hidden';
    var now = Date.now();

    for (var id in S.viewers) {
      if (!Object.prototype.hasOwnProperty.call(S.viewers, id)) continue;
      var entry = S.viewers[id];

      // Quiet viewers: the data channel is the fast signal, but timers get
      // throttled in hidden tabs, so only trust a timeout while visible.
      if (visible && now - entry.lastSeen > VIEWER_TIMEOUT) {
        entry.quiet++;
        if (entry.quiet >= TIMEOUT_STRIKES) { dropViewer(id, 'timeout'); continue; }
      } else {
        entry.quiet = 0;
      }

      // Dirty network drops: 'close' never fires, iceConnectionState does.
      for (var type in entry.calls) {
        if (!Object.prototype.hasOwnProperty.call(entry.calls, type)) continue;
        var call = entry.calls[type];
        var pc = call.peerConnection;
        var ice = (pc && pc.iceConnectionState) || 'closed';
        if (ice === 'failed' || ice === 'closed') {
          entry.strikes++;
          deleteCall(id, type);
          if (!S.viewers[id]) break;
        } else if (ice === 'disconnected') {
          entry.strikes++;
          if (entry.strikes > ICE_GRACE_STRIKES) { deleteCall(id, type); if (!S.viewers[id]) break; }
        } else if (ice === 'connected' || ice === 'completed') {
          entry.strikes = 0;
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Host: teardown                                                     */
  /* ------------------------------------------------------------------ */

  function endSession(reason) {
    if (S.role !== 'host') return;
    var wasLive = S.live;
    var count = viewerCount();
    var elapsed = S.startedAt ? Date.now() - S.startedAt : 0;

    S.live = false;

    if (S.healthTimer) { window.clearInterval(S.healthTimer); S.healthTimer = null; }

    // Tell viewers first so they show an ending message instead of stalling.
    for (var id in S.viewers) {
      if (!Object.prototype.hasOwnProperty.call(S.viewers, id)) continue;
      var entry = S.viewers[id];
      try { entry.conn.send({ type: 'bye' }); } catch (err) { /* ignore */ }
      for (var type in entry.calls) {
        if (!Object.prototype.hasOwnProperty.call(entry.calls, type)) continue;
        try { entry.calls[type].close(); } catch (err) { /* ignore */ }
      }
      try { entry.conn.close(); } catch (err) { /* ignore */ }
    }
    S.viewers = {};

    if (S.media && S.media.dispose) { try { S.media.dispose(); } catch (err) { /* ignore */ } }
    stopStream(S.main);
    stopStream(S.pip);
    S.main = null;
    S.pip = null;
    S.media = null;

    if (S.peer && !S.peer.destroyed) { try { S.peer.destroy(); } catch (err) { /* ignore */ } }
    S.peer = null;
    S.peerOpen = false;

    releaseWakeLock();

    var preview = $('local-preview');
    if (preview) preview.srcObject = null;
    var pipPreview = $('local-pip');
    if (pipPreview && pipPreview.parentNode) pipPreview.parentNode.removeChild(pipPreview);

    hide($('dashboard'));
    show($('ended-screen'));
    var title = $('ended-title');
    var summary = $('ended-summary');
    if (title) title.textContent = wasLive ? 'Presentation ended' : 'Nothing was shared';
    if (summary) {
      summary.textContent = count > 0
        ? 'You shared for ' + humanDuration(elapsed) + ' and ' + count + ' ' + plural(count, 'viewer') + ' watched.'
        : 'Nobody opened the link this time.';
    }
    if (wasLive) toast('Sharing stopped.', 'leave');
  }

  /* ------------------------------------------------------------------ */
  /* Viewer                                                             */
  /* ------------------------------------------------------------------ */

  function startViewerSession(room) {
    S.role = 'viewer';
    S.room = room;
    document.body.setAttribute('data-role', 'viewer');
    document.title = 'Watching a screen share · fast_screen_share';
    hide($('host-root'));
    show($('viewer-root'));

    setViewerOverlay('connecting', 'Connecting to the presentation…', 'Waiting for the host.', false);
    createPeer('viewer');

    var fsBtn = $('viewer-fs-btn');
    if (fsBtn) fsBtn.addEventListener('click', toggleFullscreen);

    var audioBtn = $('viewer-audio-btn');
    if (audioBtn) audioBtn.addEventListener('click', function () {
      var screen = $('viewer-screen');
      if (!screen) return;
      screen.muted = !screen.muted;
      syncAudioButton();
      if (!screen.muted) { var p = screen.play(); if (p && p.catch) p.catch(function () {}); }
    });

    var joinBtn = $('join-btn');
    if (joinBtn) joinBtn.addEventListener('click', tapToJoin);

    var retry = $('viewer-retry');
    if (retry) retry.addEventListener('click', function () { location.reload(); });

    var bar = $('viewer-bar');
    if (bar) {
      ['pointermove', 'pointerdown', 'touchstart', 'keydown'].forEach(function (evt) {
        document.addEventListener(evt, wakeViewerBar, { passive: true });
      });
      scheduleBarDim();
    }

    window.addEventListener('pagehide', function () {
      if (!S.conn) return;
      try { if (S.conn.open) S.conn.send({ type: 'bye' }); } catch (err) { /* leaving anyway */ }
      try { S.conn.close(); } catch (err) { /* ignore */ }
    });
  }

  function connectToHost() {
    if (!S.peer || !S.room) return;
    var conn = null;
    try {
      conn = S.peer.connect(S.room, { metadata: { role: 'viewer' }, reliable: true });
    } catch (err) {
      viewerFatal('Could not open the connection. Reload and try again.');
      return;
    }
    if (!conn) { viewerFatal('Could not open the connection. Reload and try again.'); return; }

    S.conn = conn;

    conn.on('open', function () {
      S.lastPong = Date.now();
      setViewerOverlay('waiting', 'Connected. Waiting for the host…', 'The host is starting the share.', false);
      startPinging();
    });

    conn.on('data', function (data) {
      if (!data) return;
      if (data.type === 'pong') {
        S.lastPong = Date.now();
        S.unstableWarned = false;
      } else if (data.type === 'bye') {
        viewerEnded('The host ended the presentation.');
      }
    });

    conn.on('close', function () { viewerEnded('The host connection closed.'); });
    conn.on('error', function () { viewerEnded('The host connection dropped.'); });
  }

  function startPinging() {
    if (S.pingTimer) window.clearInterval(S.pingTimer);
    S.pingTimer = window.setInterval(function () {
      if (!S.conn || !S.conn.open) return;
      try { S.conn.send({ type: 'ping', t: Date.now() }); } catch (err) { /* ignore */ }
      if (S.lastPong && Date.now() - S.lastPong > PONG_GRACE && !S.unstableWarned) {
        S.unstableWarned = true;
        toast('The connection to the host looks unstable.', 'error');
      }
    }, PING_INTERVAL);
  }

  function setViewerOverlay(kind, state, sub, showJoin) {
    var overlay = $('viewer-overlay');
    var stateEl = $('viewer-state');
    var subEl = $('viewer-sub');
    var join = $('join-btn');
    var retry = $('viewer-retry');
    var spinner = $('viewer-spinner');
    if (stateEl) stateEl.textContent = state || '';
    if (subEl) subEl.textContent = sub || '';
    if (join) join.hidden = !showJoin;
    if (retry) retry.hidden = kind !== 'error' && kind !== 'ended';
    if (spinner) spinner.hidden = kind !== 'connecting' && kind !== 'waiting';
    if (overlay) {
      show(overlay);
      // Soft scrim while the picture is already playing behind the prompt.
      overlay.classList.toggle('overlay--soft', kind === 'tap');
    }
    if (kind === 'tap') S.needsTap = true;
  }

  function hideViewerOverlay() {
    var overlay = $('viewer-overlay');
    if (overlay) hide(overlay);
    S.needsTap = false;
  }

  function onIncomingCall(call) {
    var type = (call.metadata && call.metadata.type) || 'main';
    // One-way media: answer without sending anything back.
    try { call.answer(); } catch (err) {
      if (window.console) window.console.warn('answer failed', err);
    }
    call.on('stream', function (stream) { attachStream(type, stream); });
    call.on('close', function () {
      if (type === 'pip') { hide($('viewer-pip')); }
      else if (!S.ended) viewerEnded('The host stopped sharing.');
    });
    call.on('error', function () { /* the data channel reports the drop */ });
  }

  function attachStream(type, stream) {
    if (type === 'pip') {
      var pip = $('viewer-pip');
      if (!pip) return;
      pip.srcObject = stream;
      show(pip);
      var pp = pip.play();
      if (pp && pp.catch) pp.catch(function () { /* muted, normally allowed */ });
      return;
    }

    var screen = $('viewer-screen');
    if (!screen) return;
    S.hasAudio = stream.getAudioTracks().length > 0;
    screen.srcObject = stream;

    var live = $('viewer-live');
    if (live) show(live);
    requestWakeLock();
    scheduleBarDim();

    // Muted playback is always allowed, so the picture is visible even
    // while we wait for the tap that unlocks the audio.
    screen.muted = S.hasAudio;
    var p = screen.play();
    if (p && p.catch) p.catch(function () { /* wait for the tap */ });

    if (S.hasAudio) {
      syncAudioButton();
      setViewerOverlay('tap', 'Your presentation is ready', 'Tap once to join with sound.', true);
    } else {
      hideViewerOverlay();
      var audioBtn = $('viewer-audio-btn');
      if (audioBtn) hide(audioBtn);
    }
  }

  function tapToJoin() {
    primeAudio();
    requestWakeLock();
    var screen = $('viewer-screen');
    if (!screen) return;
    screen.muted = false;
    screen.volume = 1;
    var done = function () {
      S.tapDone = true;
      syncAudioButton();
      hideViewerOverlay();
      toast('You are watching live.', 'join');
    };
    var p = screen.play();
    if (p && p.catch) {
      p.then(done, function () {
        setViewerOverlay('tap', 'One more tap', 'Your browser blocked sound. Tap to join again.', true);
      });
    } else {
      done();
    }
  }

  function syncAudioButton() {
    var btn = $('viewer-audio-btn');
    var screen = $('viewer-screen');
    if (!btn || !screen) return;
    show(btn);
    var soundOn = !screen.muted;
    btn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
    btn.title = soundOn ? 'Sound off' : 'Sound on';
    btn.textContent = soundOn ? 'Sound' : 'Muted';
  }

  function viewerFatal(message) {
    setViewerOverlay('error', message, 'Then ask the host to send a fresh link.', false);
    var spinner = $('viewer-spinner');
    if (spinner) hide(spinner);
  }

  function viewerEnded(message) {
    if (S.ended) return;
    S.ended = true;
    if (S.pingTimer) { window.clearInterval(S.pingTimer); S.pingTimer = null; }
    var live = $('viewer-live');
    if (live) hide(live);
    var pip = $('viewer-pip');
    if (pip) { pip.srcObject = null; hide(pip); }
    var screen = $('viewer-screen');
    if (screen) screen.srcObject = null;
    releaseWakeLock();
    setViewerOverlay('ended', 'Presentation ended', message, false);
  }

  function toggleFullscreen() {
    var root = $('viewer-root');
    var screen = $('viewer-screen');
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } else if (root && root.requestFullscreen) {
        root.requestFullscreen();
      } else if (screen && screen.webkitEnterFullscreen) {
        screen.webkitEnterFullscreen();
      }
    } catch (err) { /* the browser said no */ }
  }

  function scheduleBarDim() {
    var bar = $('viewer-bar');
    if (!bar) return;
    if (S.dimTimer) window.clearTimeout(S.dimTimer);
    bar.classList.remove('is-dim');
    S.dimTimer = window.setTimeout(function () { bar.classList.add('is-dim'); }, 3800);
  }

  function wakeViewerBar() {
    if ($('viewer-overlay') && !$('viewer-overlay').hidden) return;
    scheduleBarDim();
  }

  /* ------------------------------------------------------------------ */
  /* Wake lock                                                          */
  /* ------------------------------------------------------------------ */

  function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (document.visibilityState !== 'visible') return;
    if (S.wakeLock) return;
    try {
      navigator.wakeLock.request('screen').then(function (lock) {
        S.wakeLock = lock;
        lock.addEventListener('release', function () { S.wakeLock = null; });
      }, function () { /* denied, not important */ });
    } catch (err) { /* unsupported */ }
  }

  function releaseWakeLock() {
    if (!S.wakeLock) return;
    try { S.wakeLock.release(); } catch (err) { /* ignore */ }
    S.wakeLock = null;
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                               */
  /* ------------------------------------------------------------------ */

  function boot() {
    var params = new URLSearchParams(location.search);
    var room = params.get('room');

    if (!isSecure()) show($('insecure-banner'));

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
        if (S.role === 'host' && S.live) pollHealth();
      }
    });

    if (room) {
      startViewerSession(room);
      return;
    }

    startHostSession();

    if (params.get('start') === '1') {
      var first = document.querySelector('.mode');
      if (first) {
        try { first.focus({ preventScroll: false }); } catch (err) { first.focus(); }
      }
      toast('Pick a presentation mode to get your link.', 'info');
    }

    if (params.get('demo') === '1') {
      var wants = params.get('mode');
      var mode = MODES[wants] ? wants : 'screen-mic-cam';
      // Wait for the signaller so the room id is final before going live.
      var tries = 0;
      var wait = window.setInterval(function () {
        tries++;
        if (S.peerOpen || tries > 40) {
          window.clearInterval(wait);
          startPresentation(mode, true);
        }
      }, 150);
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && !isSecure()) return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        if (window.console) window.console.warn('service worker registration failed', err);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); registerServiceWorker(); });
  } else {
    boot();
    registerServiceWorker();
  }
})();
