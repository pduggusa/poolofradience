// Usage: npm run arch -- you@school.edu     (run on the server; uses DATA_DIR like the server does)
import { addArchKey, keyOf, loadAccount } from "../engine/accounts.js";
const email = process.argv[2];
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error("usage: npm run arch -- user@school.edu"); process.exit(1); }
if (!loadAccount(keyOf(email))) {
  console.error("No account exists for that e-mail yet. Log in once and create your character FIRST, then run this.\n(Registering an address before its account exists would let anyone who registers it first inherit arch powers.)");
  process.exit(1);
}
addArchKey(keyOf(email));
console.log("Arch wizard registered for that e-mail. They receive the Blade of Indisputable Authority the next time they log in.");
