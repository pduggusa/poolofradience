// Usage: npm run arch -- you@school.edu     (run on the server; uses DATA_DIR like the server does)
import { addArchKey, keyOf } from "../engine/accounts.js";
const email = process.argv[2];
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error("usage: npm run arch -- user@school.edu"); process.exit(1); }
addArchKey(keyOf(email));
console.log("Arch wizard registered for that e-mail. They receive the Blade of Indisputable Authority on next login.");
