import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

test('World does not replace desktop-pet methods or import its private implementation', () => {
  const source = readFileSync(new URL('../src/world.mjs', import.meta.url), 'utf8');
  const screen = readFileSync(new URL('../src/desktop-screen.mjs', import.meta.url), 'utf8');
  assert.equal(existsSync(new URL('../src/pet-mirror.mjs', import.meta.url)), false);
  assert.doesNotMatch(source, /attachPetMirror|PetServer\.prototype/);
  assert.doesNotMatch(screen, /desktop-pet|src[\/\\]cua|createRequire/);
});
