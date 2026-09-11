# 🌷 The Tulip Garden

An interactive, cinematic world grown entirely in the browser: code becomes
light, light becomes a tulip, a tulip becomes a field, and the field learns to
respond to the person dancing in the middle of it.

Nothing here is a downloaded asset. There are no 3D models, no textures, no
audio files and no webfonts. Every flower, every blade of grass, the sky, the
weather, the water, the music and the figure are generated at runtime from
mathematics — which is why the whole experience is a few hundred kilobytes and
looks different every time you open it.

---

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # -> dist/
npm run preview    # serve the production build
npm run typecheck
```

Requires Node 20+ and a browser with WebGL 2.

---

## Deploy it

The same source deploys to all three hosts. The only difference is the base
path, which Vite takes from one environment variable.

### GitHub Pages
`.github/workflows/deploy.yml` builds and publishes on every push to `main`.
Enable it once under **Settings → Pages → Source → GitHub Actions**. The
workflow sets `BASE_PATH=/<repo>/` automatically, so a project site at
`https://<user>.github.io/<repo>/` works without any code change.

### Vercel
Import the repository. `vercel.json` supplies the build command, output
directory and cache headers — no dashboard configuration needed.

### Netlify
Import the repository. `netlify.toml` does the same.

### Anywhere else
`npm run build` produces a fully static `dist/`. Serve it from any host. If it
is served from a subdirectory, build with `BASE_PATH=/that/path/ npm run build`.

---

## How it works

The expensive-looking parts are cheap on purpose.

**The tulips are posed entirely on the GPU.** A tulip is authored once in a
canonical space — stem from y=0 to y=1, each leaf and petal at the origin
carrying its own azimuth as a vertex attribute. Opening is not an animation but
a *curvature*: the vertex shader rolls each petal around an arc whose bend it
chooses per frame, so a tight bud and a full bloom are the same triangles at
different curvatures. That means a hundred thousand flowers can each be at
their own point in their own bloom, reacting to wind, music, her footsteps and a
passing bloom wave, with the CPU touching not one vertex.

**Chunks and level of detail.** Instances are bucketed into square chunks; each
chunk is one draw call and one frustum test, and swaps between three base
geometries by camera distance. The instance buffers are shared between the three,
so changing detail is a pointer assignment.

**The field continues past the geometry.** Real flowers only exist within a
radius where they are worth drawing. Beyond that the terrain shader paints the
same palette with the same density function and the same wind field, and the
handover is a distance blend — so the sea of tulips reaches the horizon without
a horizon's worth of triangles. From high enough up, the density function
resolves into two nested six-lobed rosettes: a tulip inside a tulip.

**Grass follows the camera.** A fixed budget of blades is laid out in a tile and
wrapped around the viewer in the vertex shader. The arithmetic leaves each blade
stationary in the world until it crosses the tile edge, and blades fade out
before they get there.

**One shared uniform graph.** Every material references the *same* uniform
objects, so writing `uniforms.wind.uWindStrength = 2` moves every tulip, every
blade, her hair and the pond in the same gust, with no per-object work at all.

**The terrain is analytic.** The height field is sines and nothing else, so the
CPU (placing flowers, walking her across the field) and the GPU (displacing the
mesh) agree on where the ground is to the millimetre.

**Sound is synthesised, and the garden listens to itself.** Wind, grass, a
harmonic pad, bell-like notes on a pentatonic scale and the occasional distant
bird, all generated with the Web Audio API. The analyser sits on the *master*
bus, so the field reacts to the garden's own music exactly as it would to yours
— drop a track in via the settings panel and the same machinery drives the same
flowers.

**She is a figure of light and cloth.** A real skeleton posed by a dance system
of blended joint angles, wearing a dress and hair that are genuinely simulated
verlet chains answering to gravity, to the same wind the tulips answer to, and
to her own movement. Deliberately semi-abstract: a procedurally-built realistic
human lands in the uncanny valley, and a presence does not.

---

## Things to find

Nothing is signposted, and this list is a spoiler.

- Six hidden gardens. One only exists at night, one only at sunrise.
- A pond that reflects the real sky — and, very rarely, keeps dancing for a
  moment after she has stopped.
- An ancient tree that lights from the roots outward as you approach, carrying
  one flower unlike any other.
- A luminous butterfly that appears rarely and, if you follow it, goes somewhere.
- Fireflies that occasionally agree on a shape and hold it for a few seconds.
- Messages inside particular flowers. Each one is only ever shown once.
- A shooting star you can catch, if you tap at the right moment.
- Tulips you plant yourself. They are still there when you come back, and they
  keep growing between visits.

The garden remembers how often you have visited and what you have found, and
quietly changes. It never says so.

---

## Controls

Everything is optional; the experience runs without any input at all.

| | |
|---|---|
| Drag / arrow keys | look around |
| Scroll / pinch / `+` `-` | move closer or further |
| Tap or click the ground | plant a tulip |
| Tap or click a flower | touch it |
| Double tap | a burst of blooming |
| Press and hold | a slow ripple through the field |
| Swipe up | lift the camera |
| `Esc` | leave cinematic mode |
| The mark in the corner | settings |

Settings holds sound and volume, your own music, the hour of the day, reduced
motion, a cinematic mode that removes every piece of interface, three quality
levels, and the option to make the garden forget you.

---

## Performance

Device capability is probed at startup and one of three tiers is chosen. The
frame time is then watched, and a tier is dropped after three consecutive bad
seconds — enough to ride out a garbage collection without flip-flopping. All
three are selectable by hand.

| | Cinematic | Beautiful | Performance |
|---|---|---|---|
| Tulips | 118,000 | 54,000 | 19,000 |
| Grass blades | 150,000 | 66,000 | 20,000 |
| Bloom, depth of field | yes | yes | no |
| Pixel ratio cap | 2 | 1.75 | 1.25 |

---

## Verification

`tools/` holds the harnesses used to keep this honest — they are bench
instruments, not part of the site.

```bash
npm run build
npm run preview                # in one shell
node tools/check.mjs           # console errors, resize, compile sweep
node tools/journey.mjs         # walks the narrative and reports each act
node tools/preview.mjs         # art-direction stills at chosen hours
```

`check.mjs` boots the built site in headless Chromium, records every console
message, page error and failed request, forces every material in the world to
compile by visiting each landmark, resizes mid-flight, and fails on any error.
Materials compile lazily on first draw, so without that sweep a shader that only
exists at the far side of the world would go untested.

---

## Layout

```
src/
  core/       engine, quality tiers, shared uniform graph, math, colour
  shaders/    GLSL shared by every material; the tulip; the grade pass
  world/      terrain, tulips, grass, sky, ground, pond, tree, air, wildlife
  systems/    the garden's heart, weather, day cycle, audio, her, camera,
              interaction, events, memory
  narrative/  the acts, and the language the world is written in
  ui/         loader, code overlay, messages, settings
```

---

> Create something beautiful.
> Give it life.
> Plant a tulip.
> Grow an entire garden.
> Put her in the middle.
> And let the world bloom.
