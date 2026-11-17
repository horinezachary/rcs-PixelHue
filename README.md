# PixelHue Switcher

A [Rack Control Surface](https://github.horinetech.com/rcs-releases/) module for the PixelHue Q8 presentation
switcher: recall presets to preview from the Stream Deck, Take or Cut them to program, and see which input is on
every screen, AUX and multiviewer window. The P10, P20 and P80 speak the same Open API and should work too, but
only the Q8 shape has been tested (against the simulator here).

- **Presets**: program and preview of every screen, drawn to scale with each layer named by its source, and the
  preset list with its tally (green on preview, red on program). Tap a preset to load it, then TAKE or CUT.
- **Outputs**: every screen and AUX with its physical output connectors and the sources on program and preview,
  and the multiviewer windows. A source with no signal shows red.
- **Inputs**: every input with its signal and format, and where it is on program and preview.
- **Setup**: switchers by address (up to 4), Allow controls and the transition time.

The web view has the same pages; there each preset has a PVW and a PGM button, and PGM, Take and Cut ask first.

## Stream Deck

| Key | Does |
| --- | --- |
| 1-10 | Presets. Green: on preview, red: on program. Key 10 pages when there are more than 10 |
| 11 | Load to: PREVIEW or PROGRAM (the module's own setting, sends nothing) |
| 12 | The switcher, when there are several: press for the next one |
| 13 | What is on preview; press for the Outputs view |
| 14 | CUT |
| 15 | TAKE |

A preset key loads to preview at once. With Load to PROGRAM, the first press arms it (PRESS AGAIN) and a second
press within 3 seconds sends it. TAKE and CUT act on the screens selected on the switcher, which loading a preset
selects (as on the switcher's own front panel); with none selected they use the screens of the preset on preview.

## The switcher is the source of truth

Everything shown is read from the switcher about once a second and kept only in memory. State holds which switcher
the panel shows and Load to; config holds the switcher list, Allow controls (off by default) and the transition
time, so named saves carry exactly those. Starting, restoring a save, resuming after a power cut and reconnecting
only read. A command goes out only on an operator's action with Allow controls on, and the module then reads the
switcher again so the tally shows what the switcher says, not what was asked.

The switcher's API has no login: the token is made from its serial number and start time. So the module keeps no
secrets, and there is nothing to put in a save.

## What it reads and writes

From the PixelFlow OpenAPI manual V2.0.1 and PixelHue's own Companion module
([bitfocus/companion-module-pixelhue-switcher](https://github.com/bitfocus/companion-module-pixelhue-switcher)).

| | |
| --- | --- |
| Connect | `GET https://<ip>:19998/unico/v1/ucenter/device-list` (self-signed certificate) for the API port, then `GET http://<ip>:<port>/unico/v1/node/open-detail`. Requests carry an HS256 JWT of `{"SN": serial}` signed with the start time. |
| Reads (every second) | `screen/list-detail`, `layers/list-detail`, `preset`; `interface/list-detail` every 5 s |
| Commands | `POST preset/apply` (targetRegion 4 preview, 2 program), `PUT screen/take`, `PUT screen/cut` |

## Video previews

The PixelFlow OpenAPI has no video or thumbnail of a canvas or the multiviewer. PixelFlow itself has an
undocumented "echo" preview (`layers/echo`, gated by the device's `echovideo` capability) whose data format is not
published, so the module draws each canvas from its layer positions instead. Seeing real pictures needs either
that echo format worked out on a real Q8 (reads only) or the multiviewer output captured by another device.

## Development

```sh
npm install                      # links the SDK from ../rack-control-surface (or: npm run link-sdk -- <path>)
npm test
npm run sim                      # a simulated Q8: discovery on 127.0.0.1:19998
npm run dev                      # the panel simulator with this module; add 127.0.0.1 in Setup
```

The simulator (`src/sim/q8.ts`) has 12 inputs, an LED wall, two IMAG screens, an AUX, a multiviewer and 12 presets,
and acts on preset loads, Take and Cut. `curl 'http://127.0.0.1:<api port>/sim/signal?input=1&state=0'` unplugs an
input; `/sim/select?screen=1&on=1` selects a screen as the front panel would; `/sim/restart` changes the token.

Releases: every merge to master is a signed release (see `.github/workflows/release.yml`). The repo needs the
`RCS_SIGNING_KEY` and `RCS_SOURCE_TOKEN` secrets.
