import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneFloor } from '../../coo-lite/android/app/src/main/assets/pet-keyboard.mjs';

function fixture() {
  let clock = 0, queue = [], jumps = 0, landings = 0;
  const position = { mode: 'idle', pressing: false }, moves = [];
  const floor = createPhoneFloor({
    height: () => 828, baseGap: () => 48, layout: () => position,
    move: (before, after) => moves.push({ before, after }),
    jump: () => jumps++, land: () => landings++, now: () => clock,
    schedule: callback => queue.push(callback),
  });
  const step = (ms = 16) => { clock += ms; const callbacks = queue; queue = []; for (const callback of callbacks) callback(clock); };
  return { floor, position, moves, step, get jumps() { return jumps; }, get landings() { return landings; }, get pending() { return queue.length; } };
}

test('keyboard raises the floor once and closing makes a height-dependent fall and landing', () => {
  const f = fixture();
  f.floor.receive(true, 100); f.floor.receive(true, 282);
  assert.equal(f.jumps, 1);
  assert.equal(f.floor.state().floor, 546);
  f.floor.receive(false, 0);
  assert.equal(f.floor.state().falling, true);
  f.step();
  assert.ok(f.floor.state().floor > 546 && f.floor.state().floor < 780);
  for (let i = 0; i < 100 && f.pending; i++) f.step();
  assert.equal(f.floor.state().floor, 780);
  assert.equal(f.floor.state().falling, false);
  assert.equal(f.landings, 1);
  assert.ok(f.moves.some(m => m.after > 546 && m.after < 780));
});

test('touch and existing airborne motion interrupt a fall without inventing a landing', () => {
  for (const interrupted of ['pressing', 'air']) {
    const f = fixture(); f.floor.receive(true, 282); f.floor.receive(false, 0); f.step();
    if (interrupted === 'pressing') f.position.pressing = true; else f.position.mode = 'air';
    f.step();
    assert.equal(f.floor.state().falling, false);
    assert.equal(f.floor.state().floor, 780);
    assert.equal(f.landings, 0);
  }
});

test('reopening cancels an old fall and a free figure away from the floor stays free', () => {
  const f = fixture(); f.floor.receive(true, 282); f.floor.receive(false, 0); f.step();
  f.floor.receive(true, 282);
  assert.equal(f.floor.state().falling, false);
  assert.equal(f.floor.state().floor, 546);
  for (let i = 0; i < 20 && f.pending; i++) f.step();
  assert.equal(f.floor.state().floor, 546);
  assert.equal(f.landings, 0);
  f.position.y = 200;
  f.floor.receive(false, 0);
  assert.equal(f.floor.state().falling, false);
  assert.equal(f.landings, 0);
});

test('a fixed-Y figure regains the full stage when the keyboard closes during a drag', () => {
  const f = fixture();
  delete f.position.y; // The fixed-Y body reports no independent ground line.
  f.floor.receive(true, 282);
  f.position.mode = 'drag'; f.position.pressing = true;
  f.floor.receive(false, 0);
  assert.equal(f.floor.state().floor, 780);
  assert.equal(f.floor.state().falling, false);
  assert.equal(f.moves.at(-1).after, 780);
  f.position.mode = 'idle'; f.position.pressing = false;
  f.floor.receive(true, 282); f.floor.receive(false, 0);
  for (let i = 0; i < 100 && f.pending; i++) f.step();
  assert.equal(f.floor.state().floor, 780);
  assert.equal(f.landings, 1);
});
