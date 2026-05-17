const ADJECTIVES = [
  "Blue",
  "Red",
  "Golden",
  "Silver",
  "Crimson",
  "Emerald",
  "Violet",
  "Amber",
  "Cobalt",
  "Ivory",
  "Onyx",
  "Coral",
  "Jade",
  "Scarlet",
  "Indigo",
  "Bronze",
  "Frosty",
  "Sunny",
  "Misty",
  "Stormy",
];

const NOUNS = [
  "Whale",
  "Fox",
  "Otter",
  "Panda",
  "Falcon",
  "Tiger",
  "Lynx",
  "Heron",
  "Raven",
  "Wolf",
  "Bison",
  "Mantis",
  "Koala",
  "Badger",
  "Hawk",
  "Manta",
  "Puffin",
  "Shark",
  "Bear",
  "Owl",
];

export function randomWorkspaceName(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a} ${n}`;
}
