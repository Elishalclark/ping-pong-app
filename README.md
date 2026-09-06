# Umpire — a ping pong referee that watches and listens

A phone app (in the browser — nothing to install) that you prop up beside the
table. It watches through the camera, listens for the ball through the
microphone, and calls the match: services, double bounces, volleys, net cords,
balls out, scoring, service rotation, games and match.

Every ruling is announced out loud, written to a play log with a confidence
figure, and can be overridden or undone with a thumb.

It is built for a phone first: portrait and landscape layouts, tap-and-drag
table calibration with a magnifier, a screen that won't sleep mid-match, and
it installs to the home screen and runs offline.

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
3. **Tap Start**, then **calibrate**: tap the four table corners in the order
   the prompt asks for, starting at Player A's end nearest you and going
   around the table. A magnifier appears under your finger so you can place a
   corner precisely, and every corner stays draggable afterwards — nudge one
   rather than starting over. This is what tells the referee which half is
   which.
4. **Begin match.** Keep the app in the foreground: a backgrounded phone stops
   the camera and microphone, and the app will tell you that play went
   unjudged rather than pretend otherwise.

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
- **The camera answers *where*.** `js/vision.js` scores each pixel of a
  downscaled frame by (frame difference × brightness) and takes the best small,
  compact cluster, predicted forward from the previous two frames. The ball is
  the smallest, brightest, fastest-moving thing in view, which is enough to
  find it without a model or a library.
- **`js/referee.js` fuses them.** When a transient arrives, it asks the tracker
  where the ball was at that instant. Inside the calibrated table quad, it's a
  bounce, and which side of the net line it fell on decides whose half. Outside
  the quad, it's a stroke. Near the net line and quiet, it's a net touch. **A
  sound with no ball behind it is discarded, not guessed at** — that is what
  keeps a dropped chair from awarding a point.
- **`js/rules.js` is the rulebook**, a pure state machine with no knowledge of
  cameras or microphones, driven entirely by those physical events. It's the
  part that's fully covered by tests (`npm test`).

## What it gets right, and what it won't

Honest limits, because an umpire that hides them is worse than no umpire:

- **Height is invisible to one camera.** The app knows where the ball is in the
  picture, not how far above the table it is. It infers a bounce from the sound
  arriving while the ball is over the table. A ball passing over the table at
  the same moment as an unrelated click can be misread.
- **Edge balls are the hardest call in the sport** and this app is not reliable
  on them. The side of the table and the top edge sound similar, and at the
  table's edge a couple of pixels decide in or out.
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
