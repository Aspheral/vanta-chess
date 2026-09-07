import test from 'node:test';
import assert from 'node:assert/strict';
import { isPonderBranchPracticallySafe } from '../src/engine/controller.js';

const START='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('ponder safety accepts a legal quiet cached reply', () => {
  const branch={engineMove:'e7e5'};
  assert.equal(isPonderBranchPracticallySafe(START,'e2e4',branch),true);
});

test('ponder safety rejects malformed or impossible cached replies', () => {
  assert.equal(isPonderBranchPracticallySafe(START,'e2e4',null),false);
  assert.equal(isPonderBranchPracticallySafe(START,'e2e5',{engineMove:'e7e5'}),false);
});

test('first ponder pass is intentionally quick before background refinement', async () => {
  const OriginalWorker=globalThis.Worker;
  const OriginalCustomEvent=globalThis.CustomEvent;
  const messages=[];

  class FakeWorker {
    constructor(){ this.onmessage=null; }
    postMessage(message){ messages.push(message); }
    terminate(){}
  }

  globalThis.Worker=FakeWorker;
  globalThis.CustomEvent=class { constructor(type,init={}){ this.type=type;this.detail=init.detail; } };

  try {
    const { EngineController }=await import('../src/engine/controller.js');
    const controller=new EngineController(new URL('file:///fake-worker.js'));
    controller.ponder(START,4,{depth:4,timeMs:300});
    const posted=messages.at(-1);
    assert.equal(posted.type,'ponder');
    assert.equal(posted.options.timeMs,180);
    assert.equal(posted.options.depth,4);
    controller.destroy();
  } finally {
    globalThis.Worker=OriginalWorker;
    globalThis.CustomEvent=OriginalCustomEvent;
  }
});
