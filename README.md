# Umpire — a ping pong referee that watches and listens

A phone app (in the browser — nothing to install) that you prop up beside the
table. It watches through the camera, listens for the ball through the
microphone, and calls the match: services, double bounces, volleys, net cords,
balls out, scoring, service rotation, games and match.

**Every rally ends with the score**, shown on the call banner and spoken the
way an umpire calls it: "Point A. 5, 3. A to serve." A service fault or a let
is named as one before the number — "Fault on the service, A. Point B. 0, 1.
A to serve." and "Let on the service. Serve again." — so the players know why
the rally stopped. Every call is also written to a play log with a confidence
figure, and can be overridden or undone with a thumb. The app goes deaf while
it is speaking, so it never mistakes its own voice for the ball.

It is built for a phone first: portrait and landscape layouts, tap-and-drag
table calibration with a magnifier, a screen that won't sleep mid-match, and
it installs to the home screen and runs offline.

**Live at <https://elishalclark.github.io/ping-pong-app/>** — open it on your
phone, allow the camera and microphone, and calibrate the table.

## Getting it onto your phone

The camera and microphone only work in a **secure context**: `http://localhost`
counts, anything else needs HTTPS. That's the one hurdle to running it on a
phone, and there are two ways over it.

**From your own machine, over your network:**

```sh
npm run start:https
```

It prints a `https://<your-ip>:8080` address. Open that on the phone, on the
same Wi-Fi, and accept the self-signed certificate warning. (It generates the
certificate itself, so `openssl` needs to be on your PATH.)

**Or host it.** The whole app is static files, so any static host works —
GitHub Pages, Netlify, Cloudflare Pages. In this repo: Settings → Pages →
deploy from the branch, and the URL it gives you works on any phone, anywhere.

**On a laptop**, `npm start` and open `http://localhost:8080`.

```sh
npm test           # rules engine tests
```

There is no build step and no runtime dependencies — ES modules served straight
to the browser.

Once it's open, tap **Add Umpire to your home screen** in Setup (or use the
browser's Share → Add to Home Screen on iOS). It then launches fullscreen with
no browser bars, and works with no signal at all.

## Setting up before a match

1. **Prop the phone side-on to the table**, roughly level with the surface, a
   couple of metres back, in landscape. It needs to see both halves and both
   players, and the closer it is, the better it hears. A cheap phone tripod or
   a bag to lean it against is enough.
2. **Keep it near the table.** Hearing the ball matters more than seeing it.
   The app deliberately turns off the browser's noise suppression, echo
   cancellation and auto gain — phones enable all three by default, and all
   three are designed to remove exactly the kind of short click a ball makes.
3. **Tap Start**, then **Calibrate**. With the whole table in frame, the app
   looks for it itself — a table is a big, roughly uniform surface unlike
   anything else in the shot, and that's enough to find its four corners
   without being told where they are. There is no box to place by hand as a
   first step; a box appears already sitting on the table.
4. **Check it, don't just trust it.** Automatic detection can be thrown off
   by glare, clutter, or a table colour close to the floor's, so glance at the
   box before tapping **Use this box**. If a corner is off, **drag it** onto
   the table's actual corner — a magnifier appears under your finger so you
   can place it precisely — or drag the middle of the box to slide the whole
   thing into position. **Swap ends** flips which end is Player A's; each
   half is labelled **A** and **B** in the scoreboard's colours. If nothing
   was found at all (the hint says so), **tap the table** in the picture to
   scan from exactly that point, tap **🔄 Rescan** to try again, or place all
   four corners by hand — the box is always there and always draggable, a
   fallback rather than a lesser version of the automatic scan.
5. **Begin match.** The ball marker only appears once a match is running —
   before that there is nothing for it to track, and showing it would just
   chase movement around the room. Keep the app in the foreground: a backgrounded phone stops
   the camera and microphone, and the app will tell you that play went
   unjudged rather than pretend otherwise. If the picture ever goes black — a
   few phones reclaim the camera when the app speaks a call — the tracker
   re-acquires it automatically within a second, so you do not have to restart.

Tune under *Detection settings* if calls are being missed or invented:

| Setting | Raise it when | Lower it when |
| --- | --- | --- |
| Bounce sensitivity | Room noise is triggering phantom bounces | Real bounces are being missed |
| Noise gate | There's constant background hum | Quiet bounces aren't registering |
| Tracking strictness | The marker wanders onto arms/shirts | The ball isn't being tracked at all (default is 20%, leaning toward tracking) |
| Ball motion threshold | Shirts and arms are stealing the track | The ball is lost mid-rally |
| Audio/video sync window | Sounds aren't being matched to the ball | Sounds are matched to the wrong moment |

The four umpire controls — Point A, Point B, Let, Undo — stay on screen in
both orientations. On a laptop, `A` / `B` award a point, `L` calls a let and
`U` undoes.

The whole interface fits one screen, from a small phone up to a tablet:
nothing that matters mid-match is ever a scroll away. On a tablet the picture
and the type both get bigger rather than the layout just stretching.

Battery and heat are real: tracking every frame with the screen held awake is
demanding. A phone will get warm over a long match, so plug it in if you can.
The tracker measures its own cost per frame and quietly lowers its processing
resolution if the phone can't keep up, because a dropped frame loses the ball
entirely while a coarser frame usually doesn't.

## How it decides

The two sensors answer different questions, and neither is trusted alone.

- **The microphone answers *when*.** An AudioWorklet (`js/onset-processor.js`,
  wrapping `js/detector.js`) runs on the audio thread in 128-sample blocks, so
  a bounce is timestamped to within about 3 ms instead of to the nearest video
  frame — which matters more on a phone, where the main thread is busy. It
  flags any transient that jumps above an adapting noise floor, then measures
  the sound's zero-crossing rate and decay. A ball on the table is a bright,
  short click; a racket is lower and rings longer; a net touch is quiet and
  dull. Browsers too old for AudioWorklet (iOS before 14.5) fall back to a
  ScriptProcessor running the same detector with looser timing.
- **Scanning finds the table.** The table's colour is not assumed: whatever
  colour fills the frame around a seed point is the table, under whatever
  lighting the hall has. From that seed the scan grows the connected region of
  similar-colour pixels (compared by chromaticity plus a loose brightness band,
  so the shading across a real table doesn't split it), then cleans the region
  before fitting a box: **morphological closing** bridges the thin gaps the
  white net line and glare cut through the surface; **hole-filling** absorbs
  glare spots and the ball; **erosion** shaves the edge so a bleed into a
  similar-coloured floor doesn't push the corners out. Tapping the table seeds
  the scan exactly where you tapped; the button with no tap runs a grid of
  seeds and keeps the most table-shaped result, so it finds an off-centre
  table too. A region that spans the whole frame (a wall or floor filling the
  view) or that doesn't fill its box is rejected rather than guessed at. This
  handles a worn green table with a net line in a dim hall, or a red or grey
  club table, not just a vivid blue one. The scan frame doubles as the
  tracker's reference picture of the empty table.
- **The camera answers *where*.** `js/vision.js` learns a slow-moving
  background of the scene — the phone is stationary, so most of the picture is
  the same frame after frame — and scores each pixel of a downscaled frame by
  how far it stands out from that background, weighted by brightness. It takes
  the best small, round, compact cluster. Background subtraction beats simple
  frame differencing here for two reasons: differencing leaves a ghost where
  the ball *was* as well as where it is, and it loses the ball entirely
  whenever the ball slows down. Blobs that are too long and thin, or too
  sparse, are rejected as arms and shirt edges.
- **Colour is how it follows the ball and not everything else.** Motion and
  brightness are shared by arms, shirts and shadows, but a regulation ball is
  white or orange and nothing else on the table is. Every candidate blob is
  measured against the ball's colour and rejected outright if it doesn't match:
  white is bright and nearly colourless (skin and wood are more saturated),
  orange is a vividly saturated warm hue (skin shares the hue but not the
  saturation). Set the ball colour in **Setup → Ball** — White or Orange — or
  tap **sample its colour** and then tap the ball in the picture for an exact
  match under your lighting. This is the single biggest reason the tracker
  stays on the ball rather than the nearest moving arm.
- **More than colour separates the ball out.** Colour is the strongest cue,
  but three others stack on top of it: **true roundness** (the pixel covariance
  measures roundness in every direction, so a diagonal streak or an arm edge
  that fooled the bounding box is rejected); the ball's **known size** at each
  point on the table from the calibrated geometry; and, once locked on, the
  ball's **own learned colour** — the tracker records the actual ball's colour
  the moment it confirms and matches that specific colour from then on, tighter
  than the white/orange preset and adapted to the exact ball and lighting,
  reverting to the preset the instant the ball is lost.
- **Only a round, ball-like blob is tracked — and blur is the one exception.**
  Roundness cannot simply be demanded, because a fast ball smears into a
  streak. But it smears *along the direction it is travelling* and nowhere
  else, so elongation is allowed exactly to the extent that the blob's long
  axis lines up with where the ball is known to be going. Stretched across the
  flight, it cannot be motion blur — it is the arm that just hit the ball, a
  table line, or a shirt seam — and it is turned away. While the tracker is
  still acquiring there is no flight to compare against, so a genuinely round
  blob is required, which is exactly the moment false locks used to happen.
- **A speck is not a ball.** Blobs below a few pixels are rejected outright:
  they have no measurable shape and cannot be told from sensor noise. This
  matters more than it sounds, because the scoring used to *reward* being
  small — a leftover size prior from before the table geometry could say how
  big the ball must actually be. Combined with the fact that a degenerate blob
  trivially fills its own bounding box, a two-pixel speck outscored the real
  ball (22.4 against 14.7 at equal brightness), which is why the marker chased
  every glint and flicker on the table. With a calibrated table the geometry
  is the size prior, and the crude term is gone. The floor itself is tied to
  the ball's expected *area* at that spot on the table, not a flat pixel
  count: a fixed count is either too loose right in front of the camera
  (where a real ball is dozens of pixels across) or too tight at the far end
  (where it is only a handful) — scaling with the real disc's area at that
  position closes a coincidentally ball-sized speck out at every distance at
  once, without punishing a genuinely small, genuinely distant ball.
- **Physical motion — the ball flies, arms don't.** A struck ball moves fast
  and traces a smooth arc (constant horizontal speed, gravity pulling it down);
  a waving arm drifts slowly and a shadow jitters. A track confirms as the ball
  only if it is moving fast enough AND its recent path fits smooth
  constant-acceleration motion (measured as the residual of a least-squares
  quadratic fit over the last several positions — a straight glide is the
  zero-gravity case and fits too). Slow coherent drift and fast jitter are both
  turned away, and the fit quality feeds the tracker's confidence.
- **The marker only shows when it's genuinely locked on.** Tracking a small,
  fast, low-contrast ball from a single phone camera is at the edge of what a
  browser can do, so the tracker is deliberately conservative: a track is
  trusted only after four *coherent* detections in a row (a run that jumps
  around is noise and is discarded, not confirmed), a confirmed track never
  jumps to a far-off blob, and re-acquisition after a reversal requires a
  self-consistent little run rather than any single surprise. When the tracker
  is not sure, it draws nothing and the status shows "ball …" (searching)
  rather than "ball ●" (locked) — an honest blank beats a marker flailing
  around the room. This trades some missed tracking for not chasing arms,
  shadows and shirts.
- **A motion filter turns detections into a track.** Rather than snapping to
  wherever the detector fires each frame, positions feed a constant-velocity
  (alpha-beta) filter that estimates where the ball is *and how fast it is
  going*, smoothly. This buys three things that matter on a real rally:
  - **Distractors are gated out.** A detection far from where the ball is
    predicted to be is treated as a distractor and ignored, so a single stray
    blob can't hijack the track. But because the ball reverses on every paddle
    hit, a *run* of unexpected detections is read as a genuine change of
    course and the track re-seeds on it within two frames — the distinction is
    that coasting is for when the ball is not seen, not for when it is seen
    somewhere surprising.
  - **It coasts through occlusion.** When an arm briefly hides the ball, the
    track carries forward on its last velocity instead of dying at the first
    missed frame, and only gives up after a real gap.
  - **Bounces read cleanly.** The downward-to-upward flip is taken from the
    smoothed vertical velocity, which both misses fewer real bounces and
    invents far fewer from frame-to-frame jitter than a raw single-frame test.
  Position lookup for audio sync interpolates between the two frames that
  bracket the sound's timestamp, placing the ball where it actually was at
  that millisecond rather than at the nearest frame.
- **Size is what says "that is a ball".** Once the box is on the table the app
  knows the real thing is 2.74 m by 1.525 m, so it can work out how many
  pixels across a 40 mm ball must be at any point in the picture — smaller at
  the far end, larger near the camera. Anything appreciably bigger or smaller
  is not the ball, whatever else it looks like. Candidate pixels are grouped
  by actual connectivity for this: grouping them by proximity lets a large
  object fragment into several ball-sized pieces and walk straight through the
  size test.
- **It only looks where the ball can be.** The search is bounded by the
  out-of-bounds line, and the processing resolution is chosen from the
  geometry — enough that the ball is about three pixels across at the far end,
  and no more, because every extra pixel is battery.
- **`js/referee.js` fuses them.** When a transient arrives, it asks the tracker
  where the ball was at that instant. Inside the calibrated table quad, it's a
  bounce, and which side of the net line it fell on decides whose half. Outside
  the quad, it's a stroke. Near the net line and quiet, it's a net touch. **A
  sound with no ball behind it is discarded, not guessed at** — that is what
  keeps a dropped chair from awarding a point.
  "Near the net" is judged in the table's own top-down coordinates (the same
  homography the digital table view uses), not raw camera-frame distance: a
  fixed frame-space threshold meant something different every time the phone
  was set up differently, since the same physical inch near the net covers
  more of the frame when the table is closer and less when it's further back.
  Tied to the table's real length instead, the zone is the same width — about
  14 cm either side of the net — no matter how the phone happens to be
  framed, which is what made let calls unreliable before: with the table
  small in frame (a typical "couple of metres back" setup), the old check
  could call a bounce most of the way into a half a net touch.
- **`js/rules.js` is the rulebook**, a pure state machine with no knowledge of
  cameras or microphones, driven entirely by those physical events. It's the
  part that's fully covered by tests (`npm test`).

## Seeing where the ball is going

Two views sit on top of the tracking, both driven by the same locked-on
track and the calibrated table geometry — neither is a separate guess. Both
show the same two predicted **points**, not a line: where the ball will land,
and whether its path crosses the net's position before then. A straight line
run forward from the current velocity never actually lands anywhere, so it
was replaced with a curve fitted to the ball's last few real positions — the
same fit `_ballisticScore` already uses to tell a real flight from an arm's
jitter — and the point where that curve turns over (rises then falls, or
falls then rises) is the predicted landing point. A flat, uncurving path
correctly predicts no landing point at all, rather than inventing one.

- **On the camera view**, a crosshair marks a predicted net crossing and a
  ring marks the predicted landing spot — cyan if it lands on the table, red
  if it doesn't. Both disappear the instant there's nothing to predict from
  (the ball lost, or moving too straight to have a vertex ahead of it).
- **On the digital table**, the same two points are drawn again, mapped
  through the same homography as everything else there — so the landing
  point shown is where the ball will really land on the table, not where the
  camera's perspective makes it look like it will.
- **What "crosses the net" does and doesn't mean.** A single camera has no
  way to know how high above the table the ball is — that would need a
  second camera or a depth sensor — so the crossing point is a horizontal
  position claim only: the ball's path passes the net's position at that
  spot. It is not a claim that the ball clipped the net cord or cleared it
  clean; that distinction is still the microphone's to make, by hearing an
  actual net touch (see below).

The digital table appears the moment calibration finishes and stays in sync
with whatever the tracker is doing; there is nothing to turn on separately.

## Faults and rally points are not the same thing

A service error and a rally lost in play both cost the point, but an umpire
does not call them the same way, and neither does this app.

Every service error — the ball missing the server's own half, bouncing twice
on it, going into the net, leaving play before reaching the far half, or being
served out of turn — is called as a **fault**, named aloud as one ("Fault.
Point B. 1 all. B to serve."), shown in red, and **counted against the server**
in the scoreboard. Anything that happens once the ball is live is a rally
point, with no fault recorded.

A fault always belongs to whoever is serving, so the manual **Fault** button
needs no player chosen — it charges the current server. Undo restores the
fault count along with the score.

## The out-of-bounds line

The red dashed line around the table is the boundary. When the tracked ball
crosses it **on the way out**, the ball is out of play and the point is
decided.

It deliberately sits *outside* the table rather than on its edge, and that
distinction is the whole design:

- **Off the table is not out.** Players strike the ball from well behind the
  end line on nearly every rally, so a ball leaving the table outline means
  nothing on its own.
- **The direction matters.** Only a ball moving away from the table counts. A
  ball crossing the line inward is a player winding up for a shot.
- **Who it costs depends on what happened first.** If the ball had already
  bounced legally on the far half, the striker did everything asked of them
  and it is the receiver who let it go by. Only a ball that never landed is
  the striker's mistake.

Move the line with **Setup → Out-of-bounds line**: push it out if good shots
are being called out, pull it in if balls sail away uncalled. A sound heard
from beyond the line is treated as the ball hitting the floor, never as a
stroke.

## Two phones, one game

You can pair a second phone so each player's end has its own camera angle,
with one shared score between them. Under **Setup → Second phone**:

1. On one phone, tap **Host on this phone**. It shows a QR code.
2. On the **other** phone, scan that code with its **ordinary camera app** —
   no need to open the umpire app first. It's a real link: scanning it opens
   this page and lands on a dedicated "you've been invited" screen. Tap
   **Join this game**, allow the camera and microphone, and it shows a reply
   code.
3. Back on the **host**, tap **Scan their reply** and point the phone at
   that reply code.

That's the whole handshake — after it the two phones talk to each other
directly (WebRTC), with no server and no account. The **host's** camera and
microphone make the automatic calls; the **guest** mirrors the score and its
own camera is there for the guest to watch their end and use for manual
corrections, which route to the host and apply to the one shared game.
Point A / Point B / Let / Fault / Undo work from either phone.

**The two codes aren't scanned the same way, on purpose.** The host's
invite is a real, clickable URL — any camera app can read it, because
opening it is just opening a web page. The guest's reply is not a link: the
host's page has a live connection object in memory at that point, and
opening a link would load a fresh page that knows nothing about it. So that
second code is read through the app's own full-screen scanner (the button
labelled **Scan their reply**), not the phone's regular camera app. An
earlier version encoded both codes as plain data, which is what made some
phones' camera apps try to web-search the first code instead of opening it —
that's fixed now that it's an actual link.

Pairing needs both phones to see each other's screens once each way — after
that they can be repositioned anywhere on the same Wi-Fi, or even different
networks. If the connection drops, re-pair from the same panel.

**Two things that were fixed after not working in practice:**

- **The three libraries pairing depends on (drawing a QR, reading one back,
  and compressing the connection code) used to load from a CDN.** A phone
  on a school, workplace, or carrier network with a content filter — or a
  browser privacy mode, or an ad blocker — can silently block that kind of
  third-party script. When it does, pairing doesn't degrade gracefully, it
  just doesn't work, with no error to explain why. They're now bundled
  directly into the app (`js/vendor/`) instead, which removes that failure
  mode entirely. One of the three also turned out to have a real bug of its
  own: its browser-compatibility wrapper only handled two of the three ways
  a page can load a script, and silently did nothing on the third — the
  exact way this app was loading it. Fixed in the vendored copy
  (`js/vendor/README.md` has the details).
- **Two personal phones are very often on two different networks** — one on
  home Wi-Fi, one on cellular data, say — and without a relay server in the
  middle, that combination frequently can't find a direct path to each
  other at all: the handshake completes, the codes exchange fine, and the
  connection just never opens, silently. A relay (TURN) server is included
  as a fallback for exactly that case, alongside a TLS variant of it on
  port 443 specifically — to a restrictive network that one looks
  identical to ordinary HTTPS traffic, which is the transport most likely
  to get through where a plain relay connection gets blocked. A connection
  that hasn't come up within a few seconds now says so on screen instead of
  leaving both phones stuck on "Pairing… hold still." forever with nothing
  to go on, and if it ultimately fails, `PeerLink.diagnose()` (also on
  `window.umpire.link` in the browser console) reports the one fact that
  actually narrows the cause down: whether a relay connection was reached
  at all, which separates "this network is blocking the relay" from
  everything else it could be.

  Worth being straight about: the relay server is a shared, free public
  one, not something with an uptime guarantee, and I have no way to reach
  it — or the open internet at all — from the environment I develop in, so
  I cannot personally confirm it answers from any particular real network.
  If cross-network pairing still doesn't connect, the diagnostic above is
  how to find out why with certainty rather than guessing again: open the
  browser console on the phone that gave up and run
  `window.umpire.link.diagnose()` (Safari: Settings → Safari → Advanced →
  Web Inspector, then use a Mac to inspect the tab; Chrome: `chrome://inspect`
  from a computer on the same network). `relayCandidateGathered: false`
  means the relay was never reached — the fix then is either that network's
  own restriction, or a different (possibly paid, dedicated) relay, which I
  can wire in given credentials.

I've verified the complete flow end to end with the real vendored libraries
doing real work, not a stand-in for them: a host's QR is decoded by a real
camera-reading pass over the actual rendered image and comes back as a
well-formed URL; opening that URL shows the dedicated join screen; tapping
Join produces a reply code that a second real decode reads back correctly;
and the host accepting that reply brings both phones to a connected,
score-sharing state. What I still can't do from here is hold two physical
phones and point one's camera at the other's screen — lighting, glare, and
distance are real variables a simulation can't stand in for — so if anything
about that specific moment still feels off, tell me exactly what you see.

## What it gets right, and what it won't

Honest limits, because an umpire that hides them is worse than no umpire:

- **Height is invisible to one camera.** The app knows where the ball is in the
  picture, not how far above the table it is. It infers a bounce from the sound
  arriving while the ball is over the table. A ball passing over the table at
  the same moment as an unrelated click can be misread.
- **Edge balls are the hardest call in the sport** and this app is not reliable
  on them. The side of the table and the top edge sound similar, and at the
  table's edge a couple of pixels decide in or out.
- **The out-of-bounds line is a flat shape in a picture of a 3D room.** A ball
  passing high above the table on its way out crosses the line at a different
  image position than one skimming the surface. The line is a good practical
  approximation, not a court boundary.
- **A call that cannot be attributed is not made.** If the microphone hears
  bounces but misses the stroke that started the rally, the app says so in the
  log rather than guessing a player to award the point to.
- **Frame rate bounds everything.** At 30 fps a smashed ball moves most of the
  table's length between frames, and the tracker will drop it. 60 fps in good
  light is a different app from 30 fps in a dim hall.
- **Doubles service rotation is not implemented.** The doubles checkbox sets the
  flag but the engine still rotates service as for singles; use the manual
  controls.
- **A phone's single microphone is not a directional one.** It cannot tell a
  bounce on the far half from a similar click behind it; that separation comes
  entirely from the camera. In a noisy hall with several tables going, expect
  to correct calls.
- **It does not judge service legality** — throw height, open palm, ball behind
  the end line. Those need a calibrated view a single webcam doesn't give.

Treat it as an assistant that catches the routine calls and keeps score
reliably, with a human ready on the override buttons for the close ones. It is
not fit for officiating a match that matters.

## Layout

```
index.html              markup and controls
css/styles.css          mobile-first, with landscape and desktop layouts
js/main.js              UI, touch calibration, wake lock, haptics, spoken calls
js/vision.js            camera, table geometry, ball tracker, camera switching
js/audio.js             microphone, transient classification, iOS fallback
js/detector.js          the transient detector itself (shared by both paths)
js/onset-processor.js   AudioWorklet wrapper (runs on the audio thread)
js/referee.js           sensor fusion: sound + position -> physical event
js/rules.js             ITTF-style match state machine (tested)
test/rules.test.mjs
manifest.webmanifest    home-screen install
sw.js                   offline cache, for halls with no signal
server.mjs              static server, optional self-signed HTTPS
```
