import { z } from "zod";

// Content ids: lowercase, digits, underscores. Referenced across files within a pack.
const id = z.string().regex(/^[a-z0-9_]+$/, "ids are lowercase letters, digits, underscores");
const dice = z.string().regex(/^\d+d\d+([+-]\d+)?$/, 'dice look like "1d8" or "2d6+1"');

export const PackManifest = z.object({
  id,
  name: z.string(),
  version: z.string(),
  author: z.string().optional(),
  engine: z.string().describe("minimum engine version"),
  depends: z.array(id).default([]),
  monsters: z.array(z.string()).default([]), // paths to monster files, relative to pack
  dungeons: z.array(z.string()).default([]), // paths to dungeon files, relative to pack
  areas: z.array(z.string()).default([]), // paths to MUD area files, relative to pack
  glossary: z.array(z.string()).default([]), // paths to glossary files, relative to pack
  items: z.array(z.string()).default([]), // paths to item files, relative to pack
  quests: z.array(z.string()).default([]), // paths to quest files, relative to pack
  spells: z.array(z.string()).default([]), // paths to spell files, relative to pack
  classes: z.array(z.string()).default([]), // paths to class files, relative to pack
  races: z.array(z.string()).default([]), // paths to race files, relative to pack
  books: z.array(z.string()).default([]), // paths to gamebook files, relative to pack
  art: z.array(z.string()).default([]), // paths to sprite files, relative to pack
});
export type PackManifest = z.infer<typeof PackManifest>;

// ---- Monster Manual ----
export const Monster = z.object({
  id,
  name: z.string(),
  description: z.string(),
  ac: z.number().int(), // descending AC, 1e style: lower is harder to hit
  hitDice: z.number().int().min(1),
  hpBonus: z.number().int().default(0),
  move: z.number().int().min(0),
  attacks: z.array(z.object({ name: z.string(), damage: dice, toHitBonus: z.number().int().default(0) })).min(1),
  xp: z.number().int().min(0),
  gold: dice.optional(), // gold dropped on death
  loot: z.array(z.object({ item: id, chance: z.number().min(0).max(1) })).default([]), // each entry rolls independently on death; drops land on the floor
  morale: z.number().int().min(2).max(12).default(8),
  tags: z.array(z.string()).default([]), // e.g. "undead", "beast"
  sprite: z.string().optional(),
});
export type Monster = z.infer<typeof Monster>;
export const MonsterFile = z.object({ monsters: z.array(Monster) });

// ---- Dungeons / Maps ----
// A level is an ASCII grid. '#' wall, '.' floor, '+' door, anything else must appear in `legend`.
export const Level = z.object({
  id,
  name: z.string(),
  grid: z.array(z.string()).min(1),
  legend: z
    .record(
      z.string().length(1),
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("start"), facing: z.enum(["n", "e", "s", "w"]).default("n") }),
        z.object({ type: z.literal("stairs"), to: id, toLevel: id.optional() }),
        z.object({ type: z.literal("encounter"), monsters: z.array(z.object({ id, count: dice.or(z.number().int()) })).min(1), once: z.boolean().default(true) }),
        z.object({ type: z.literal("treasure"), gold: z.number().int().min(0).default(0), items: z.array(id).default([]) }),
        z.object({ type: z.literal("message"), text: z.string() }),
        z.object({ type: z.literal("locked_door"), key: id }),
      ]),
    )
    .default({}),
});
export type Level = z.infer<typeof Level>;
export const Dungeon = z.object({ id, name: z.string(), levels: z.array(Level).min(1) });
export type Dungeon = z.infer<typeof Dungeon>;

// ---- MUD Areas (LPMud-style room graph) ----
export const Direction = z.enum(["n", "s", "e", "w", "u", "d"]);
export type Direction = z.infer<typeof Direction>;
export const Room = z.object({
  id,
  name: z.string(),
  description: z.string(),
  // value is a room id in this area, or "area_id/room_id" for another area
  exits: z.partialRecord(Direction, z.string()).default({}),
  spawns: z.array(z.object({ monster: id, count: z.number().int().min(1).default(1) })).default([]),
  items: z.array(id).default([]), // item ids lying on the floor at world start
  book: id.optional(), // id of a gamebook lying here; `read` starts it
  npcs: z.array(z.object({ id, name: z.string(), description: z.string(), talk: id, sprite: id.optional() })).default([]), // `talk <id>` opens the gamebook `talk`
  theme: z.string().optional(), // backdrop for the web client: village, road, tavern, cellar, crypt, hall, ...
  respawn: z.boolean().default(false), // where dead players wake up (first one found wins)
  shop: z.object({ sells: z.array(id).min(1) }).optional(), // items for sale at their `value`; buys anything with value at half price
});
export type Room = z.infer<typeof Room>;
export const Area = z.object({ id, name: z.string(), start: id.optional(), rooms: z.array(Room).min(1) });
export type Area = z.infer<typeof Area>;

// ---- Glossary (powers "modern mode" explanations: `? ac`) ----
export const GlossaryFile = z.object({ terms: z.record(id, z.object({ title: z.string(), text: z.string() })) });
export type GlossaryFile = z.infer<typeof GlossaryFile>;

// ---- Items ----
export const Item = z.object({
  id,
  name: z.string(),
  description: z.string(),
  kind: z.enum(["weapon", "armor", "food", "scroll", "misc"]).default("misc"),
  value: z.number().int().min(0).default(0),
  weight: z.number().min(0).default(1), // counts against carry capacity
  bound: z.boolean().default(false), // cannot be dropped or sold; stays with you through death
  archOnly: z.boolean().default(false), // only arch wizards can wield/wear it
  instantKill: z.boolean().default(false), // weapons: every hit kills outright
  wild: z.number().min(0).max(1).default(0), // chance to drop from ANY monster on death (random drops)
  minLevel: z.number().int().min(1).default(1), // level needed to wield/wear
  damage: dice.optional(), // weapons: damage per hit
  slot: z.enum(["head", "body", "shield", "hands", "feet"]).optional(), // armor: where it is worn
  acBonus: z.number().int().min(0).default(0), // armor: points subtracted from the wearer's AC
  heals: dice.optional(), // consumables: HP restored by `use`
  nourishes: z.number().int().min(0).default(0), // food: points restored on the 0-100 food meter
  teaches: id.optional(), // scrolls: spell id taught (and consumed) by `learn <scroll>`
  respawns: z.boolean().default(false), // taking it leaves another on the floor (the Pantry of Respawning Cheese)
});
export type Item = z.infer<typeof Item>;
export const ItemFile = z.object({ items: z.array(Item) });

// ---- Quests ----
export const Objective = z.discriminatedUnion("type", [
  z.object({ type: z.literal("kill"), monster: id, count: z.number().int().min(1).default(1) }),
  z.object({ type: z.literal("fetch"), item: id, count: z.number().int().min(1).default(1) }), // consumed on turn-in
  z.object({ type: z.literal("visit"), room: z.string() }), // "area/room"
]);
export type Objective = z.infer<typeof Objective>;
export const Quest = z.object({
  id,
  name: z.string(),
  description: z.string(),
  completion: z.string().default("Quest complete."),
  minLevel: z.number().int().min(1).default(1),
  offeredIn: z.string(), // "area/room" where you can accept it
  turnIn: z.string().optional(), // defaults to offeredIn
  objectives: z.array(Objective).min(1),
  reward: z.object({ xp: z.number().int().min(0).default(0), gold: z.number().int().min(0).default(0), items: z.array(id).default([]) }).default({ xp: 0, gold: 0, items: [] }),
});
export type Quest = z.infer<typeof Quest>;
export const QuestFile = z.object({ quests: z.array(Quest) });

// ---- Spells ----
export const SpellEffect = z.discriminatedUnion("type", [
  z.object({ type: z.literal("damage"), dice }), // hits an enemy automatically
  z.object({ type: z.literal("heal"), dice }), // heals the caster
  z.object({ type: z.literal("conjure"), item: id, count: z.number().int().min(1).default(1) }), // creates items in the caster's pack
]);
export const Spell = z.object({
  id,
  name: z.string(),
  description: z.string(),
  minLevel: z.number().int().min(1).default(1),
  mana: z.number().int().min(0),
  taughtIn: z.string().optional(), // "area/room" with a trainer; spells can also be learned from scrolls
  classes: z.array(id).default([]), // class ids allowed to learn it; empty = anyone
  effect: SpellEffect,
});
export type Spell = z.infer<typeof Spell>;
export const SpellFile = z.object({ spells: z.array(Spell) });

// ---- Classes ----
const growth = z.object({ base: z.number().int().min(0), perLevel: z.number().min(0) });
export const ClassDef = z.object({
  id,
  name: z.string(),
  description: z.string(),
  hp: growth, // max HP = base + perLevel * level
  mana: growth,
  attackRate: z.number().min(0).max(1.5).default(1), // to-hit improves by attackRate per level (1 = fighter, 0.5 = mage)
  startItems: z.array(id).default([]),
});
export type ClassDef = z.infer<typeof ClassDef>;
export const ClassFile = z.object({ classes: z.array(ClassDef) });

// ---- Races ----
export const RaceDef = z.object({
  id,
  name: z.string(),
  description: z.string(),
  hpBonus: z.number().int().default(0), // flat max HP
  manaBonus: z.number().int().default(0), // flat max mana
  hungerRate: z.number().min(0).default(1), // food meter drain multiplier
  xpRate: z.number().min(0).default(1), // experience multiplier
  carryBonus: z.number().int().default(0), // added to carry capacity
});
export type RaceDef = z.infer<typeof RaceDef>;
export const RaceFile = z.object({ races: z.array(RaceDef) });

// ---- Gamebooks (choose-your-own-adventure) ----
export const Choice = z.object({
  text: z.string(),
  to: id, // passage id
  requires: z.object({ item: id.optional(), flag: id.optional(), minLevel: z.number().int().optional() }).optional(),
  set: id.optional(), // raise a flag (lasts for this reading)
  gives: id.optional(), // item id
  takes: id.optional(), // item id removed if carried
});
export const Passage = z.object({
  id,
  text: z.string(),
  choices: z.array(Choice).default([]),
  end: z.enum(["win", "lose", "done"]).optional(), // "done" = a quiet ending (conversations) // ending passages have no choices
  reward: z.object({ xp: z.number().int().min(0).default(0), gold: z.number().int().min(0).default(0), items: z.array(id).default([]) }).optional(), // first win only
});
export const Gamebook = z.object({ id, name: z.string(), start: id, passages: z.array(Passage).min(1) });
export type Gamebook = z.infer<typeof Gamebook>;
export const BookFile = z.object({ books: z.array(Gamebook) });

// ---- Art: sprites are text pixel maps in the 16-color EGA palette (like the Gold Box games) ----
// '.' = transparent; 0-9 A-F = EGA colors (0 black 1 blue 2 green 3 cyan 4 red 5 magenta 6 brown 7 lgray
// 8 dgray 9 lblue A lgreen B lcyan C lred D lmagenta E yellow F white).
export const Sprite = z.object({
  rows: z.array(z.string().regex(/^[.0-9A-F]+$/, "sprite rows use '.' and hex digits 0-9 A-F")).min(1),
});
export const SpriteFile = z.object({ sprites: z.record(id, Sprite) });
export type SpriteFile = z.infer<typeof SpriteFile>;
