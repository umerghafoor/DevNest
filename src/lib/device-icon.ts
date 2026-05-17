import {
  Server,
  Cpu,
  Database,
  Globe,
  Cloud,
  Rocket,
  Anchor,
  Flame,
  Boxes,
  Box,
  Compass,
  Gem,
  Hexagon,
  Layers,
  LifeBuoy,
  Pyramid,
  Radar,
  Satellite,
  Ship,
  Sparkles,
  Sprout,
  Triangle,
  Trophy,
  Wand,
  Waves,
  Wind,
  Zap,
  Atom,
  Mountain,
  Diamond,
  type LucideIcon,
} from "lucide-react";

// Curated pool — chosen so each one reads at 16 px and the silhouettes
// stay distinguishable from each other.
const POOL: LucideIcon[] = [
  Server,
  Cpu,
  Database,
  Globe,
  Cloud,
  Rocket,
  Anchor,
  Flame,
  Boxes,
  Box,
  Compass,
  Gem,
  Hexagon,
  Layers,
  LifeBuoy,
  Pyramid,
  Radar,
  Satellite,
  Ship,
  Sparkles,
  Sprout,
  Triangle,
  Trophy,
  Wand,
  Waves,
  Wind,
  Zap,
  Atom,
  Mountain,
  Diamond,
];

/**
 * Deterministic icon for a device id — same id always returns the same
 * icon, so users build muscle memory for "the rocket = prod".
 *
 * Uses FNV-1a on the id bytes for a cheap, stable hash.
 */
export function iconForDeviceId(id: string): LucideIcon {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash =
      (hash +
        ((hash << 1) +
          (hash << 4) +
          (hash << 7) +
          (hash << 8) +
          (hash << 24))) >>>
      0;
  }
  return POOL[hash % POOL.length];
}
