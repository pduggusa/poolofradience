import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PackManifest, MonsterFile, GlossaryFile, ItemFile, QuestFile, SpellFile, ClassFile, RaceFile, BookFile, SpriteFile, Area, type Item, type Quest, type Spell, type ClassDef, type RaceDef, type Gamebook, type Monster, type Room } from "./schema.js";

export interface World {
  monsters: Map<string, Monster>;
  rooms: Map<string, Room & { key: string; area: string }>; // key = "area/room"
  glossary: Map<string, { title: string; text: string }>;
  items: Map<string, Item>;
  quests: Map<string, Quest>;
  spells: Map<string, Spell>;
  classes: Map<string, ClassDef>;
  races: Map<string, RaceDef>;
  books: Map<string, Gamebook>;
  sprites: Map<string, string[]>; // id -> rows
  areas: Map<string, string>; // area id -> display name
  areaStart: Map<string, string>; // area id -> first room key (where `visit` lands)
  start: string;
  respawn: string; // where the dead wake
  errors: string[];
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** Load every pack under packsDir into one World. Never throws: problems go in `errors`. */
export function loadWorld(packsDir: string): World {
  const w: World = { monsters: new Map(), rooms: new Map(), glossary: new Map(), items: new Map(), quests: new Map(), spells: new Map(), classes: new Map(), races: new Map(), books: new Map(), sprites: new Map(), areas: new Map(), areaStart: new Map(), start: "", respawn: "", errors: [] };
  for (const dir of readdirSync(packsDir)) {
    const base = join(packsDir, dir);
    if (!existsSync(join(base, "pack.json"))) continue;
    try {
      const pack = PackManifest.parse(readJson(join(base, "pack.json")));
      for (const f of pack.monsters)
        for (const m of MonsterFile.parse(readJson(join(base, f))).monsters) w.monsters.set(m.id, m);
      for (const f of pack.items)
        for (const it of ItemFile.parse(readJson(join(base, f))).items) w.items.set(it.id, it);
      for (const f of pack.art)
        for (const [k, v] of Object.entries(SpriteFile.parse(readJson(join(base, f))).sprites)) {
          const wd = v.rows[0]!.length;
          if (v.rows.some((r) => r.length !== wd)) w.errors.push(`sprite ${k}: rows are not all ${wd} wide`);
          w.sprites.set(k, v.rows);
        }
      for (const f of pack.books)
        for (const b of BookFile.parse(readJson(join(base, f))).books) w.books.set(b.id, b);
      for (const f of pack.races)
        for (const r of RaceFile.parse(readJson(join(base, f))).races) w.races.set(r.id, r);
      for (const f of pack.classes)
        for (const c of ClassFile.parse(readJson(join(base, f))).classes) w.classes.set(c.id, c);
      for (const f of pack.spells)
        for (const sp of SpellFile.parse(readJson(join(base, f))).spells) w.spells.set(sp.id, sp);
      for (const f of pack.quests)
        for (const q of QuestFile.parse(readJson(join(base, f))).quests) w.quests.set(q.id, q);
      for (const f of pack.glossary)
        for (const [k, v] of Object.entries(GlossaryFile.parse(readJson(join(base, f))).terms)) w.glossary.set(k, v);
      for (const f of pack.areas) {
        const area = Area.parse(readJson(join(base, f)));
        w.areas.set(area.id, area.name);
        w.areaStart.set(area.id, `${area.id}/${area.rooms[0]!.id}`);
        for (const r of area.rooms) w.rooms.set(`${area.id}/${r.id}`, { ...r, key: `${area.id}/${r.id}`, area: area.id });
        if (!w.start && area.start) w.start = `${area.id}/${area.start}`;
      }
    } catch (e) {
      w.errors.push(`${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // exits must resolve; bare ids are relative to the room's own area
  for (const r of w.rooms.values())
    for (const [d, to] of Object.entries(r.exits)) {
      if (!w.rooms.has(resolveExit(r, to!))) w.errors.push(`${r.key}: exit ${d} -> "${to}" does not exist`);
    }
  for (const r of w.rooms.values())
    for (const s of r.spawns) if (!w.monsters.has(s.monster)) w.errors.push(`${r.key}: unknown monster "${s.monster}"`);
  for (const r of w.rooms.values())
    for (const i of r.items) if (!w.items.has(i)) w.errors.push(`${r.key}: unknown item "${i}"`);
  for (const m of w.monsters.values())
    for (const l of m.loot) if (!w.items.has(l.item)) w.errors.push(`monster ${m.id}: loot references unknown item "${l.item}"`);
  for (const r of w.rooms.values())
    for (const i of r.shop?.sells ?? []) if (!w.items.has(i)) w.errors.push(`${r.key}: shop sells unknown item "${i}"`);
  for (const q of w.quests.values()) {
    const bad = (m: string) => w.errors.push(`quest ${q.id}: ${m}`);
    if (!w.rooms.has(q.offeredIn)) bad(`offeredIn "${q.offeredIn}" does not exist`);
    if (q.turnIn && !w.rooms.has(q.turnIn)) bad(`turnIn "${q.turnIn}" does not exist`);
    for (const o of q.objectives) {
      if (o.type === "kill" && !w.monsters.has(o.monster)) bad(`unknown monster "${o.monster}"`);
      if (o.type === "fetch" && !w.items.has(o.item)) bad(`unknown item "${o.item}"`);
      if (o.type === "visit" && !w.rooms.has(o.room)) bad(`unknown room "${o.room}"`);
    }
    for (const i of q.reward.items) if (!w.items.has(i)) bad(`unknown reward item "${i}"`);
  }
  for (const sp of w.spells.values()) {
    if (sp.taughtIn && !w.rooms.has(sp.taughtIn)) w.errors.push(`spell ${sp.id}: taughtIn "${sp.taughtIn}" does not exist`);
    if (sp.effect.type === "conjure" && !w.items.has(sp.effect.item)) w.errors.push(`spell ${sp.id}: unknown conjured item "${sp.effect.item}"`);
  }
  for (const r of w.rooms.values()) for (const n of r.npcs) if (!w.books.has(n.talk)) w.errors.push(`${r.key}: npc ${n.id} talks via unknown book "${n.talk}"`);
  for (const r of w.rooms.values()) if (r.book && !w.books.has(r.book)) w.errors.push(`${r.key}: unknown book "${r.book}"`);
  for (const b of w.books.values()) {
    const ids = new Set(b.passages.map((p) => p.id));
    const bad = (m: string) => w.errors.push(`book ${b.id}: ${m}`);
    if (!ids.has(b.start)) bad(`start passage "${b.start}" does not exist`);
    for (const p of b.passages) {
      if (p.end && p.choices.length) bad(`${p.id} is an ending but has choices`);
      if (!p.end && !p.choices.length) bad(`${p.id} is a dead end (no choices and no end)`);
      for (const c of p.choices) {
        if (!ids.has(c.to)) bad(`${p.id}: choice leads to unknown passage "${c.to}"`);
        for (const i of [c.gives, c.takes, c.requires?.item]) if (i && !w.items.has(i)) bad(`${p.id}: unknown item "${i}"`);
      }
      for (const i of p.reward?.items ?? []) if (!w.items.has(i)) bad(`${p.id}: unknown reward item "${i}"`);
    }
  }
  for (const m of w.monsters.values()) if (m.sprite && !w.sprites.has(m.sprite)) w.errors.push(`monster ${m.id}: unknown sprite "${m.sprite}"`);
  for (const r of w.rooms.values()) for (const n of r.npcs) if (n.sprite && !w.sprites.has(n.sprite)) w.errors.push(`${r.key}: npc ${n.id} has unknown sprite "${n.sprite}"`);
  for (const c of w.classes.values())
    for (const i of c.startItems) if (!w.items.has(i)) w.errors.push(`class ${c.id}: unknown start item "${i}"`);
  for (const sp of w.spells.values())
    for (const c of sp.classes) if (!w.classes.has(c)) w.errors.push(`spell ${sp.id}: unknown class "${c}"`);
  for (const it of w.items.values()) if (it.teaches && !w.spells.has(it.teaches)) w.errors.push(`item ${it.id}: teaches unknown spell "${it.teaches}"`);
  w.respawn = [...w.rooms.values()].find((r) => r.respawn)?.key ?? w.start;
  if (!w.start) w.errors.push("no area declares a start room");
  return w;
}

export const resolveExit = (from: { area: string }, to: string) => (to.includes("/") ? to : `${from.area}/${to}`);
