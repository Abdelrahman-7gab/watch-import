// Loaded before every test file (`pnpm test`), so tests run without a SECRET_KEY in the environment.
// src/env.ts reads it at import time; no test uses its value. CI and a set variable still win.
process.env.SECRET_KEY ??= 'test-secret-key-that-is-at-least-32-characters';
