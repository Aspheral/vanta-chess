import test from 'node:test';
import assert from 'node:assert/strict';

class FakeWorker {
  static instances=[];
  constructor(){this.messages=[];this.terminated=false;FakeWorker.instances.push(this);}
  postMessage(message){this.messages.push(message);}
  terminate(){this.terminated=true;}
}

globalThis.Worker=FakeWorker;
const { EngineController } = await import('../src/engine/controller.js');

test('hard cancellation terminates worker and stale search result is ignored', () => {
  FakeWorker.instances.length=0;
  const controller=new EngineController('worker.js');
  let delivered=0;
  controller.addEventListener('search-result',()=>delivered++);
  const id=controller.search('some-fen');
  const oldWorker=controller.worker;
  controller.cancel();
  assert.equal(oldWorker.terminated,true);
  controller.onMessage({type:'search-result',searchId:id,result:{move:'e2e4'}});
  assert.equal(delivered,0);
});

test('ponder cache is position-specific, counts hit/miss, survives refinement, and never auto-plays a shallow reply', () => {
  FakeWorker.instances.length=0;
  const controller=new EngineController('worker.js');
  const fen='position-a';
  const id=controller.ponder(fen,3,{});
  controller.onMessage({type:'ponder-result',searchId:id,branches:[{opponentMove:'e2e4',engineMove:'e7e5'}]});
  assert.equal(controller.consumePonder('e2e4','other-position'),null);
  assert.equal(controller.getPonderStats().hits,0);

  const id2=controller.ponder(fen,3,{});
  controller.onMessage({type:'ponder-result',searchId:id2,branches:[{opponentMove:'e2e4',engineMove:'e7e5'}]});
  const refineId=controller.refinePonder(fen,3,{depth:5});
  assert.ok(refineId);
  assert.equal(controller.ponderCache.has('e2e4'),true,'completed cache remains available during refinement');
  const hit=controller.consumePonder('e2e4',fen);
  assert.equal(hit?.engineMove,null,'cached response may not be committed without normal validation');
  assert.equal(hit?.suggestedMove,'e7e5');
  assert.equal(hit?.requiresValidation,true);
  assert.equal(controller.getPonderStats().hits,1);

  const id3=controller.ponder(fen,3,{});
  controller.onMessage({type:'ponder-result',searchId:id3,branches:[{opponentMove:'d2d4',engineMove:'d7d5'}]});
  assert.equal(controller.consumePonder('g1f3',fen),null);
  assert.equal(controller.getPonderStats().misses,1);
});
