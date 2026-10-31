import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadWorld } from "../engine/world.js";
import { PackManifest, MonsterFile, Dungeon } from "../engine/schema.js";

const root = join(import.meta.dirname, "..", "packs");
let errors = 0;
const fail = (where: string, msg: string) => { errors++; console.error(`✗ ${where}: ${msg}`); };
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const targets = process.argv[2] ? [process.argv[2]] : readdirSync(root);
for (const dir of targets) {
  const base = join(root, dir);
  if (!existsSync(join(base, "pack.json"))) continue;
  const m = PackManifest.safeParse(readJson(join(base, "pack.json")));
  if (!m.success) { fail(`${dir}/pack.json`, m.error.message); continue; }
  const pack = m.data;

  const monsterIds = new Set<string>();
  for (const f of pack.monsters) {
    const r = MonsterFile.safeParse(readJson(join(base, f)));
    if (!r.success) { fail(`${dir}/${f}`, r.error.message); continue; }
    for (const mon of r.data.monsters) {
      if (monsterIds.has(mon.id)) fail(`${dir}/${f}`, `duplicate monster id "${mon.id}"`);
      monsterIds.add(mon.id);
    }
  }

  for (const f of pack.dungeons) {
    const r = Dungeon.safeParse(readJson(join(base, f)));
    if (!r.success) { fail(`${dir}/${f}`, r.error.message); continue; }
    for (const lvl of r.data.levels) {
      const w = lvl.grid[0]!.length;
      lvl.grid.forEach((row, y) => row.length !== w && fail(`${dir}/${f}`, `${lvl.id} row ${y} is ${row.length} wide, expected ${w}`));
      const known = new Set(["#", ".", "+", " ", ...Object.keys(lvl.legend)]);
      lvl.grid.forEach((row, y) => [...row].forEach((c, x) => !known.has(c) && fail(`${dir}/${f}`, `${lvl.id} (${x},${y}): "${c}" not in legend`)));
      if (!Object.values(lvl.legend).some((e) => e.type === "start") && !Object.values(lvl.legend).some((e) => e.type === "stairs"))
        fail(`${dir}/${f}`, `${lvl.id} has no start or stairs`);
      for (const e of Object.values(lvl.legend))
        if (e.type === "encounter") for (const mo of e.monsters) if (!monsterIds.has(mo.id)) fail(`${dir}/${f}`, `${lvl.id} references unknown monster "${mo.id}"`);
    }
  }
  console.log(`${errors ? "…" : "✓"} ${pack.id}@${pack.version}`);
}
if (!process.argv[2]) for (const e of loadWorld(root).errors) fail("world", e);
process.exit(errors ? 1 : 0);
