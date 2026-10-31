# Pool of Radience

A love letter to the games that made me a computer person: an LPMud-style text world with Gold Box-style pixel art, built so that anyone can extend it.

- **A real multiplayer MUD** over telnet, with accounts that persist: race and class, hit points, mana, a hunger meter, spells, quests, shops, armor, weight, loot, and corpses that rot into piles after an hour.
- **A browser client** with faux-3D scenes drawn the way the old games did it: one-point perspective, dithered 16-color EGA palette, scaled sprites. Everything is clickable.
- **Choose-your-own-adventure books and NPC conversations** from the same JSON format.
- **Wizards.** Reach level 20, petition, and get your own domain you can build in-game (`dig`, `desc`, `spawn`, ...). Every edit is validated before it touches disk.
- **Two modes:** `modern` (tips, stats) and `commodore` (40 columns, uppercase, `READY.`, no hints).
- **Tiny.** The whole thing (code, art, content) is about 150 KB. It would fit on a floppy.

## Run it

```sh
npm install
npm run web        # MUD + browser client -> http://127.0.0.1:8080
# or just the telnet server:
npm start          # nc localhost 4000
```

Log in with any e-mail-shaped username (the first login creates the account). Only a hash of the address is stored; the display name is masked.

To make yourself an arch wizard (instant-kill blade, can approve other wizards):

```sh
npm run arch -- you@school.edu
```

## Everything is data

The game is a pack of JSON files in `packs/base/`: monsters, items, areas, quests, spells, classes, races, gamebooks, a glossary, and pixel art (text maps in the EGA palette). Add a folder under `packs/` and it loads; edit a file while the server runs and it hot-reloads. A broken edit is rejected and the old world stays up.

```sh
npm run validate        # check every pack and cross-reference
npm run art:preview     # render all sprites to art-preview.png
npm run typecheck
```

See [`CLAUDE.md`](CLAUDE.md) for the architecture, the rules the design depends on, and how to test.

## Status

A working prototype. No scripting for wizards yet, no in-browser sprite editor yet, no automated test suite. The browser client is localhost-only with no TLS or login of its own; do not expose it to the internet as-is.

## Legal

This is a homage. It is **not affiliated with or endorsed by** Wizards of the Coast, Strategic Simulations, Inc., Paramount, Comedy Central, or anyone else. All code, art, names, characters and text here are original. Nothing is copied from any commercial game, and contributions must keep it that way.

No license has been chosen yet, so all rights are reserved for now.
