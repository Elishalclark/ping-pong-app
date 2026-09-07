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
3. **Tap Start**, then **place the box**. Point the phone at the empty table
   and either tap **📷 Take photo of table** (it guesses the table is in the
   middle of the frame) or — more reliably — just **tap the table** in the
   picture. Tapping seeds the scan from that exact spot and colour, so it works
   even when the table is off to one side or the floor is a similar colour.
   Check the box, correct any corner by dragging, then **Use this box**. You
   can always place the box entirely by hand: drag its middle to move it, a
   corner to reshape it. A magnifier appears under your finger so you can place
   a corner precisely. **Swap ends** flips which end is Player A's. Tap
   **Done** when it fits. Each half is labelled **A** and **B** in the same
   colours as the scoreboard, so you can see at a glance whose end is whose.
   The box is what tells the referee where the table is, and it stays
   draggable afterwards — nudge a corner rather than starting over.
4. **Begin match.** The ball marker only appears once a match is running —
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
- **`js/rules.js` is the rulebook**, a pure state machine with no knowledge of
  cameras or microphones, driven entirely by those physical events. It's the
  part that's fully covered by tests (`npm test`).

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
