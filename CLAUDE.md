# PixelHue Switcher module

A Rack Control Surface module; see README.md. Built like the other module repos (rcs-led-processor-module,
rcs-netgearAV-module): SDK linked from a rack-control-surface checkout, signed releases on every merge to master (the default branch).

## Working agreement

Features go on a branch and a pull request. Zac reviews, then merges. Title PRs `feat: ...` for features and
`fix: ...` for fixes; the title decides the version bump.

## Real switchers

The switchers are live show equipment. Reading from them is fine. **Ask Zac before sending any control command
to a real switcher** (preset/apply, screen/take, screen/cut, or any other PUT/POST). Develop against the
simulator (`src/sim`, `npm run sim`).

The switcher is the source of truth: config and state hold only the module's own settings; start, restore and
reconnect only read; commands go out only on an operator action with Allow controls on.
