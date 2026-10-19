import { vi } from 'vitest';
import { services } from './helpers/services';

// The plugin's file access, hashing and path rules come from the test world instead of Node
vi.mock('../../src/node', () => ({
	loadNodeServices: () => services.current,
}));
