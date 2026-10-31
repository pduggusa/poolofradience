import { createServer, type Socket } from "node:net";
import { watch, writeFileSync, renameSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorld, resolveExit, type World } from "./world.js";
import type { Direction, Monster, Quest, Spell } from "./schema.js";
import { Area as AreaSchema } from "./schema.js";
import { type Account, type Corpse, keyOf, loadAccount, saveAccount, createAccount, verify, nameTaken, loadCorpses, saveCorpses, isArchKey, findByName } from "./accounts.js";

const PORT = Number(process.env.PORT ?? 4000);
const PACKS = process.env.PACKS_DIR ?? join(import.meta.dirname, "..", "packs");

const DIRS: Record<string, { dir: Direction; label: string }> = {
  n: { dir: "n", label: "north" }, north: { dir: "n", label: "north" },
  s: { dir: "s", label: "south" }, south: { dir: "s", label: "south" },
  e: { dir: "e", label: "east" }, east: { dir: "e", label: "east" },
  w: { dir: "w", label: "west" }, west: { dir: "w", label: "west" },
  u: { dir: "u", label: "up" }, up: { dir: "u", label: "up" },
  d: { dir: "d", label: "down" }, down: { dir: "d", label: "down" },
};

interface Player { name: string; room: string; sock: Socket; who: string; acct: Account; fighting?: Mob; web?: boolean; deathsDoor?: boolean; graceTicks?: number; book?: { id: string; at: string; flags: string[] }; }

const save = (p: Player) => { p.acct.room = p.room; p.acct.name = p.name; saveAccount(p.acct); };

let world: World = loadWorld(PACKS);
if (world.errors.length) { console.error(world.errors.join("\n")); process.exit(1); }
const players = new Set<Player>();

// Items on the ground, per room. Lazily seeded from the room's definition, so hot reload keeps live state.
const floor = new Map<string, string[]>();
const floorOf = (key: string) => { let f = floor.get(key); if (!f) floor.set(key, (f = [...(world.rooms.get(key)?.items ?? [])])); return f; };
const invOf = (p: Player) => (p.acct.inventory ??= []);
/** Find an item id in a list by exact id or by a word/prefix of its name. */
const findItem = (ids: string[], q: string) => {
  const n = q.trim().toLowerCase();
  return n ? ids.find((id) => id === n || (world.items.get(id)?.name.toLowerCase() ?? "").includes(n)) : undefined;
};

// ---- Loot rules: mob drops are reserved for the victors briefly, then free-for-all, then decay. ----
const LOOT_LOCK_MS = 30_000, LOOT_DECAY_MS = 300_000;
interface Lock { id: string; owners: Set<string>; until: number; expires: number }
const locks = new Map<string, Lock[]>();
/** True if every copy of this item on the floor is still reserved for someone else. */
function lootBlocked(p: Player, room: string, id: string) {
  const copies = floorOf(room).filter((x) => x === id).length;
  const held = (locks.get(room) ?? []).filter((l) => l.id === id && l.until > Date.now() && !l.owners.has(p.acct.key)).length;
  return copies - held <= 0;
}
function releaseLock(p: Player, room: string, id: string) {
  const l = locks.get(room); if (!l) return;
  const i = l.findIndex((x) => x.id === id && x.owners.has(p.acct.key));
  const j = i >= 0 ? i : l.findIndex((x) => x.id === id);
  if (j >= 0) l.splice(j, 1);
}
// Sweep: uncollected drops crumble to dust; corpses rot into piles.
setInterval(() => {
  for (const [room, list] of locks) {
    const keep: Lock[] = [];
    for (const l of list) {
      if (l.expires > Date.now()) { keep.push(l); continue; }
      const f = floorOf(room), i = f.indexOf(l.id);
      if (i >= 0) { f.splice(i, 1); tell(room, `${world.items.get(l.id)?.name ?? "Something"} crumbles to dust.`); }
    }
    locks.set(room, keep);
  }
  for (const c of corpses) if (!c.announced && Date.now() >= c.rotsAt) {
    c.announced = true; persistCorpses();
    tell(c.room, `The corpse of ${c.ownerName} has rotted away, leaving a pile of loot.`);
  }
}, 15_000).unref();

// ---- Corpses ----
const ROT_MS = Number(process.env.CORPSE_ROT_MS ?? 3_600_000); // 1 hour
let corpses: Corpse[] = loadCorpses();
const persistCorpses = () => { corpses = corpses.filter((c) => c.items.length || c.gold); saveCorpses(corpses); };
const corpsesIn = (room: string) => corpses.filter((c) => c.room === room && (c.items.length || c.gold));
const isPile = (c: Corpse) => Date.now() >= c.rotsAt;
const mayLoot = (p: Player, c: Corpse) => c.ownerKey === p.acct.key || isPile(c);

/** Take what you can carry from every corpse/pile here you may loot. Returns false if there was nothing to look at. */
function lootCorpses(p: Player): boolean {
  const here = corpsesIn(p.room);
  if (!here.length) return false;
  const got: string[] = []; let coins = 0, denied = 0, heavy = 0;
  for (const c of here) {
    if (!mayLoot(p, c)) { denied++; continue; }
    coins += c.gold; c.gold = 0;
    for (const id of [...c.items]) {
      const it = world.items.get(id);
      if (!it) { c.items.splice(c.items.indexOf(id), 1); continue; }
      if (carried(p) + it.weight > capacity(p)) { heavy++; continue; }
      c.items.splice(c.items.indexOf(id), 1); invOf(p).push(id); got.push(it.name);
    }
  }
  if (coins) p.acct.gold = gold(p) + coins;
  persistCorpses(); save(p);
  const out: string[] = [];
  if (got.length || coins) out.push(`You loot: ${[...got, coins ? `${coins} gold` : ""].filter(Boolean).join(", ")}.`);
  if (denied) out.push(denied === 1 ? "That corpse is not yours to loot." : "Those corpses are not yours to loot.");
  if (heavy) out.push(`(${heavy} item(s) are too heavy; make room and loot again.)`);
  send(p, out.join("\n") || "There is nothing left to loot.");
  if (got.length || coins) tell(p.room, `${p.name} loots the remains.`, p);
  return true;
}

const isC64 = (p: Player) => p.acct.mode === "commodore";

/** Commodore mode: UPPERCASE, wrapped at 40 columns like a C64 screen. Modern mode: untouched. */
function fmt(p: Player, text: string): string {
  if (!isC64(p)) return text;
  return text.toUpperCase().split("\n").map((line) => {
    const out: string[] = []; let cur = "";
    for (const w of line.split(" ")) {
      if (cur && (cur + " " + w).length > 40) { out.push(cur); cur = w; } else cur = cur ? cur + " " + w : w;
    }
    return [...out, cur].join("\n");
  }).join("\n");
}
const send = (p: Player, text: string) => p.sock.write(fmt(p, text).replace(/\n/g, "\r\n") + "\r\n");

/** Modern mode only: show a one-time hint per feature, remembered across sessions. */
function tip(p: Player, key: string, text: string) {
  if (isC64(p)) return;
  const seen = (p.acct.tipsSeen ??= []);
  if (seen.includes(key)) return;
  seen.push(key);
  send(p, `[tip] ${text}`);
}
const tell = (room: string, text: string, except?: Player) => {
  for (const p of players) if (p.room === room && p !== except) send(p, text);
};


// ---------- Monsters, combat, XP ----------
interface Mob { uid: number; def: Monster; hp: number; room: string; }
let nextUid = 0;
const roll = (n: number, sides: number) => { let t = 0; for (let i = 0; i < n; i++) t += 1 + Math.floor(Math.random() * sides); return t; };
const DICE = /^(\d+)d(\d+)([+-]\d+)?$/;
const rollDice = (d: string) => { const m = d.match(DICE)!; return roll(+m[1]!, +m[2]!) + +(m[3] ?? 0); };
const avgDice = (d: string) => { const m = d.match(DICE)!; return +m[1]! * (+m[2]! + 1) / 2 + +(m[3] ?? 0); };

const newMob = (def: Monster, room: string): Mob => ({ uid: ++nextUid, def, hp: Math.max(1, roll(def.hitDice, 8) + def.hpBonus), room });
const liveMobs = new Map<string, Mob[]>();
/** Live monsters in a room, seeded lazily from the room's spawn table (so hot reload keeps state). */
const mobsOf = (key: string): Mob[] => {
  let list = liveMobs.get(key);
  if (!list) {
    list = [];
    for (const s of world.rooms.get(key)?.spawns ?? []) {
      const def = world.monsters.get(s.monster);
      if (def) for (let i = 0; i < s.count; i++) list.push(newMob(def, key));
    }
    liveMobs.set(key, list);
  }
  return list;
};

const level = (p: Player) => (p.acct.level ??= 1);
const cls = (p: Player) => world.classes.get(p.acct.class ?? "");
const race = (p: Player) => world.races.get(p.acct.race ?? "");
const maxHp = (p: Player) => { const c = cls(p); return Math.max(1, (c ? Math.floor(c.hp.base + c.hp.perLevel * level(p)) : 10 + level(p) * 6) + (race(p)?.hpBonus ?? 0)); };
const hpOf = (p: Player) => (p.acct.hp ??= maxHp(p));
const maxMana = (p: Player) => { const c = cls(p); return Math.max(0, (c ? Math.floor(c.mana.base + c.mana.perLevel * level(p)) : 5 + level(p) * 3) + (race(p)?.manaBonus ?? 0)); };
/** THAC0 improves by the class attackRate per level: fighters 1/level, mages 1 per 2 levels. */
const thac0 = (p: Player) => 21 - Math.floor(level(p) * (cls(p)?.attackRate ?? 1));
const usable = (p: Player, s: Spell) => !s.classes.length || s.classes.includes(p.acct.class ?? "");
const manaOf = (p: Player) => (p.acct.mana ??= maxMana(p));
const xpFor = (lvl: number) => 50 * lvl * (lvl + 1); // cumulative XP needed to leave this level
const equipped = (p: Player) => (p.acct.equipped ??= {});
const gold = (p: Player) => (p.acct.gold ??= 0);
const isArch = (p: Player) => isArchKey(p.acct.key);
const capacity = (p: Player) => 30 + level(p) * 5 + (race(p)?.carryBonus ?? 0);
const carried = (p: Player) => invOf(p).reduce((n, i) => n + (world.items.get(i)?.weight ?? 1), 0);
const foodOf = (p: Player) => (p.acct.food ??= 100);
const foodWord = (f: number) => (f > 75 ? "Full" : f > 40 ? "Fed" : f > 15 ? "Hungry" : f > 0 ? "Starving" : "Famished");
const promptOf = (p: Player) => `<HP ${Math.max(0, hpOf(p))}/${maxHp(p)} MP ${manaOf(p)}/${maxMana(p)} ${foodWord(foodOf(p))}>`;
const weapon = (p: Player) => world.items.get(equipped(p).weapon ?? "")?.damage ?? "1d3"; // wielded weapon, else bare hands
const playerAC = (p: Player) => 10 - Object.values(equipped(p)).reduce((n, id) => n + (world.items.get(id)?.acBonus ?? 0), 0);
/** True if this is the only copy of an item and it is currently worn/wielded. */
const isWorn = (p: Player, id: string) => Object.values(equipped(p)).includes(id) && invOf(p).filter((x) => x === id).length <= 1;
/** 1e-style to-hit: d20 >= THAC0 - target AC. Natural 20 always hits, natural 1 always misses. */
const hits = (thac0: number, ac: number) => { const r = roll(1, 20); return r === 20 || (r !== 1 && r >= thac0 - ac); };

function gainXp(p: Player, amount: number) {
  amount = Math.round(amount * (race(p)?.xpRate ?? 1));
  p.acct.xp = (p.acct.xp ?? 0) + amount;
  send(p, `You gain ${amount} experience.`);
  while (p.acct.xp >= xpFor(level(p))) {
    p.acct.level = level(p) + 1; p.acct.hp = maxHp(p); p.acct.mana = maxMana(p);
    send(p, `*** You advance to level ${level(p)}! ***`);
    tell(p.room, `${p.name} has reached level ${level(p)}!`, p);
  }
  save(p);
}

function killMob(m: Mob) {
  const list = mobsOf(m.room);
  list.splice(list.indexOf(m), 1);
  tell(m.room, `The ${m.def.name} dies.`);
  const owners = new Set([...players].filter((x) => x.fighting === m).map((x) => x.acct.key));
  const drops = [
    ...m.def.loot.filter((l) => Math.random() < l.chance).map((l) => l.item),
    ...[...world.items.values()].filter((it) => it.wild > 0 && Math.random() < it.wild).map((it) => it.id), // random drops from anything
  ];
  if (drops.length) {
    floorOf(m.room).push(...drops);
    const l = locks.get(m.room) ?? [];
    for (const id of drops) l.push({ id, owners, until: Date.now() + LOOT_LOCK_MS, expires: Date.now() + LOOT_DECAY_MS });
    locks.set(m.room, l);
    tell(m.room, `The ${m.def.name} drops: ${drops.map((i) => world.items.get(i)?.name ?? i).join(", ")}. (Reserved for the victors for ${LOOT_LOCK_MS / 1000}s.)`);
  }
  for (const q of players) if (q.room === m.room) setTimeout(() => emitScene(q), 0); // refresh everyone watching
  for (const p of players) if (p.fighting === m) {
    p.fighting = undefined;
    gainXp(p, m.def.xp);
    const g = m.def.gold ? rollDice(m.def.gold) : 0;
    if (g) { p.acct.gold = gold(p) + g; send(p, `You find ${g} gold.`); }
    questKill(p, m.def.id);
  }
  setTimeout(() => { // respawn
    if (!world.rooms.has(m.room)) return;
    mobsOf(m.room).push(newMob(m.def, m.room));
    tell(m.room, `A ${m.def.name} wanders in.`);
  }, 45_000).unref();
}

function die(p: Player) {
  const diedIn = p.room, where = world.rooms.get(diedIn)?.name ?? "the wilds";
  // Everything not soulbound goes into a corpse where you fell; only you can loot it until it rots (1h).
  const lost = invOf(p).filter((id) => !world.items.get(id)?.bound);
  const hadGold = gold(p);
  if (lost.length || hadGold) {
    corpses.push({ ownerKey: p.acct.key, ownerName: p.name, room: diedIn, items: lost, gold: hadGold, rotsAt: Date.now() + ROT_MS });
    persistCorpses();
  }
  p.acct.inventory = invOf(p).filter((id) => world.items.get(id)?.bound);
  p.acct.gold = 0;
  for (const [slot, id] of Object.entries(equipped(p))) if (!world.items.get(id)?.bound) delete equipped(p)[slot];
  tell(diedIn, `${p.name} collapses! Their belongings spill across the ground.`, p);
  p.fighting = undefined;
  p.acct.hp = Math.ceil(maxHp(p) / 2);
  p.room = world.respawn;
  tell(p.room, `${p.name} materializes, gasping.`, p);
  save(p);
  send(p, `You have died. The world goes grey... and you wake in ${world.rooms.get(p.room)?.name ?? "the village"}, aching and empty-handed.${lost.length || hadGold ? `\nYour belongings lie with your corpse in ${where}. Retrieve them ('loot') before it rots in an hour; until then only you can.` : ""}`);
  look(p);
}

/** Try to run for a random exit. 60% normally, 90% at Death's Door. */
function tryFlee(p: Player) {
  if (!p.fighting) return send(p, "You aren't fighting anything.");
  const here = world.rooms.get(p.room)!;
  const exits = Object.entries(here.exits);
  if (!exits.length || Math.random() >= (p.deathsDoor ? 0.9 : 0.6)) return send(p, "You fail to escape!");
  const [, to] = exits[Math.floor(Math.random() * exits.length)]!;
  p.fighting = undefined; p.deathsDoor = false;
  tell(p.room, `${p.name} flees in panic!`, p);
  p.room = resolveExit(here, to!);
  tell(p.room, `${p.name} stumbles in, out of breath.`, p);
  save(p); questVisit(p, p.room);
  send(p, "You flee!");
  look(p);
}

function round(p: Player) {
  const m = p.fighting;
  if (!m || m.room !== p.room || !mobsOf(m.room).includes(m)) { p.fighting = undefined; return; }
  const wi = world.items.get(equipped(p).weapon ?? "");
  if (wi?.instantKill) {
    m.hp = 0; send(p, `Your ${wi.name} judges the ${m.def.name} and finds it wanting. It falls.`);
  } else if (hits(thac0(p), m.def.ac)) {
    const dmg = Math.max(1, rollDice(weapon(p)));
    m.hp -= dmg; send(p, `You hit the ${m.def.name} for ${dmg}.`);
  } else send(p, `You miss the ${m.def.name}.`);
  if (m.hp <= 0) return killMob(m);
  if (p.graceTicks) { p.graceTicks--; return send(p, `The ${m.def.name} hesitates, circling for the kill. RUN, or heal!`); }
  const a = m.def.attacks[Math.floor(Math.random() * m.def.attacks.length)]!;
  if (hits(21 - m.def.hitDice - a.toHitBonus, playerAC(p))) {
    const dmg = Math.max(1, rollDice(a.damage) + Math.floor(m.def.hitDice / 2)); // tougher monsters hit harder
    p.acct.hp = hpOf(p) - dmg;
    if (p.acct.hp <= 0 && !p.deathsDoor) { // first lethal blow in a fight: you survive with 1 HP and one chance to run
      p.acct.hp = 1; p.deathsDoor = true; p.graceTicks = 1; // the monster will hesitate for one round
      send(p, `The ${m.def.name} hits you with its ${a.name} for ${dmg}. [HP 1/${maxHp(p)}]\n** DEATH'S DOOR ** You are barely standing. The next blow will kill you. FLEE now (90% to escape), or heal!`);
      if (p.acct.wimpy) tryFlee(p);
      return;
    }
    send(p, `The ${m.def.name} hits you with its ${a.name} for ${dmg}. [HP ${Math.max(0, p.acct.hp)}/${maxHp(p)}]`);
    if (p.acct.hp <= 0) return die(p);
    const pct = (p.acct.hp / maxHp(p)) * 100;
    if (p.acct.wimpy && pct <= p.acct.wimpy) { send(p, "You panic and bolt for it!"); return tryFlee(p); }
    if (pct <= 35) send(p, "[DANGER] You are badly hurt! Type 'flee' to run, or heal.");
  } else send(p, `The ${m.def.name} misses you.`);
}

// One combat round every 2 seconds; resting players recover a little.
setInterval(() => {
  for (const p of players) {
    if (p.fighting) { round(p); emitScene(p); }
    else {
      p.deathsDoor = false; p.graceTicks = 0; // the brush with death is forgotten once the fight is over
      const f = foodOf(p), k = f <= 15 ? 0 : f <= 40 ? 0.75 : 1; // hunger slows or stops recovery
      if (k && hpOf(p) < maxHp(p)) p.acct.hp = Math.min(maxHp(p), hpOf(p) + Math.max(1, Math.floor(maxHp(p) * 0.05 * k)));
      if (k && manaOf(p) < maxMana(p)) p.acct.mana = Math.min(maxMana(p), manaOf(p) + Math.max(1, Math.floor(maxMana(p) * 0.08 * k)));
    }
    if (foodOf(p) <= 0 && hpOf(p) > 1) p.acct.hp = hpOf(p) - 1; // starvation hurts, but never kills
  }
}, 2000).unref();

// Hunger: the food meter drains every 30s, scaled by race (dwarves eat like dwarves).
setInterval(() => {
  for (const p of players) {
    const before = foodWord(foodOf(p));
    p.acct.food = Math.max(0, foodOf(p) - (race(p)?.hungerRate ?? 1));
    const after = foodWord(foodOf(p));
    if (after !== before || after === "Famished")
      send(p, after === "Famished" ? "You are famished! Your body is consuming itself. Find food!" : after === "Starving" ? "Your stomach cramps painfully. You are starving." : after === "Hungry" ? "Your stomach growls. You are hungry." : "");
  }
}, 30_000).unref();

// ---------- Quests ----------
const activeQuests = (p: Player) => (p.acct.quests ??= {});
const doneQuests = (p: Player) => (p.acct.done ??= []);
const turnInRoom = (q: Quest) => q.turnIn ?? q.offeredIn;

function questKill(p: Player, monsterId: string) {
  for (const [qid, prog] of Object.entries(activeQuests(p))) {
    const q = world.quests.get(qid); if (!q) continue;
    q.objectives.forEach((o, i) => {
      if (o.type === "kill" && o.monster === monsterId && (prog[i] ?? 0) < o.count) {
        prog[i] = (prog[i] ?? 0) + 1;
        send(p, `[quest] ${q.name}: ${prog[i]}/${o.count} ${world.monsters.get(monsterId)?.name ?? monsterId}`);
      }
    });
  }
}
function questVisit(p: Player, room: string) {
  for (const [qid, prog] of Object.entries(activeQuests(p))) {
    const q = world.quests.get(qid); if (!q) continue;
    q.objectives.forEach((o, i) => {
      if (o.type === "visit" && o.room === room && !prog[i]) { prog[i] = 1; send(p, `[quest] ${q.name}: reached ${world.rooms.get(room)?.name ?? room}`); }
    });
  }
}
const objDone = (p: Player, q: Quest, i: number) => {
  const o = q.objectives[i]!, n = activeQuests(p)[q.id]?.[i] ?? 0;
  return o.type === "fetch" ? invOf(p).filter((x) => x === o.item).length >= o.count : o.type === "kill" ? n >= o.count : n >= 1;
};
const questReady = (p: Player, q: Quest) => q.objectives.every((_, i) => objDone(p, q, i));
const objLine = (p: Player, q: Quest, i: number) => {
  const o = q.objectives[i]!, n = activeQuests(p)[q.id]?.[i] ?? 0;
  const mark = objDone(p, q, i) ? "[x]" : "[ ]";
  if (o.type === "kill") return `  ${mark} Slay ${world.monsters.get(o.monster)?.name ?? o.monster}: ${Math.min(n, o.count)}/${o.count}`;
  if (o.type === "fetch") return `  ${mark} Bring ${o.count}x ${world.items.get(o.item)?.name ?? o.item}`;
  return `  ${mark} Go to ${world.rooms.get(o.room)?.name ?? o.room}`;
};
const matchQuest = (qs: Quest[], arg: string) => { const n = arg.trim().toLowerCase(); return n ? qs.find((q) => q.id === n || q.name.toLowerCase().includes(n)) : qs[0]; };
const offeredHere = (p: Player) =>
  [...world.quests.values()].filter((q) => q.offeredIn === p.room && !activeQuests(p)[q.id] && !doneQuests(p).includes(q.id));

function questLog(p: Player) {
  const lines: string[] = [];
  const act = Object.keys(activeQuests(p)).map((id) => world.quests.get(id)).filter((q): q is Quest => !!q);
  if (act.length) lines.push("Your quests:");
  for (const q of act) {
    lines.push(`* ${q.name}${questReady(p, q) ? ` -- READY: turn in at ${world.rooms.get(turnInRoom(q))?.name}` : ""}`);
    q.objectives.forEach((_, i) => lines.push(objLine(p, q, i)));
  }
  const here = offeredHere(p);
  if (here.length) {
    lines.push("Available here:");
    for (const q of here) lines.push(`* ${q.name}${q.minLevel > level(p) ? ` (needs level ${q.minLevel})` : ""} -- 'accept ${q.id}'`);
  }
  send(p, lines.length ? lines.join("\n") : "You have no quests, and none are offered here.");
}


// ---------- Spells ----------
const known = (p: Player) => (p.acct.spells ??= []);
const taughtHere = (p: Player) => [...world.spells.values()].filter((s) => s.taughtIn === p.room && !known(p).includes(s.id) && usable(p, s));
const matchSpell = (list: Spell[], q: string) => { const n = q.trim().toLowerCase(); return n ? list.find((s) => s.id === n || s.name.toLowerCase().includes(n)) : undefined; };
const spellLine = (p: Player, s: Spell) => `  ${s.name.padEnd(18)} L${s.minLevel}  ${String(s.mana).padStart(2)} mana${isC64(p) ? "" : "  - " + s.description}`;

function learnSpell(p: Player, s: Spell) {
  known(p).push(s.id); save(p);
  send(p, `You learn ${s.name}! Cast it with 'cast ${s.id}'.`);
}

function castSpell(p: Player, s: Spell, targetName: string) {
  if (manaOf(p) < s.mana) return send(p, `You don't have enough mana (${manaOf(p)}/${s.mana}).`);
  const e = s.effect;
  if (e.type === "damage") {
    const n = targetName.toLowerCase();
    const m = n ? mobsOf(p.room).find((x) => x.def.id === n || x.def.name.toLowerCase().includes(n)) : p.fighting;
    if (!m) return send(p, n ? "You see no such creature here." : "Cast it at what?");
    p.acct.mana = manaOf(p) - s.mana;
    const dmg = Math.max(1, rollDice(e.dice));
    m.hp -= dmg;
    send(p, `Your ${s.name} strikes the ${m.def.name} for ${dmg}!`);
    tell(p.room, `${p.name} casts ${s.name} at the ${m.def.name}!`, p);
    p.fighting = m;
    if (m.hp <= 0) killMob(m);
  } else if (e.type === "heal") {
    if (hpOf(p) >= maxHp(p)) return send(p, "You are already at full health.");
    p.acct.mana = manaOf(p) - s.mana;
    const heal = Math.max(1, rollDice(e.dice));
    p.acct.hp = Math.min(maxHp(p), hpOf(p) + heal);
    send(p, `Warmth spreads through you. You recover ${heal} HP. [HP ${p.acct.hp}/${maxHp(p)}]`);
  } else {
    p.acct.mana = manaOf(p) - s.mana;
    for (let i = 0; i < e.count; i++) invOf(p).push(e.item);
    const it = world.items.get(e.item);
    send(p, `You conjure ${e.count > 1 ? e.count + "x " : ""}${it?.name ?? e.item} out of thin air.`);
  }
  save(p);
}

// ---------- Gamebooks (choose-your-own-adventure) ----------
type Choice = NonNullable<ReturnType<typeof world.books.get>>["passages"][number]["choices"][number];
const choiceOk = (p: Player, c: Choice) => {
  const r = c.requires; if (!r) return true;
  return (!r.item || invOf(p).includes(r.item)) && (!r.flag || p.book!.flags.includes(r.flag)) && (!r.minLevel || level(p) >= r.minLevel);
};

function showPassage(p: Player) {
  const st = p.book!, b = world.books.get(st.id), ps = b?.passages.find((x) => x.id === st.at);
  if (!b || !ps) { p.book = undefined; return send(p, "The pages crumble to dust."); }
  const lines = [`\n${ps.text}`];
  if (ps.end) {
    send(p, (ps.end === "done" ? lines : lines.concat(ps.end === "win" ? "\n*** THE END -- you win! ***" : "\n*** THE END ***")).join("\n"));
    p.book = undefined;
    const done = (p.acct.booksDone ??= []);
    if ((ps.end === "win" || ps.end === "done") && ps.reward) {
      if (done.includes(b.id)) { if (ps.end === "win") send(p, "(You've already claimed this book's reward.)"); }
      else {
        done.push(b.id);
        if (ps.reward.gold) { p.acct.gold = gold(p) + ps.reward.gold; send(p, `You find ${ps.reward.gold} gold between the pages.`); }
        for (const i of ps.reward.items) { invOf(p).push(i); send(p, `You receive ${world.items.get(i)?.name ?? i}.`); }
        if (ps.reward.xp) gainXp(p, ps.reward.xp);
      }
    }
    return save(p);
  }
  ps.choices.filter((c) => choiceOk(p, c)).forEach((c, i) => lines.push(`  ${i + 1}) ${c.text}`));
  lines.push("(type a number, or 'leave' to close the book)");
  send(p, lines.join("\n"));
}

function bookInput(p: Player, line: string) {
  const st = p.book!, ps = world.books.get(st.id)?.passages.find((x) => x.id === st.at);
  const word = line.trim().toLowerCase();
  if (word === "leave" || word === "quit" || word === "close") { p.book = undefined; return send(p, "You close the book."); }
  const opts = ps?.choices.filter((c) => choiceOk(p, c)) ?? [];
  const c = opts[+word - 1];
  if (!c) return send(p, `Pick 1-${opts.length}, or 'leave'.`);
  if (c.set && !st.flags.includes(c.set)) st.flags.push(c.set);
  if (c.takes && invOf(p).includes(c.takes)) invOf(p).splice(invOf(p).indexOf(c.takes), 1);
  if (c.gives) { invOf(p).push(c.gives); send(p, `[You receive ${world.items.get(c.gives)?.name ?? c.gives}.]`); }
  st.at = c.to;
  showPassage(p);
}

// ---------- Wizards: level 20, then you build the world ----------
const WIZ_LEVEL = 20, MAX_ROOMS = 200;
const WIZ_CMDS = new Set(["makewiz", "approve", "wizlist", "visit", "workshop", "goto", "dig", "desc", "rname", "link", "unlink", "spawn", "unspawn", "place", "unplace", "theme", "wiz", "rooms", "wizhelp"]);
const BACK: Record<string, string> = { n: "s", s: "n", e: "w", w: "e", u: "d", d: "u" };
const THEME_NAMES = ["village", "road", "tavern", "store", "hall", "cellar", "stairs", "crypt"];
const isWizard = (p: Player) => !!p.acct.wizard || isArch(p);
const wizId = (name: string) => name.toLowerCase().replace(/[^a-z]/g, "");
const wizAreaId = (name: string) => `w_${wizId(name)}`;
const wizFile = (name: string) => join(PACKS, `wiz_${wizId(name)}`, "areas", `${wizId(name)}.json`);
let selfWrite = 0; // ignore our own file writes in the watcher (we reload directly)

function writeJson(path: string, obj: unknown) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}
function ensureWorkshop(name: string) {
  const id = wizId(name), dir = join(PACKS, `wiz_${id}`);
  if (existsSync(wizFile(name))) return;
  mkdirSync(join(dir, "areas"), { recursive: true });
  selfWrite = Date.now() + 1500;
  writeJson(join(dir, "pack.json"), { id: `wiz_${id}`, name: `${name}'s Workshop`, version: "0.1.0", author: name, engine: "0.1.0", areas: [`areas/${id}.json`] });
  writeJson(wizFile(name), { id: wizAreaId(name), name: `${name}'s Domain`, rooms: [{ id: "start", name: "The Empty Workshop",
    description: "Sawdust, blueprints and a smell of fresh paint. This is your domain. Try 'dig n lab The Lab', then 'desc <text>' to describe a room. 'wizhelp' lists your tools.", exits: {} }] });
}

/** Apply an edit to the wizard's own area file. Validated against the schema and the live world before anything is written. */
function wizEdit(p: Player, fn: (area: any) => string | void): boolean {
  if (!isWizard(p)) { send(p, "You are not a wizard."); return false; }
  ensureWorkshop(p.name);
  const area = JSON.parse(readFileSync(wizFile(p.name), "utf8"));
  const err = fn(area);
  if (err) { send(p, err); return false; }
  const parsed = AreaSchema.safeParse(area);
  if (!parsed.success) { send(p, `That would break your area: ${parsed.error.issues[0]?.message ?? "invalid"}`); return false; }
  const a = parsed.data;
  if (a.rooms.length > MAX_ROOMS) { send(p, `Your domain is full (${MAX_ROOMS} rooms).`); return false; }
  const own = new Set(a.rooms.map((r) => `${a.id}/${r.id}`));
  for (const r of a.rooms) {
    if (r.book || r.npcs.length || r.shop || r.respawn) { send(p, "Books, NPCs, shops and respawn points can only be added by an arch wizard."); return false; }
    if (r.name.length > 60 || r.description.length > 800) { send(p, "Room name max 60 chars, description max 800."); return false; }
    if (r.theme && !THEME_NAMES.includes(r.theme)) { send(p, `Themes: ${THEME_NAMES.join(", ")}.`); return false; }
    for (const [d, to] of Object.entries(r.exits)) { const k = to!.includes("/") ? to! : `${a.id}/${to}`; if (!own.has(k) && !world.rooms.has(k)) { send(p, `Exit ${d} leads to "${to}", which doesn't exist.`); return false; } }
    if (r.spawns.length > 4 || r.items.length > 6) { send(p, "A room holds at most 4 spawn kinds and 6 items."); return false; }
    for (const s of r.spawns) if (!world.monsters.has(s.monster) || s.count > 5) { send(p, `Unknown monster "${s.monster}" (or more than 5).`); return false; }
    for (const i of r.items) { const it = world.items.get(i); if (!it || it.bound || it.archOnly || it.instantKill) { send(p, `"${i}" isn't an item wizards may place.`); return false; } }
  }
  selfWrite = Date.now() + 1500;
  writeJson(wizFile(p.name), a);
  if (!reloadNow(true)) { send(p, "The world rejected that change."); return false; }
  for (const r of a.rooms) { liveMobs.delete(`${a.id}/${r.id}`); floor.delete(`${a.id}/${r.id}`); } // so spawns/items changes appear
  return true;
}

function wizard(p: Player, cmd: string, arg: string) {
  const here = world.rooms.get(p.room)!;
  const mine = here.area === wizAreaId(p.name);
  const needWiz = () => (isWizard(p) ? false : (send(p, "Only wizards can do that. Reach level 20 and type 'makewiz'."), true));
  const needDomain = () => (needWiz() ? true : mine ? false : (send(p, "You can only build in your own domain. Type 'workshop' to go there."), true));
  const dirOf = (w: string) => DIRS[w.toLowerCase()]?.dir;
  switch (cmd) {
    case "makewiz": {
      if (isWizard(p)) return send(p, "You already are one.");
      if (level(p) < WIZ_LEVEL) return send(p, `Wizards must reach level ${WIZ_LEVEL} first. You are level ${level(p)}.`);
      if (p.acct.wizPending) return send(p, "Your petition is already with the wizards.");
      p.acct.wizPending = true; save(p);
      for (const o of players) if (isWizard(o)) send(o, `[wiz] ${p.name} (level ${level(p)}) petitions to become a wizard. 'approve ${p.name}' to accept.`);
      return send(p, "Your petition has gone to the wizards. You'll be told when it is answered.");
    }
    case "approve": {
      if (needWiz()) return;
      const online = [...players].find((o) => o.name.toLowerCase() === arg.trim().toLowerCase());
      const acct = online?.acct ?? findByName(arg.trim());
      if (!acct) return send(p, "No such adventurer.");
      if (!acct.wizPending) return send(p, `${acct.name} has not petitioned.`);
      acct.wizard = true; acct.wizPending = false;
      if (online) save(online); else saveAccount(acct);
      ensureWorkshop(acct.name); reloadNow(true);
      if (online) send(online, `*** You are now a WIZARD! Your domain awaits: type 'workshop'. ('wizhelp' lists your tools.) ***`);
      for (const o of players) if (isWizard(o) && o !== online) send(o, `[wiz] ${p.name} approved ${acct.name}. Welcome to the club.`);
      return send(p, `${acct.name} is now a wizard.`);
    }
    case "wizlist": {
      const lines = [...world.areas].filter(([id]) => id.startsWith("w_")).map(([id, nm]) => `  ${id.slice(2).padEnd(14)} ${nm}  (${[...world.rooms.values()].filter((r) => r.area === id).length} rooms)  -- 'visit ${id.slice(2)}'`);
      return send(p, lines.length ? ["Wizard domains:", ...lines].join("\n") : "No wizard has built a domain yet.");
    }
    case "visit": {
      const id = wizAreaId(arg), start = world.areaStart.get(id);
      if (!arg.trim() || !start) return send(p, "No such domain. Try 'wizlist'.");
      if (p.fighting) return send(p, "Not in the middle of a fight!");
      tell(p.room, `${p.name} vanishes in a puff of sawdust.`, p); p.room = start; tell(p.room, `${p.name} arrives from elsewhere.`, p); save(p); return look(p);
    }
    case "workshop": {
      if (needWiz()) return; ensureWorkshop(p.name); reloadNow(true);
      const start = world.areaStart.get(wizAreaId(p.name)); if (!start) return send(p, "Your workshop isn't ready; try again.");
      tell(p.room, `${p.name} vanishes in a puff of sawdust.`, p); p.room = start; tell(p.room, `${p.name} arrives with a toolbox.`, p); save(p); return look(p);
    }
    case "goto": {
      if (needWiz()) return;
      const k = arg.trim().includes("/") ? arg.trim() : `${here.area}/${arg.trim()}`;
      if (!world.rooms.has(k)) return send(p, "No such room. Use area/room, e.g. mossgate/tavern.");
      p.fighting = undefined; tell(p.room, `${p.name} vanishes.`, p); p.room = k; tell(p.room, `${p.name} appears.`, p); save(p); return look(p);
    }
    case "wiz": {
      if (needWiz()) return; if (!arg) return send(p, "Say what to the wizards?");
      for (const o of players) if (isWizard(o)) send(o, `[wiz] ${p.name}: ${arg}`); return;
    }
    case "rooms": {
      if (needWiz()) return;
      const rs = [...world.rooms.values()].filter((r) => r.area === wizAreaId(p.name));
      return send(p, rs.length ? ["Your rooms:", ...rs.map((r) => `  ${r.id.padEnd(16)} ${r.name}  [${Object.keys(r.exits).join(" ")}]`)].join("\n") : "You have no domain yet. Type 'workshop'.");
    }
    case "wizhelp": return send(p, needWiz() ? "" : ["Wizard tools (build in your own domain; 'workshop' takes you there):",
      "  dig <dir> <id> <Name>   new room + two-way exit    desc <text>      describe this room",
      "  rname <Name>            rename this room           theme <name>     " + THEME_NAMES.join("/"),
      "  link <dir> <room>       one-way exit (area/room ok)  unlink <dir>   remove an exit",
      "  spawn <monster> [n]     add monsters (max 5)       unspawn <monster>",
      "  place <item>            put an item here           unplace <item>",
      "  rooms / goto <room> / visit <name> / wizlist / wiz <msg> / approve <name>"].join("\n"));
  }
  if (needDomain()) return;
  switch (cmd) {
    case "dig": {
      const [d, id, ...nm] = arg.trim().split(/\s+/); const dir = d ? dirOf(d) : undefined; const name = nm.join(" ");
      if (!dir || !id || !name) return send(p, "Usage: dig <dir> <id> <Room Name>   e.g. dig n lab The Laboratory");
      if (!/^[a-z0-9_]{1,24}$/.test(id)) return send(p, "Room ids are 1-24 chars: lowercase letters, digits, underscores.");
      if (!wizEdit(p, (a) => {
        const r = a.rooms.find((x: any) => `${a.id}/${x.id}` === p.room);
        if (!r) return "You aren't standing in your domain.";
        if (r.exits[dir]) return `There's already an exit ${dir} from here. 'unlink ${dir}' first.`;
        if (a.rooms.some((x: any) => x.id === id)) return `You already have a room called "${id}".`;
        r.exits[dir] = id;
        a.rooms.push({ id, name, description: "An unfinished room. (Describe it with 'desc <text>'.)", exits: { [BACK[dir]!]: r.id } });
      })) return;
      return send(p, `You dig ${DIRS[dir]!.label}: "${name}" (${id}). Walk ${DIRS[dir]!.label} to see it.`);
    }
    case "desc": case "rname": case "theme": {
      const v = arg.trim(); if (!v) return send(p, `Usage: ${cmd} <${cmd === "desc" ? "text" : cmd === "theme" ? THEME_NAMES.join("|") : "Name"}>`);
      if (!wizEdit(p, (a) => { const r = a.rooms.find((x: any) => `${a.id}/${x.id}` === p.room); if (!r) return "Not in your domain."; r[cmd === "desc" ? "description" : cmd === "rname" ? "name" : "theme"] = v; })) return;
      return send(p, "Done.");
    }
    case "link": {
      const [d, to] = arg.trim().split(/\s+/); const dir = d ? dirOf(d) : undefined;
      if (!dir || !to) return send(p, "Usage: link <dir> <room>   (room in this domain, or area/room anywhere)");
      if (!wizEdit(p, (a) => { const r = a.rooms.find((x: any) => `${a.id}/${x.id}` === p.room); if (!r) return "Not in your domain."; r.exits[dir] = to; })) return;
      return send(p, `Exit ${DIRS[dir]!.label} now leads to ${to}.`);
    }
    case "unlink": {
      const dir = dirOf(arg.trim()); if (!dir) return send(p, "Usage: unlink <dir>");
      if (!wizEdit(p, (a) => { const r = a.rooms.find((x: any) => `${a.id}/${x.id}` === p.room); if (!r || !r.exits[dir]) return "No such exit here."; delete r.exits[dir]; })) return;
      return send(p, "Exit removed.");
    }
    case "spawn": {
      const [m, n = "1"] = arg.trim().split(/\s+/); const count = Math.max(1, Math.min(5, Math.round(Number(n)) || 1));
      if (!m) return send(p, `Usage: spawn <monster> [count]. Monsters: ${[...world.monsters.keys()].join(", ")}`);
      if (!wizEdit(p, (a) => { const r = a.rooms.find((x: any) => `${a.id}/${x.id}` === p.room); if (!r) return "Not in your domain."; r.spawns = (r.spawns ?? []).filter((s: any) => s.monster !== m); r.spawns.push({ monster: m, count }); })) return;
      return send(p, `${count} x ${m} will lurk here.`);
    }
    case "unspawn": {
      if (!wizEdit(p, (a) => { const r = a.rooms.find((x: any) => `${a.id}/${x.id}` === p.room); if (!r) return "Not in your domain."; r.spawns = (r.spawns ?? []).filter((s: any) => s.monster !== arg.trim()); })) return;
      return send(p, "Done.");
    }
    case "place": case "unplace": {
      const id = arg.trim(); if (!id) return send(p, `Usage: ${cmd} <item id>. Items: ${[...world.items.values()].filter((i) => !i.bound && !i.archOnly && !i.instantKill).map((i) => i.id).join(", ")}`);
      if (!wizEdit(p, (a) => { const r = a.rooms.find((x: any) => `${a.id}/${x.id}` === p.room); if (!r) return "Not in your domain."; r.items = r.items ?? [];
        if (cmd === "place") r.items.push(id); else { const i = r.items.indexOf(id); if (i < 0) return "That isn't placed here."; r.items.splice(i, 1); } })) return;
      return send(p, "Done.");
    }
  }
}

/** Out-of-band scene description for the browser client: one line starting with \x01, ignored by telnet users. */
function sceneOf(p: Player) {
  const r = world.rooms.get(p.room)!;
  const groups = new Map<string, { id: string; sprite?: string; name: string; n: number }>();
  for (const m of mobsOf(p.room)) groups.set(m.def.id, { id: m.def.id, sprite: m.def.sprite, name: m.def.name, n: (groups.get(m.def.id)?.n ?? 0) + 1 });
  const body = corpsesIn(p.room)[0];
  return {
    room: r.key, name: r.name, theme: r.theme ?? r.area, exits: Object.keys(r.exits),
    mobs: [...groups.values()], npcs: r.npcs.map((n) => ({ id: n.id, name: n.name, sprite: n.sprite })),
    items: floorOf(p.room).length, corpse: body ? (isPile(body) ? "pile" : "corpse") : null,
    fight: p.fighting?.def.id ?? null, hp: Math.round((Math.max(0, hpOf(p)) / maxHp(p)) * 100),
    me: {
      name: p.name, level: level(p), cls: cls(p)?.name ?? "", race: race(p)?.name ?? "", wiz: isWizard(p),
      hp: Math.max(0, hpOf(p)), hpMax: maxHp(p), mp: manaOf(p), mpMax: maxMana(p), food: foodWord(foodOf(p)), gold: gold(p),
      xp: p.acct.xp ?? 0, xpNext: xpFor(level(p)), weight: carried(p), cap: capacity(p),
      inv: invOf(p).map((id) => ({ id, name: world.items.get(id)?.name ?? id, kind: world.items.get(id)?.kind ?? "misc", worn: Object.values(equipped(p)).includes(id) })),
    },
  };
}
const emitScene = (p: Player) => { if (p.web && !p.sock.writableEnded) p.sock.write("\x01" + JSON.stringify(sceneOf(p)) + "\r\n"); };

function describe(p: Player): string {
  const r = world.rooms.get(p.room)!;
  const exits = Object.keys(r.exits).map((d) => Object.values(DIRS).find((x) => x.dir === d)!.label);
  const others = [...players].filter((o) => o !== p && o.room === p.room).map((o) => `${o.name} is here.`);
  const groups = new Map<string, { def: Monster; n: number }>();
  for (const m of mobsOf(p.room)) groups.set(m.def.id, { def: m.def, n: (groups.get(m.def.id)?.n ?? 0) + 1 });
  const mobs = [...groups.values()].map(({ def: m, n }) => {
    const stats = isC64(p) ? "" : ` [AC ${m.ac}, HD ${m.hitDice}${m.tags.length ? ", " + m.tags.join("/") : ""}]`;
    return `${n > 1 ? `${n}x ` : "A "}${m.name} ${n > 1 ? "lurk" : "lurks"} here.${stats}`;
  });
  if (p.fighting) mobs.push(`You are fighting the ${p.fighting.def.name}.`);
  const bookHere = r.book ? world.books.get(r.book) : undefined;
  const npcs = r.npcs.map((n) => `${n.name} is here. (talk ${n.id})`);
  const bodies = corpsesIn(p.room).map((c) => isPile(c) ? `A pile of loot lies here, all that remains of ${c.ownerName}. ('loot')` : `The corpse of ${c.ownerName} lies here.${c.ownerKey === p.acct.key ? " It's yours: 'loot' to recover your things." : ""}`);
  const ground = floorOf(p.room).map((i) => world.items.get(i)?.name).filter(Boolean);
  return [`\n== ${r.name} ==`, r.description, ...(ground.length ? [`On the ground: ${ground.join(", ")}.`] : []), ...(bookHere ? [`A gamebook rests here: "${bookHere.name}". (read)`] : []), ...others, ...npcs, ...mobs, ...bodies, `Exits: ${exits.join(", ") || "none"}`].join("\n");
}

function look(p: Player) {
  send(p, describe(p));
  const r = world.rooms.get(p.room)!;
  tip(p, "move", "Type a direction (n, s, e, w, u, d) to walk. 'help' lists commands, 'mode commodore' switches to old-school.");
  if (mobsOf(p.room).length) tip(p, "monster", "Monsters show their stats ('? ac' explains them). 'attack <name>' to fight, 'flee' to run, 'score' for your health.");
  if (floorOf(p.room).length) tip(p, "items", "Pick things up with 'get <item>', check your pack with 'i', look closer with 'examine <item>'.");
  if (r.npcs.length) tip(p, "npc", "Some people here will talk: 'talk <name>', then pick numbered replies.");
  if (r.book) tip(p, "book", "A gamebook is a choose-your-own-adventure. 'read' it, then type the number of each choice. 'leave' closes it.");
  if (r.exits.u || r.exits.d) tip(p, "stairs", "'u' and 'd' mean up and down, for stairs and ladders.");
}

function handle(p: Player, line: string) {
  const [cmd = "", ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ");
  const step = DIRS[cmd.toLowerCase()] ?? (cmd.toLowerCase() === "go" ? DIRS[arg.toLowerCase()] : undefined);
  const here = world.rooms.get(p.room)!;
  if (step) {
    const to = here.exits[step.dir];
    if (!to) return send(p, "You can't go that way.");
    if (p.fighting) return send(p, "You can't just walk away from a fight! Try 'flee'.");
    tell(p.room, `${p.name} leaves ${step.label}.`, p);
    p.room = resolveExit(here, to);
    tell(p.room, `${p.name} arrives.`, p);
    save(p);
    questVisit(p, p.room);
    return look(p);
  }
  if (WIZ_CMDS.has(cmd.toLowerCase())) return wizard(p, cmd.toLowerCase(), arg);
  switch (cmd.toLowerCase()) {
    case "": return;
    case "look": case "l": return look(p);
    case "say": case "'": if (!arg) return send(p, "Say what?");
      tell(p.room, `${p.name} says: ${arg}`, p); return send(p, `You say: ${arg}`);
    case "shout": case "yell": if (!arg) return send(p, "Shout what?");
      // Heard everywhere in the same area, like a village bell.
      for (const o of players) if (o !== p && world.rooms.get(o.room)!.area === here.area) send(o, `${p.name} shouts: ${arg.toUpperCase()}!`);
      return send(p, `You shout: ${arg.toUpperCase()}!`);
    case "gossip": case "chat": if (!arg) return send(p, "Gossip what?");
      // Global channel across every area.
      for (const o of players) send(o, `[gossip] ${p.name}: ${arg}`);
      return;
    case "who": return send(p, ["Adventurers online:", ...[...players].map((o) => `  ${(o.name + (isWizard(o) ? "*" : "")).padEnd(14)} L${String(level(o)).padEnd(2)} ${(cls(o)?.name ?? "-").padEnd(8)} ${o.who.padEnd(20)} ${world.rooms.get(o.room)!.name}`)].join("\n"));
    case "help": return send(p, "Commands: look, loot/get all/corpse, makewiz/wizlist/visit, attack/flee/wimpy/score, wield/wear/remove/eq, use, list/buy/sell, spells/learn/cast, quests/accept/complete/abandon, i (inventory), get/drop/examine <item>, n/s/e/w/u/d (or go <dir>), say <text>, shout <text> (whole area), gossip <text> (everyone), who, save, mode, ? <term>, quit");
    case "inventory": case "inv": case "i": {
      const inv = invOf(p);
      return send(p, inv.length ? ["You are carrying:", ...inv.map((i) => `  ${world.items.get(i)?.name ?? i}${Object.values(equipped(p)).includes(i) ? (world.items.get(i)?.kind === "weapon" ? " (wielded)" : " (worn)") : ""}`), `Gold: ${gold(p)}   Weight: ${carried(p)}/${capacity(p)}`].join("\n") : `You are carrying nothing. Gold: ${gold(p)}   Weight: 0/${capacity(p)}`);
    }
    case "get": case "take": case "loot": {
      if (cmd.toLowerCase() === "loot" || /\b(corpse|pile|body|remains)\b/i.test(arg)) {
        const present = lootCorpses(p);
        if (present) { if (cmd.toLowerCase() !== "loot" || !floorOf(p.room).length) return; }
        else if (cmd.toLowerCase() !== "loot") return send(p, "There is no corpse here.");
      }
      if (!arg && cmd.toLowerCase() !== "loot") return send(p, "Get what?");
      const f = floorOf(p.room);
      if (!arg || arg.toLowerCase() === "all") {
        const taken: string[] = []; let reserved = 0, heavy = 0;
        for (const i of [...f]) {
          const it = world.items.get(i); if (!it) continue;
          if (lootBlocked(p, p.room, i)) { reserved++; continue; }
          if (carried(p) + it.weight > capacity(p)) { heavy++; continue; }
          if (!it.respawns) f.splice(f.indexOf(i), 1);
          releaseLock(p, p.room, i); invOf(p).push(i); taken.push(it.name);
        }
        if (!taken.length && !reserved && !heavy) return send(p, "There is nothing here to take.");
        if (taken.length) { save(p); tell(p.room, `${p.name} gathers up the loot.`, p); }
        return send(p, [taken.length ? `You take: ${taken.join(", ")}.` : "", reserved ? `(${reserved} item(s) are reserved for the victors.)` : "", heavy ? `(${heavy} item(s) are too heavy to carry.)` : ""].filter(Boolean).join("\n"));
      }
      const id = findItem(f, arg);
      if (!id) return send(p, "You see no such thing here.");
      const it = world.items.get(id)!;
      if (lootBlocked(p, p.room, id)) return send(p, "That loot is reserved for those who earned it, for a little longer.");
      if (carried(p) + it.weight > capacity(p)) return send(p, `${it.name} is too heavy; you're carrying ${carried(p)}/${capacity(p)}.`);
      if (!it.respawns) f.splice(f.indexOf(id), 1);
      releaseLock(p, p.room, id);
      invOf(p).push(id); save(p);
      tell(p.room, `${p.name} picks up ${it.name}.`, p);
      return send(p, `You take ${it.name}.${it.respawns ? " Another one appears in its place." : ""}`);
    }
    case "drop": {
      if (!arg) return send(p, "Drop what?");
      const inv = invOf(p), id = findItem(inv, arg);
      if (!id) return send(p, "You aren't carrying that.");
      if (isWorn(p, id)) return send(p, "Remove it first.");
      if (world.items.get(id)?.bound) return send(p, "It refuses to leave you.");
      inv.splice(inv.indexOf(id), 1); floorOf(p.room).push(id); save(p);
      const it = world.items.get(id)!;
      tell(p.room, `${p.name} drops ${it.name}.`, p);
      return send(p, `You drop ${it.name}.`);
    }
    case "examine": case "x": {
      if (!arg) return send(p, "Examine what?");
      const id = findItem(invOf(p), arg) ?? findItem(floorOf(p.room), arg);
      const it = id && world.items.get(id);
      if (!it) return send(p, "You see no such thing.");
      return send(p, `${it.name}\n${it.description}${isC64(p) ? "" : `\n[${it.kind}, worth ${it.value}gp, weight ${it.weight}${it.minLevel > 1 ? `, needs level ${it.minLevel}` : ""}]`}`);
    }
    case "attack": case "kill": case "k": {
      if (!arg) return send(p, "Attack what?");
      if (p.fighting) return send(p, "You're already fighting!");
      const n = arg.toLowerCase();
      const m = mobsOf(p.room).find((x) => x.def.id === n || x.def.name.toLowerCase().includes(n));
      if (!m) return send(p, "You see no such creature here.");
      p.fighting = m;
      tell(p.room, `${p.name} attacks the ${m.def.name}!`, p);
      send(p, `You attack the ${m.def.name}!`);
      return round(p);
    }
    case "flee": case "run": return tryFlee(p);
    case "wimpy": {
      if (!arg) return send(p, p.acct.wimpy ? `You will flee automatically at ${p.acct.wimpy}% HP. ('wimpy 0' turns it off)` : "Auto-flee is off. 'wimpy 30' makes you run at 30% HP.");
      const n = Math.round(Number(arg));
      if (!Number.isFinite(n) || n < 0 || n > 80) return send(p, "Pick a percentage from 0 to 80.");
      p.acct.wimpy = n; save(p);
      return send(p, n ? `You will flee automatically at ${n}% HP. (It can fail; fleeing isn't guaranteed.)` : "Auto-flee off. Be brave.");
    }
    case "score": case "sc": return send(p, `${p.name}, level ${level(p)} ${race(p)?.name ?? ""} ${cls(p)?.name ?? ""}\nHP ${Math.max(0, hpOf(p))}/${maxHp(p)}   MP ${manaOf(p)}/${maxMana(p)}   AC ${playerAC(p)}   Food ${foodWord(foodOf(p))}   XP ${p.acct.xp ?? 0}/${xpFor(level(p))}   Gold ${gold(p)}\nWeapon: ${weapon(p)}${isC64(p) ? "" : "  (wield a weapon for more; bare hands are 1d3)"}`);
    case "quest": case "quests": case "journal": return questLog(p);
    case "accept": {
      const q = matchQuest(offeredHere(p), arg);
      if (!q) return send(p, "No such quest is offered here. Type 'quests'.");
      if (q.minLevel > level(p)) return send(p, `You need level ${q.minLevel} for that.`);
      activeQuests(p)[q.id] = q.objectives.map(() => 0); save(p);
      send(p, `Quest accepted: ${q.name}\n${q.description}`);
      q.objectives.forEach((_, i) => send(p, objLine(p, q, i)));
      return;
    }
    case "abandon": {
      const q = matchQuest(Object.keys(activeQuests(p)).map((id) => world.quests.get(id)).filter((x): x is Quest => !!x), arg);
      if (!q || !arg) return send(p, "Abandon which quest? Type 'quests'.");
      delete activeQuests(p)[q.id]; save(p);
      return send(p, `You abandon: ${q.name}`);
    }
    case "complete": case "turnin": {
      const ready = Object.keys(activeQuests(p)).map((id) => world.quests.get(id)).filter((x): x is Quest => !!x && turnInRoom(x) === p.room && questReady(p, x));
      const q = matchQuest(ready, arg);
      if (!q) return send(p, "You have nothing to turn in here.");
      for (const o of q.objectives) if (o.type === "fetch") for (let n = 0; n < o.count; n++) invOf(p).splice(invOf(p).indexOf(o.item), 1);
      delete activeQuests(p)[q.id]; doneQuests(p).push(q.id);
      for (const i of q.reward.items) invOf(p).push(i);
      send(p, `*** Quest complete: ${q.name} ***\n${q.completion}`);
      if (q.reward.gold) { p.acct.gold = gold(p) + q.reward.gold; send(p, `You receive ${q.reward.gold} gold.`); }
      if (q.reward.items.length) send(p, `You receive: ${q.reward.items.map((i) => world.items.get(i)?.name ?? i).join(", ")}`);
      return q.reward.xp ? gainXp(p, q.reward.xp) : save(p);
    }
    case "spells": case "spellbook": {
      const mine = known(p).map((id) => world.spells.get(id)).filter((s): s is Spell => !!s);
      const lines = mine.length ? ["You know:", ...mine.map((s) => spellLine(p, s))] : ["You know no spells."];
      const here = taughtHere(p);
      if (here.length) lines.push("Taught here ('learn <spell>'):", ...here.map((s) => spellLine(p, s)));
      return send(p, lines.join("\n"));
    }
    case "learn": {
      const here = taughtHere(p);
      if (!arg) return send(p, here.length ? ["Taught here:", ...here.map((s) => spellLine(p, s))].join("\n") : "Nobody here can teach you anything. Scrolls can ('learn <scroll>').");
      let s = matchSpell(here, arg), scroll: string | undefined;
      if (!s) { // maybe a scroll in the pack
        scroll = findItem(invOf(p), arg);
        const sp = scroll && world.items.get(scroll)?.teaches;
        s = sp ? world.spells.get(sp) : undefined;
        if (!s) return send(p, "There's no such lesson here, and you hold no such scroll.");
      }
      if (known(p).includes(s.id)) return send(p, "You already know that spell.");
      if (!usable(p, s)) return send(p, `${s.name} is not the way of the ${cls(p)?.name ?? "adventurer"}.`);
      if (s.minLevel > level(p)) return send(p, `${s.name} is too advanced; you need level ${s.minLevel}.`);
      if (scroll) { invOf(p).splice(invOf(p).indexOf(scroll), 1); send(p, "The scroll crumbles to dust as you read it."); }
      return learnSpell(p, s);
    }
    case "cast": case "c": {
      const [sname = "", ...trest] = arg.split(/\s+/);
      if (!sname) return send(p, "Cast what? Type 'spells'.");
      const s = matchSpell(known(p).map((id) => world.spells.get(id)).filter((x): x is Spell => !!x), sname);
      if (!s) return send(p, "You don't know that spell.");
      return castSpell(p, s, trest.join(" "));
    }
    case "wield": case "wear": case "equip": case "hold": {
      const id = findItem(invOf(p), arg), it = id ? world.items.get(id) : undefined;
      if (!id || !it) return send(p, "You aren't carrying that.");
      const slot = it.kind === "weapon" ? "weapon" : it.slot;
      if (!slot) return send(p, `You can't equip ${it.name}.`);
      if (it.minLevel > level(p)) return send(p, `${it.name} requires level ${it.minLevel}; you are level ${level(p)}.`);
      if (it.archOnly && !isArch(p)) return send(p, `${it.name} hums, unmoved. It will not answer to you.`);
      const prev = equipped(p)[slot];
      equipped(p)[slot] = id; save(p);
      return send(p, `You ${slot === "weapon" ? "wield" : "wear"} ${it.name}.${prev && prev !== id ? ` ${world.items.get(prev)?.name} goes back in your pack.` : ""}`);
    }
    case "remove": case "unwield": {
      const n = arg.toLowerCase();
      const slot = Object.keys(equipped(p)).find((s) => s === n || world.items.get(equipped(p)[s]!)?.name.toLowerCase().includes(n));
      if (!n || !slot) return send(p, "Remove what? Type 'eq'.");
      const it = world.items.get(equipped(p)[slot]!); delete equipped(p)[slot]; save(p);
      return send(p, `You remove ${it?.name ?? slot}.`);
    }
    case "equipment": case "eq": {
      const e = Object.entries(equipped(p));
      return send(p, e.length ? ["You are using:", ...e.map(([s, id]) => `  <${s}> ${world.items.get(id)?.name ?? id}`), `Armor class: ${playerAC(p)}`].join("\n") : "You are using nothing. Armor class: 10");
    }
    case "use": case "eat": case "drink": case "quaff": {
      const id = findItem(invOf(p), arg), it = id ? world.items.get(id) : undefined;
      if (!id || !it) return send(p, "You aren't carrying that.");
      if (!it.heals && !it.nourishes) return send(p, `You can't use ${it.name} that way.`);
      const useful = (it.heals && hpOf(p) < maxHp(p)) || (it.nourishes && foodOf(p) < 100);
      if (!useful) return send(p, it.nourishes ? "You are too full to eat another bite." : "You are already at full health.");
      invOf(p).splice(invOf(p).indexOf(id), 1);
      const parts: string[] = [];
      if (it.heals) { const h = Math.max(1, rollDice(it.heals)); p.acct.hp = Math.min(maxHp(p), hpOf(p) + h); parts.push(`recover ${h} HP`); }
      if (it.nourishes) { p.acct.food = Math.min(100, foodOf(p) + it.nourishes); parts.push(`feel ${foodWord(foodOf(p)) === "Full" ? "full" : "less hungry"}`); }
      save(p);
      return send(p, `You consume ${it.name} and ${parts.join(" and ")}. ${promptOf(p)}`);
    }
    case "list": case "shop": {
      const sh = here.shop; if (!sh) return send(p, "There is no shop here.");
      return send(p, ["For sale ('buy <item>'); I also buy your things at half price ('sell <item>'):", ...sh.sells.map((i) => { const it = world.items.get(i)!; return `  ${it.name.padEnd(24)} ${String(it.value).padStart(4)} gp${it.minLevel > 1 ? `  (needs L${it.minLevel})` : ""}`; }), `You have ${gold(p)} gp.`].join("\n"));
    }
    case "buy": {
      const sh = here.shop; if (!sh) return send(p, "There is no shop here.");
      const id = findItem(sh.sells, arg), it = id ? world.items.get(id) : undefined;
      if (!id || !it) return send(p, "Nobody here sells that. Type 'list'.");
      if (gold(p) < it.value) return send(p, `That costs ${it.value} gp; you have ${gold(p)}.`);
      if (carried(p) + it.weight > capacity(p)) return send(p, `You can't carry that much (${carried(p)}/${capacity(p)}).`);
      p.acct.gold = gold(p) - it.value; invOf(p).push(id); save(p);
      return send(p, `You buy ${it.name} for ${it.value} gp.${it.kind === "weapon" || it.slot ? " (Use 'wield' / 'wear' to equip it.)" : ""}`);
    }
    case "sell": {
      if (!here.shop) return send(p, "There is no shop here.");
      const id = findItem(invOf(p), arg), it = id ? world.items.get(id) : undefined;
      if (!id || !it) return send(p, "You aren't carrying that.");
      if (isWorn(p, id)) return send(p, "Remove it first.");
      if (it.bound) return send(p, "It refuses to leave you.");
      const price = Math.floor(it.value / 2);
      if (price < 1) return send(p, `The shopkeeper shrugs: ${it.name} isn't worth anything to him.`);
      invOf(p).splice(invOf(p).indexOf(id), 1); p.acct.gold = gold(p) + price; save(p);
      return send(p, `You sell ${it.name} for ${price} gp.`);
    }
    case "talk": case "speak": {
      const n = arg.toLowerCase().replace(/^to\s+/, "");
      if (!here.npcs.length) return send(p, "There is no one here to talk to.");
      if (!n && here.npcs.length > 1) return send(p, `Talk to whom? (${here.npcs.map((x) => x.id).join(", ")})`);
      const npc = here.npcs.find((x) => !n || x.id === n || x.name.toLowerCase().includes(n));
      if (!npc) return send(p, "They don't seem to be here.");
      const b = world.books.get(npc.talk);
      if (!b) return send(p, `${npc.name} has nothing to say.`);
      if (p.fighting) return send(p, "Not in the middle of a fight!");
      p.book = { id: b.id, at: b.start, flags: [] };
      send(p, `You approach ${npc.name}. ${npc.description}`);
      return showPassage(p);
    }
    case "read": case "open": {
      const b = here.book ? world.books.get(here.book) : undefined;
      if (!b) return send(p, "There is nothing here to read.");
      if (p.fighting) return send(p, "Not in the middle of a fight!");
      p.book = { id: b.id, at: b.start, flags: [] };
      send(p, `You open "${b.name}"...`);
      return showPassage(p);
    }
    case "corpse": {
      const mine = corpses.filter((c) => c.ownerKey === p.acct.key && (c.items.length || c.gold));
      if (!mine.length) return send(p, "You have no corpse to recover.");
      return send(p, mine.map((c) => `Your corpse lies in ${world.rooms.get(c.room)?.name ?? "the wilds"} (${isPile(c) ? "rotted into a free-for-all pile" : `rots in ${Math.ceil((c.rotsAt - Date.now()) / 60000)} min`}).`).join("\n"));
    }
    case "mode": {
      const want = arg.toLowerCase();
      if (want !== "modern" && want !== "commodore") return send(p, `Mode is ${p.acct.mode ?? "modern"}. Use: mode modern | mode commodore`);
      p.acct.mode = want; save(p);
      return send(p, want === "commodore" ? "**** COMMODORE 64 BASIC V2 ****\n64K RAM SYSTEM  38911 BASIC BYTES FREE" : "Modern mode: stats and tips are on.");
    }
    case "?": case "explain": {
      if (!arg) return send(p, `Terms: ${[...world.glossary.keys()].sort().join(", ")}\nTry: ? ac`);
      const g = world.glossary.get(arg.toLowerCase());
      return send(p, g ? `${g.title}\n${g.text}` : `No entry for "${arg}". Type ? for the list.`);
    }
    case "save": save(p); return send(p, "Character saved.");
    case "quit": save(p); send(p, "Farewell."); return p.sock.end();
    default: return send(p, "Huh? Try 'help'.");
  }
}

// Hot reload: edit any pack file and the world updates live. Bad edits are rejected, the old world stays.
let timer: NodeJS.Timeout | undefined;
/** Reload packs from disk. Returns false (and keeps the old world) if the new one doesn't validate. */
function reloadNow(quiet = false): boolean {
  const next = loadWorld(PACKS);
  if (next.errors.length) {
    console.error("reload rejected:\n" + next.errors.join("\n"));
    if (!quiet) for (const p of players) send(p, "[system] World reload failed; keeping the old world.");
    return false;
  }
  world = next;
  for (const p of players) {
    if (!world.rooms.has(p.room)) { p.room = world.start; send(p, "[system] The world shifts around you...\n" + describe(p)); }
    else if (!quiet) send(p, "[system] The world has been reshaped.");
  }
  console.log("world reloaded");
  return true;
}
watch(PACKS, { recursive: true }, () => {
  if (Date.now() < selfWrite) return; // the server wrote this itself and already reloaded
  clearTimeout(timer);
  timer = setTimeout(() => reloadNow(), 150);
});

const BANNER = [
  "",
  "    POOLVX  --  VAX 6000-510  --  VAX/VMS V5.5-2",
  "",
  "    Unauthorized access is prohibited. All sessions are logged.",
  "    Log in with your campus e-mail address (user@school.edu).",
  "",
].join("\r\n");

/** j.smith@example.edu -> j*****h@e******.edu. Only this masked form is ever kept. */
export function obfuscate(raw: string): string {
  const m = raw.trim().toLowerCase().match(/^([^@\s]+)@([^@\s]+)$/);
  if (!m) return "(no address)";
  const mask = (t: string) => (t.length <= 2 ? t[0]! + "*" : t[0]! + "*".repeat(t.length - 2) + t.at(-1));
  const labels = m[2]!.split(".");
  const tld = labels.length > 1 ? "." + labels.pop() : "";
  return mask(m[1]!) + "@" + labels.map((l, i) => (i === labels.length - 1 ? l[0]! + "*".repeat(Math.max(l.length - 1, 1)) : l[0]! + "*")).join(".") + tld;
}

const vmsTime = (d = new Date()) => {
  const mon = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getMonth()];
  const t = (n: number) => String(n).padStart(2, "0");
  return `${t(d.getDate())}-${mon}-${d.getFullYear()} ${t(d.getHours())}:${t(d.getMinutes())}`;
};

type Stage = "user" | "pass" | "newpass" | "confirm" | "name" | "race" | "class" | "play";
const raceMenu = () =>
  "\r\nChoose your race:\r\n" +
  [...world.races.values()].map((r, i) => `  ${i + 1}) ${r.name.padEnd(8)} ${r.description}`).join("\r\n") +
  "\r\nRace: ";
const classMenu = () =>
  "\r\nChoose your calling:\r\n" +
  [...world.classes.values()].map((c, i) => `  ${i + 1}) ${c.name.padEnd(8)} ${c.description}`).join("\r\n") +
  "\r\nClass: ";
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

createServer((sock) => {
  sock.setEncoding("latin1"); // keeps telnet IAC bytes intact so they can be stripped
  let player: Player | undefined;
  let stage: Stage = "user";
  let key = "", who = "", pending = "", pendingName = "", pickRace = "";
  let webMode = false; // set by the browser bridge with a first line of "@web"
  let acct: Account | null = null;
  let fails = 0;
  let buf = "";
  const hide = () => sock.write(Buffer.from([255, 251, 1])); // IAC WILL ECHO: client stops echoing (raw bytes, not UTF-8 text)
  const show = () => sock.write(Buffer.concat([Buffer.from([255, 252, 1]), Buffer.from("\r\n")])); // IAC WONT ECHO
  sock.write(BANNER + "\r\nUsername: ");

  const enter = (a: Account) => {
    // One session per account: a second login boots the first.
    for (const o of players) if (o.acct.key === a.key) { send(o, "[system] Logged in from another session."); players.delete(o); o.sock.end(); }
    a.lastLogin = new Date().toISOString();
    if (isArchKey(a.key) && world.items.has("blade_of_authority") && !(a.inventory ?? []).includes("blade_of_authority")) {
      a.inventory = [...(a.inventory ?? []), "blade_of_authority"];
      a.equipped = { ...(a.equipped ?? {}), weapon: "blade_of_authority" };
    }
    player = { name: a.name, room: world.rooms.has(a.room) ? a.room : world.start, sock, who, acct: a, web: webMode };
    players.add(player);
    stage = "play";
    save(player);
    tell(player.room, `${player.name} appears in a swirl of mist.`, player);
    look(player);
    emitScene(player);
  };

  const line$ = (line: string) => {
    switch (stage) {
      case "user":
        if (line.trim() === "@web") { webMode = true; return; }
        if (!EMAIL.test(line.trim())) return void sock.write("Please log in with an e-mail address (user@school.edu).\r\nUsername: ");
        key = keyOf(line); acct = loadAccount(key); who = acct?.masked ?? obfuscate(line);
        stage = acct ? "pass" : "newpass";
        if (!acct) sock.write(`\r\n%LOGIN-I-NEWACCT, no account for ${who}; one will be created.\r\nChoose a password (6+ characters): `);
        else sock.write("Password: ");
        return hide();
      case "pass":
        show();
        if (acct && verify(acct, line)) {
          sock.write(`\r\n    Welcome to VAX/VMS V5.5-2 on node POOLVX\r\n    %LOGIN-I-LOGGEDIN, ${who} logged in at ${vmsTime()}\r\n    Last interactive login on ${vmsTime(new Date(acct.lastLogin))}\r\n\r\n$ RUN POOLRAD\r\n`);
          if (world.races.size && !acct.race) { stage = "race"; return void sock.write(raceMenu()); }
          if (world.classes.size && !acct.class) { stage = "class"; return void sock.write(classMenu()); }
          return enter(acct);
        }
        if (++fails >= 3) { sock.write("\r\n%LOGIN-F-INVLOGIN, user authorization failure\r\n"); return void sock.end(); }
        stage = "user";
        return void sock.write("\r\nUser authentication failure\r\n\r\nUsername: ");
      case "newpass":
        show();
        if (line.length < 6) { hide(); return void sock.write("Too short. Choose a password (6+ characters): "); }
        pending = line; stage = "confirm"; hide();
        return void sock.write("Re-enter password: ");
      case "confirm":
        show();
        if (line !== pending) { stage = "newpass"; hide(); return void sock.write("Passwords do not match. Choose a password (6+ characters): "); }
        stage = "name";
        return void sock.write("\r\n$ RUN POOLRAD\r\n\r\nBy what name are you known? ");
      case "name": {
        const name = line.trim().replace(/[^A-Za-z]/g, "").slice(0, 16);
        if (name.length < 2) return void sock.write("Letters only, at least 2. Name? ");
        const proper = name[0]!.toUpperCase() + name.slice(1).toLowerCase();
        if (nameTaken(proper)) return void sock.write("That name is taken. Name? ");
        pendingName = proper;
        if (world.races.size) { stage = "race"; return void sock.write(raceMenu()); }
        if (world.classes.size) { stage = "class"; return void sock.write(classMenu()); }
        return enter(createAccount(key, who, pending, proper, world.start));
      }
      case "race": {
        const q = line.trim().toLowerCase();
        const list = [...world.races.values()];
        const r = list[+q - 1] ?? list.find((x) => x.id === q || x.name.toLowerCase() === q);
        if (!r) return void sock.write("Choose by number or name: ");
        pickRace = r.id;
        if (acct) acct.race = r.id;
        if (world.classes.size && !acct?.class) { stage = "class"; return void sock.write(classMenu()); }
        if (!acct) acct = createAccount(key, who, pending, pendingName, world.start);
        acct.race = r.id; saveAccount(acct);
        sock.write(`\r\nYou are a ${r.name}.\r\n`);
        return enter(acct);
      }
      case "class": {
        const q = line.trim().toLowerCase();
        const list = [...world.classes.values()];
        const c = list[+q - 1] ?? list.find((x) => x.id === q || x.name.toLowerCase() === q);
        if (!c) return void sock.write("Choose by number or name: ");
        if (!acct) acct = createAccount(key, who, pending, pendingName, world.start);
        acct.class = c.id;
        if (pickRace) acct.race = pickRace;
        acct.inventory = [...(acct.inventory ?? []), ...c.startItems];
        const w0 = c.startItems.find((i) => world.items.get(i)?.kind === "weapon");
        if (w0) acct.equipped = { ...(acct.equipped ?? {}), weapon: w0 };
        acct.hp = undefined; acct.mana = undefined; // recompute at the class's full values
        saveAccount(acct);
        sock.write(`\r\nYou walk the path of the ${c.name}.\r\n`);
        return enter(acct);
      }
      case "play":
        if (player!.book) { bookInput(player!, line); emitScene(player!); return; }
        handle(player!, line);
        emitScene(player!);
        if (sock.writableEnded || !players.has(player!)) return;
        return void sock.write(isC64(player!) ? "\r\nREADY.\r\n" : `\r\n${promptOf(player!)}\r\n`);
    }
  };

  sock.on("data", (chunk: string) => {
    buf += chunk.replace(/\xff[\xfb-\xfe]./g, ""); // strip telnet negotiation
    let i: number;
    while ((i = buf.search(/\r?\n|\r/)) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i).replace(/^(\r\n|\r|\n)/, "");
      line$(line);
    }
  });
  sock.on("close", () => {
    if (player && players.delete(player)) { save(player); tell(player.room, `${player.name} fades away.`); }
  });
  sock.on("error", () => sock.destroy());
}).listen(PORT, () => console.log(`MUD listening on :${PORT}  (try: nc localhost ${PORT})`));

// Flush every character on shutdown.
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => { for (const p of players) save(p); process.exit(0); });
