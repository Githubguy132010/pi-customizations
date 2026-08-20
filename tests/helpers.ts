import { vi } from "vitest";

export interface Result { code: number; stdout: string; stderr: string; killed: boolean }

export function result(stdout = "", code = 0, stderr = ""): Result {
  return { code, stdout, stderr, killed: false };
}

export function createEventBus() {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  return {
    on: vi.fn((name: string, handler: (data: unknown) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    }),
    emit: vi.fn((name: string, data: unknown) => {
      for (const handler of listeners.get(name) ?? []) handler(data);
    }),
  };
}

export function createUi(overrides: Record<string, unknown> = {}) {
  return {
    notify: vi.fn(),
    setStatus: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    input: vi.fn(),
    custom: vi.fn(),
    addAutocompleteProvider: vi.fn(),
    ...overrides,
  };
}

export function createContext(overrides: Record<string, unknown> = {}) {
  return {
    hasUI: true,
    mode: "rpc",
    cwd: "/repo",
    ui: createUi(),
    sessionManager: { getEntries: vi.fn(() => []), getCwd: vi.fn(() => "/repo") },
    modelRegistry: {},
    ...overrides,
  } as any;
}

export function createPi(overrides: Record<string, unknown> = {}) {
  return {
    exec: vi.fn(),
    events: createEventBus(),
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    appendEntry: vi.fn(),
    getActiveTools: vi.fn(() => ["bash"]),
    getAllTools: vi.fn(() => [{ name: "bash" }]),
    setActiveTools: vi.fn(),
    ...overrides,
  } as any;
}
