# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is
An LPMud-style text MUD (telnet) with a content-pack system so others can extend it ("so tiny expressed as code, so powerful when exposed to creative minds"). A Gold Box-style tactical combat view is a planned later client mode; the tile-dungeon schema in `engine/schema.ts` is reserved for it and unused by the server today. Planned next: sandboxed scripting for wizards, pack export/import, and an in-browser sprite/map editor.

## Commands
- `npm start` — run the MUD on port 4000 (`PORT=…` to change). Connect with `nc localhost 4000`.
- `npm run validate` — validate every pack plus all cross-references (exits, monsters, items, quests, spells, classes, books, NPCs, shops). Run after any content or schema change.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run web` — start the MUD AND the browser client (http://127.0.0.1:8081, `WEB_PORT`/`WEB_HOST` to change). `engine/web.ts` bridges WebSocket to the telnet port; `client/index.html` is the whole front end (faux-3D canvas scene + terminal). `npm run art:preview` renders every sprite to `art-preview.png`.
- `npm run arch -- you@school.edu` — register an arch wizard by e-mail. Arch wizards are identified by hashed account key, never by character name (a name can be claimed by anyone).
- There is no test suite. Test by starting the server on a spare port and driving it with a socket script (login: e-mail, password, password again for a new account, then name, race number, class number). Test knobs:
  - `DATA_DIR=<dir>` — root for ALL persistent state (`accounts/`, `corpses.json`, `arch.json`). Default `data/` (gitignored). Always point it at a temp dir when testing.
  - `PACKS_DIR=<dir>` — load a modified copy of `packs/` (e.g. force loot chance to 1, or make a monster hit hard to test death).
  - `CORPSE_ROT_MS=<ms>` — corpse rot time (default 1 hour).
  - Editing a character's JSON in `DATA_DIR/accounts/` before logging in is the quick way to set level/hp/room/inventory for a test.

## Architecture
- Everything that is game content is data in `packs/<id>/` (`pack.json` lists monsters, items, areas, quests, spells, classes, races, books, glossary files). The base game is itself just a pack. Never hardcode content in the engine.
- `engine/schema.ts` (zod) is the source of truth for every content format. Change it, `engine/world.ts` (loader + cross-reference checks) and the content together, then run `npm run validate`.
- `engine/server.ts` is the whole runtime: login state machine (email → password → name → race → class), command handler, 2s combat tick, 30s hunger tick, quests, spells, loot, corpses. `engine/accounts.ts` is persistence (accounts, corpses, arch list).
- The server watches `packs/` and hot-reloads. A reload that fails validation is rejected and the old world stays up. Live state (monsters, floor items, locks) is seeded lazily per room so it survives reloads.
- NPCs are just gamebooks: a room's `npcs[].talk` names a gamebook, and `talk <npc>` runs it. Gamebooks (`books.json`) are branching passages with item/flag requirements; `end: "done"` is a quiet ending used for conversations; a reward pays out once per account per book.
- Keep game logic separate from socket IO where practical; the plan is to run the same core headless / in a browser later.

## Art (browser client)
- Sprites are text pixel maps in `packs/*/art.json` using the 16-color EGA palette (`.` transparent, hex digits 0-F; see `engine/ega.ts`). Monsters and NPCs reference them via `sprite`; rooms pick a backdrop with `theme` (village, road, tavern, store, hall, cellar, stairs, crypt; add new ones in `THEMES` in `client/index.html`).
- The browser connects through the bridge with a first line of `@web`; the MUD then appends one out-of-band line per command (`\x01{json}`) describing the scene. Telnet users never see it. The "3D" is one-point perspective drawn on a 320x200 canvas with dither patterns, scaled up with nearest-neighbour, like the original Gold Box.
- The page is fully clickable: scene hit-regions are registered each frame (`hot()`; later entries sit on top, so sprites beat doors): side walls/back wall/ceiling/floor = move, monsters = `attack <id>`, NPCs = `talk <id>`, corpse = `loot`, floor glints = `get all`. Exits, numbered replies, `(talk x)`, `(read)` and floor items in the text are links, plus a button bar and a clickable pack (the scene carries a `me` block with vitals and inventory). Anything the client sends is just a normal command line, so there is no extra server API to secure.
- The bridge only accepts same-origin WebSocket connections and binds to localhost by default; keep it that way unless you add real auth/TLS.

## Wizards (level 20 "make wiz")
- `makewiz` at level 20 files a petition; an existing wizard (or arch wizard) runs `approve <name>`, which works even if the target is offline. Approval creates `packs/wiz_<name>/` with one area `w_<name>`. Arch wizards count as wizards automatically.
- Wizards build with `dig/desc/rname/theme/link/unlink/spawn/unspawn/place/unplace` (`wizhelp`). Every edit goes through `wizEdit()` in `engine/server.ts`: parse with the Area schema, check cross-references against the live world, enforce limits (200 rooms, 4 spawn kinds, 6 items, 800-char descriptions), write atomically, then `reloadNow(true)`. A wizard can only touch their own area file; books, NPCs, shops and respawn points are arch-only; bound/arch-only/instant-kill items cannot be placed. Keep it that way: this is the only place players cause server file writes.
- Everyone can `wizlist` and `visit <name>`. The file watcher ignores the server's own writes (`selfWrite`) so players aren't spammed with reload notices.

## Rules baked into the design (don't undo casually)
- Death: everything not `bound` plus all gold goes into a corpse where you fell; you wake in the `respawn` room (Hall of Second Chances). Only the owner can loot it for 1 hour, then it is a free-for-all pile. Corpses persist across restarts.
- Death's Door: the first lethal blow in a fight leaves you at 1 HP, the monster hesitates one round, and fleeing is 90% instead of 60%. `wimpy N` auto-flees at N% HP.
- Mob drops are reserved for the players who fought it for 30s, then free-for-all, then crumble after 5 minutes. Items with `wild > 0` can drop from any monster.
- Gear has `minLevel`; weight vs capacity (30 + 5/level + race bonus) limits what you carry.
- The Blade of Indisputable Authority (instant kill, bound, `archOnly`) is granted at login to registered arch wizards only.

## Gotchas
- Accounts: the raw e-mail is never stored. Key = sha256(lowercased e-mail); only a masked form (`j***e@s****.edu`) is kept for display. Passwords are scrypt-hashed.
- Account fields added after launch (`level`, `xp`, `hp`, `mana`, `class`, `race`, `food`, `gold`, `equipped`, `quests`, `done`, `inventory`, `mode`, `tipsSeen`, `wimpy`, `booksDone`) are optional in the type; old saves lack them, so always read them through the helpers (`level(p)`, `invOf(p)`, `gold(p)`, …).
- Two play modes, stored per character: `modern` (tips, monster stats, HP/MP/hunger prompt) and `commodore` (uppercase, 40 columns, `READY.` prompt, no hints). All player output goes through `send()`, which applies the mode. Keep output ASCII (no `×`, etc.) so old terminals and Commodore mode are fine.
- Telnet: the socket is `latin1` so IAC bytes survive; password entry toggles server-side echo with IAC WILL/WONT ECHO.
- Ids are lowercase `[a-z0-9_]`. AC is descending (lower is harder to hit), 1e style. Room exits and quest rooms use `"area/room"` keys; bare ids in exits are relative to the room's own area.
- Write each content edit as a complete unit: a pack edit that fails validation is rejected by the live server's hot reload, and a half-applied multi-file change leaves the server on the old world.

## Content rules
- All content must be original. Do not copy art, text, maps, characters, items or catchphrases from SSI's Pool of Radiance, Wizards of the Coast / Forgotten Realms (no Phlan), South Park, Rick and Morty, Homestar Runner, or any other existing property. Parody tone and inspiration are fine; reuse is not. (Example: the instant-kill sword is the original "Blade of Indisputable Authority", not a borrowed item.)
