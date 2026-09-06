# Umpire — a ping pong referee that watches and listens

A browser app that points your camera at the table, listens through your
microphone for the ball, and calls the match: services, double bounces,
volleys, net cords, balls out, scoring, service rotation, games and match.

Every ruling is announced out loud, written to a play log with a confidence
figure, and can be overridden or undone.

## Running it

```sh
npm start          # http://localhost:8080
npm run start:https  # for opening it on a phone on the same network
npm test           # rules engine tests
```

Camera and microphone need a secure context: `http://localhost` counts, any
other host needs HTTPS. `npm run start:https` generates a self-signed
certificate (you'll have to accept the browser warning).

There is no build step and no runtime dependencies — it's ES modules served
straight to the browser.

## Setting up before a match

1. **Place the camera** so it sees the whole table and both players. A side-on
   view roughly level with the table, a couple of metres back, is best: it
   keeps both halves visible and makes the net line unambiguous.
2. **Put the microphone near the table.** This matters more than anything
   else. A laptop three metres away with a fan running will miss quiet
   bounces. The app deliberately disables the browser's noise suppression,
   echo cancellation and auto gain, because all three are designed to remove
   exactly the kind of short click a ball makes.
3. **Press Start**, then **calibrate**: click the four table corners in the
   order the prompt asks for, starting at Player A's end nearest the camera
   and walking around the table. This is what tells the referee which half is
   which.
4. **Begin match.**

Tune under *Detection settings* if calls are being missed or invented:

| Setting | Raise it when | Lower it when |
| --- | --- | --- |
| Bounce sensitivity | Room noise is triggering phantom bounces | Real bounces are being missed |
| Noise gate | There's constant background hum | Quiet bounces aren't registering |
| Ball motion threshold | Shirts and arms are stealing the track | The ball is lost mid-rally |
| Audio/video sync window | Sounds aren't being matched to the ball | Sounds are matched to the wrong moment |

Keyboard: `A` / `B` award a point, `L` calls a let, `U` undoes.

## How it decides

The two sensors answer different questions, and neither is trusted alone.

- **The microphone answers *when*.** An AudioWorklet (`js/onset-processor.js`)
  runs on the audio thread in 128-sample blocks, so a bounce is timestamped to
  within about 3 ms instead of to the nearest video frame. It flags any
  transient that jumps above an adapting noise floor, then measures the sound's
  zero-crossing rate and decay. A ball on the table is a bright, short click; a
  racket is lower and rings longer; a net touch is quiet and dull.
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
- **It does not judge service legality** — throw height, open palm, ball behind
  the end line. Those need a calibrated view a single webcam doesn't give.

Treat it as an assistant that catches the routine calls and keeps score
reliably, with a human ready on the override buttons for the close ones. It is
not fit for officiating a match that matters.

## Layout

```
index.html              markup and controls
css/styles.css
js/main.js              UI wiring, calibration clicks, spoken calls
js/vision.js            camera, table geometry, ball tracker
js/audio.js             microphone, transient classification
js/onset-processor.js   AudioWorklet onset detector (audio thread)
js/referee.js           sensor fusion: sound + position -> physical event
js/rules.js             ITTF-style match state machine (tested)
test/rules.test.mjs
server.mjs              static server, optional self-signed HTTPS
```
