import type { NodeServices } from '../../../src/node';

// What the mocked loadNodeServices() returns (see ../setup.ts). Set by the world before a plugin loads.
export const services: { current: NodeServices | null } = { current: null };
