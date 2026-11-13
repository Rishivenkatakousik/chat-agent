// Runs before `npm run dev` / `npm start`. Plain JavaScript with no imports, so it works on any
// Node version and can explain the requirement before the app fails on a missing built-in.
const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `Minimi needs Node 22.13 or later (for the built-in SQLite module); this is Node ${process.versions.node}.\n` +
      "Install a newer Node (for example `nvm install 22`) and run the command again.",
  );
  process.exit(1);
}
