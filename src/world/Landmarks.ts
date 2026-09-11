/**
 * Fixed places in the world. Everything that needs to know where the pond, the
 * tree or a secret garden is reads it from here, so the terrain, the tulip
 * placement, the camera director and the discovery system can never disagree.
 */

export interface Landmark {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  /** Hint for the tulip placer: which palette this pocket favours. */
  readonly palette?: 'white' | 'moonlit' | 'golden' | 'ancient' | 'jewel';
  /** Only discoverable during these conditions. */
  readonly requires?: 'night' | 'sunrise' | 'afterRain';
  readonly secret: boolean;
}

export const POND = { x: -58, z: 44, radius: 17, rim: 7, depth: 2.4 } as const;
export const TREE = { x: 88, z: -66, radius: 13 } as const;

export const LANDMARKS: readonly Landmark[] = [
  {
    id: 'white',
    label: 'The White Tulip Garden',
    x: -99, z: -82, radius: 26, palette: 'white', secret: true,
  },
  {
    id: 'moonlit',
    label: 'The Moonlit Tulip Garden',
    x: 74, z: 96, radius: 24, palette: 'moonlit', requires: 'night', secret: true,
  },
  {
    id: 'golden',
    label: 'The Golden Tulip Garden',
    x: -34, z: -114, radius: 22, palette: 'golden', requires: 'sunrise', secret: true,
  },
  {
    id: 'forgotten',
    label: 'The Forgotten Tulip Garden',
    x: 124, z: 34, radius: 30, palette: 'ancient', secret: true,
  },
  {
    id: 'pond',
    label: 'The Mirror Pond',
    x: POND.x, z: POND.z, radius: POND.radius + POND.rim, secret: true,
  },
  {
    id: 'little',
    label: 'The Little Tulip Garden',
    x: 26, z: 40, radius: 9, palette: 'jewel', secret: true,
  },
  {
    id: 'tree',
    label: 'The Tree That Was Always There',
    x: TREE.x, z: TREE.z, radius: TREE.radius, palette: 'ancient', secret: true,
  },
];

export const SECRET_COUNT = LANDMARKS.filter((l) => l.secret).length;

export function landmarkById(id: string): Landmark | undefined {
  return LANDMARKS.find((l) => l.id === id);
}
