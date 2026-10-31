import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// DATA_DIR is the root for ALL persistent state: accounts/, corpses.json, arch.json.
const ROOT = process.env.DATA_DIR ?? join(import.meta.dirname, "..", "data");
const DIR = join(ROOT, "accounts");
mkdirSync(DIR, { recursive: true });

export interface Account {
  key: string;      // sha256 of the lowercased e-mail: the lookup key. The raw address is never stored.
  masked: string;   // display form, e.g. j******e@s*****.edu
  salt: string;
  hash: string;     // scrypt(password, salt)
  name: string;
  room: string;
  created: string;
  lastLogin: string;
  mode?: "modern" | "commodore"; // absent in older saves: treated as modern
  tipsSeen?: string[];
  inventory?: string[]; // item ids; absent in older saves
  level?: number;
  xp?: number;
  hp?: number;
  mana?: number;
  booksDone?: string[]; // gamebooks whose win reward was claimed
  race?: string;
  food?: number; // 0-100
  wizard?: boolean; // approved wizard: may build in their own domain
  wizPending?: boolean; // petitioned with `makewiz`, awaiting approval
  wimpy?: number; // auto-flee at this % of max HP (0/absent = off)
  gold?: number;
  equipped?: Record<string, string>; // slot -> item id ("weapon", "head", "body", ...)
  class?: string; // class id; absent in older saves (prompted at next login)
  spells?: string[]; // known spell ids
  quests?: Record<string, number[]>; // active quests: per-objective progress counters
  done?: string[];                   // completed quest ids
}

export const keyOf = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
const file = (key: string) => join(DIR, `${key}.json`);
const pw = (password: string, salt: string) => scryptSync(password, salt, 32);

export function loadAccount(key: string): Account | null {
  return existsSync(file(key)) ? (JSON.parse(readFileSync(file(key), "utf8")) as Account) : null;
}

/** Atomic write (temp file + rename) so a crash mid-save can't leave a corrupt character. */
export function saveAccount(a: Account): void {
  const tmp = file(a.key) + ".tmp";
  writeFileSync(tmp, JSON.stringify(a, null, 2), { mode: 0o600 });
  renameSync(tmp, file(a.key));
}

export function createAccount(key: string, masked: string, password: string, name: string, room: string): Account {
  const salt = randomBytes(16).toString("hex");
  const now = new Date().toISOString();
  const a: Account = { key, masked, salt, hash: pw(password, salt).toString("hex"), name, room, created: now, lastLogin: now, gold: 25 };
  writeFileSync(file(key), JSON.stringify(a, null, 2), { flag: "wx", mode: 0o600 }); // exclusive: throws if the account already exists
  return a;
}

export function verify(a: Account, password: string): boolean {
  const got = pw(password, a.salt);
  const want = Buffer.from(a.hash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export function nameTaken(name: string): boolean {
  return readdirSync(DIR).some((f) => {
    if (!f.endsWith(".json")) return false;
    try { return (JSON.parse(readFileSync(join(DIR, f), "utf8")) as Account).name.toLowerCase() === name.toLowerCase(); }
    catch { return false; }
  });
}

// ---- Corpses: persisted so a restart never eats someone's gear ----
export interface Corpse {
  ownerKey: string;
  ownerName: string;
  room: string;
  items: string[];
  gold: number;
  rotsAt: number; // epoch ms; after this it is a free-for-all pile of loot
  announced?: boolean;
}
const CORPSES = join(ROOT, "corpses.json");
export function loadCorpses(): Corpse[] {
  try { return JSON.parse(readFileSync(CORPSES, "utf8")) as Corpse[]; } catch { return []; }
}
export function saveCorpses(list: Corpse[]): void {
  const tmp = CORPSES + ".tmp";
  writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  renameSync(tmp, CORPSES);
}

// ---- Arch wizards: identified by account key (hashed e-mail), never by character name ----
const ARCH = join(ROOT, "arch.json");
const archKeys = (): string[] => { try { return JSON.parse(readFileSync(ARCH, "utf8")) as string[]; } catch { return []; } };
export const isArchKey = (key: string) => archKeys().includes(key);
export function addArchKey(key: string): void {
  const k = archKeys(); if (!k.includes(key)) k.push(key);
  writeFileSync(ARCH, JSON.stringify(k, null, 2), { mode: 0o600 });
}

/** Find any saved character by name (used to approve wizards who are offline). */
export function findByName(name: string): Account | null {
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".json")) continue;
    try { const a = JSON.parse(readFileSync(join(DIR, f), "utf8")) as Account; if (a.name?.toLowerCase() === name.toLowerCase()) return a; } catch { /* skip */ }
  }
  return null;
}
