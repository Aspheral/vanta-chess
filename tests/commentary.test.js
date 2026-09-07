import test from 'node:test';
import assert from 'node:assert/strict';
import { ChessGame } from '../src/chess/game.js';
import { moveFacts, coachRequestForGame } from '../src/engine/commentary.js';
import { CoachClient } from '../src/coach-client.js';
import { readEvents } from '../src/coach-stream.js';
import { handleCoach, validateCoachRequest, COACH_INSTRUCTIONS } from '../server/coach.js';
import { createCoachServer } from '../server/index.js';

const game=(moves=['e2e4'],fen=null)=>{const g=new ChessGame(fen);for(const m of moves)g.playUci(m);return g;};
const payload=g=>coachRequestForGame(g,'w');
const request=p=>new Request('http://localhost/api/coach',{method:'POST',body:JSON.stringify(p)});
const sse=events=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
const complete=text=>sse([{type:'delta',text},{type:'done'}]);
const settle=()=>new Promise(r=>setTimeout(r,10));

test('facts describe the current move without speculative PVs',()=>{
  const g=game(['g1f3']);const f=moveFacts(g,'w');
  assert.deepEqual(f.centralInfluence,['d4','e5']);assert.equal(f.developsMinorPiece,true);
  assert.equal(f.actor,'Vanta');assert.equal(f.san,'Nf3');
  assert.ok(!('pv' in payload(g)));assert.doesNotMatch(JSON.stringify(f),/continuation|future/);
});
test('geometric pressure uses real squares and respects blockers',()=>{
  const f=moveFacts(game(['h3f4'],'4k3/8/4b3/8/8/7N/8/4K3 w - - 0 1'),'w');
  assert.ok(f.geometricPressure.some(t=>t.square==='e6'&&t.piece==='bishop'));
  const blocked=moveFacts(game(['d2e3'],'4k3/8/8/6q1/5p2/8/3B4/4K3 w - - 0 1'),'w');
  assert.ok(!blocked.geometricPressure.some(t=>t.square==='g5'));
});
test('terminal, special move and actor facts stay accurate',()=>{
  assert.equal(moveFacts(game(['f2f3','e7e5','g2g4','d8h4']),'b').terminal.reason,'checkmate');
  assert.equal(moveFacts(game(['e1g1'],'4k3/8/8/8/8/8/8/4K2R w K - 0 1'),'w').castle,'kingside');
  assert.equal(moveFacts(game(['e5d6'],'4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1'),'w').enPassant,true);
  assert.equal(moveFacts(game(['e7e8q'],'8/4P2k/8/8/8/8/8/K7 w - - 0 1'),'w').promotion,'queen');
  assert.equal(moveFacts(game(['e2e4']),'b').noteworthy,false);
});
test('server reconstructs chess facts rather than trusting client prose',()=>{
  const p=payload(game(['g1f3']));p.facts={check:true};p.pv=['g1f3','b8c6','h2h5'];
  const result=validateCoachRequest(p);assert.equal(result.facts.check,false);assert.ok(!('pv' in result));
  assert.throws(()=>validateCoachRequest({...p,moves:['e2e5']}));
  assert.throws(()=>validateCoachRequest({...p,moves:Array(601).fill('e2e4')}));
});
test('quiet opponent moves do not spend an API request',async()=>{
  const p={...payload(game()),vantaColor:'b'};
  const r=await handleCoach(request(p),{apiKey:'fake',fetchImpl:()=>{throw Error('should not fetch');}});
  assert.equal(r.status,204);
});
test('OpenAI request uses streaming, a short output cap and current-move facts',async()=>{
  let body;
  const response=await handleCoach(request(payload(game(['g1f3']))),{apiKey:'test-key',fetchImpl:async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');body=JSON.parse(options.body);
    return sse([{type:'response.output_text.delta',delta:'Nice—notice the center.'},{type:'response.completed'}]);
  }});
  const events=[];for await(const e of readEvents(response.body))events.push(e);
  assert.equal(body.stream,true);assert.equal(body.store,false);assert.equal(body.model,'gpt-4.1-mini');assert.ok(body.max_output_tokens<=250);
  assert.match(body.instructions,/Do not propose, predict, or promise any future move/);
  assert.ok(!('pv' in JSON.parse(body.input)));assert.deepEqual(events,[{type:'delta',text:'Nice—notice the center.'},{type:'done'}]);
});
test('credits exhaustion is reported honestly without fallback prose',async()=>{
  const response=await handleCoach(request(payload(game())),{apiKey:'test-key',fetchImpl:async()=>Response.json({error:{code:'credit_balance_exhausted',message:'sensitive provider detail'}},{status:429})});
  const error=await response.json();assert.equal(response.status,503);assert.equal(error.code,'credits_required');assert.doesNotMatch(error.message,/sensitive/);
});
test('incomplete upstream streams never report success',async()=>{
  const response=await handleCoach(request(payload(game())),{apiKey:'test-key',fetchImpl:async()=>sse([{type:'response.output_text.delta',delta:'Partial'}])});
  const events=[];for await(const e of readEvents(response.body))events.push(e);
  assert.equal(events.at(-1).type,'error');assert.ok(!events.some(e=>e.type==='done'));
});
test('SSE decoding handles split UTF-8 and CRLF',async()=>{
  const bytes=new TextEncoder().encode('data: {"type":"delta","text":"Let’s go ♟"}\r\n\r\ndata: {"type":"done"}\r\n\r\n');
  const body=new ReadableStream({start(c){for(const b of bytes)c.enqueue(new Uint8Array([b]));c.close();}});
  const events=[];for await(const e of readEvents(body))events.push(e);
  assert.equal(events[0].text,'Let’s go ♟');assert.equal(events[1].type,'done');
});
test('client streams partial text before completion and does not regenerate on renders',async()=>{
  let streamController,calls=0;
  const client=new CoachClient({endpoint:'https://coach.test/api/coach',fetchImpl:async()=>{calls++;return new Response(new ReadableStream({start(c){streamController=c;}}),{headers:{'Content-Type':'text/event-stream'}});}});
  const g=game();client.sync(g,'w');await settle();
  streamController.enqueue(new TextEncoder().encode('data: {"type":"delta","text":"Let’s look."}\n\n'));await settle();
  assert.equal(client.current.coach.text,'Let’s look.');assert.equal(client.current.coach.state,'loading');
  streamController.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));streamController.close();await settle();
  client.sync(g,'w');assert.equal(calls,1);assert.equal(client.current.coach.state,'done');client.destroy();
});
test('stale replies cannot replace thoughts after a newer move',async()=>{
  let resolveOld,calls=0,oldSignal;
  const client=new CoachClient({endpoint:'https://coach.test/api/coach',fetchImpl:async(url,options)=>{calls++;if(calls===1){oldSignal=options.signal;return new Promise(r=>resolveOld=r);}return complete('Current move.');}});
  const g=game();client.sync(g,'w');await settle();g.playUci('d7d5');g.playUci('e4d5');client.sync(g,'w');await settle();
  resolveOld(complete('Outdated move.'));await settle();
  assert.equal(oldSignal.aborted,true);assert.equal(client.current.coach.text,'Current move.');assert.equal(client.current.san,'exd5');client.destroy();
});
test('undo/redo reuses completed thoughts; reset clears them',async()=>{
  let calls=0;const client=new CoachClient({endpoint:'https://coach.test/api/coach',fetchImpl:async()=>{calls++;return complete('The current move.');}});
  const g=game();client.sync(g,'w');await settle();g.undo();client.sync(g,'w');assert.equal(client.current,null);
  g.redo();client.sync(g,'w');await settle();assert.equal(calls,1);assert.equal(client.current.coach.state,'done');
  g.reset();client.sync(g,'w');assert.equal(client.current,null);client.destroy();
});
test('turning coaching off cancels requests and analysis does not call OpenAI',async()=>{
  let signal,calls=0;const client=new CoachClient({endpoint:'https://coach.test/api/coach',fetchImpl:async(url,opts)=>{calls++;signal=opts.signal;return new Promise(()=>{});}});
  const g=game();client.sync(g,'w',false);assert.equal(calls,0);client.sync(g,'w',true);await settle();client.toggle();assert.equal(signal.aborted,true);assert.equal(client.enabled,false);client.destroy();
});
test('an OpenAI secret cannot be entered as a public coach access token',()=>{
  const client=new CoachClient();assert.throws(()=>client.configure('https://coach.test/api/coach','sk-do-not-send'));
  assert.throws(()=>client.configure('http://remote.test/api/coach'));
});
test('server serves the board but never env files, server source or git data',async()=>{
  const server=createCoachServer({apiKey:'test-key'});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base+'/')).status,200);
    for(const path of ['/.env.local','/server/coach.js','/.git/config','/src/../.env.local','/original-engine-files.json'])assert.equal((await fetch(base+path)).status,404,path);
    assert.equal((await fetch(base+'/api/coach',{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json'},body:JSON.stringify(payload(game()))})).status,403);
  } finally {await new Promise(r=>server.close(r));}
});
test('public coach token is required when configured and request limits work',async()=>{
  const server=createCoachServer({apiKey:'test-key',accessToken:'coach-test-token',requestLimit:1,fetchImpl:async()=>sse([{type:'response.output_text.delta',delta:'Hello.'},{type:'response.completed'}])});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/api/coach`;
  const opts={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload(game()))};
  try {
    assert.equal((await fetch(url,opts)).status,401);
    opts.headers.Authorization='Bearer coach-test-token';const ok=await fetch(url,opts);assert.equal(ok.status,200);await ok.text();
    assert.equal((await fetch(url,opts)).status,429);
  } finally {await new Promise(r=>server.close(r));}
});

test('default browser fetch keeps the Window receiver',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async function(){
    if(this!==globalThis)throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    return complete('Browser fetch works.');
  };
  const client=new CoachClient({endpoint:'https://coach.test/api/coach'});
  try {
    client.sync(game(),'w');await settle();
    assert.equal(client.current.coach.state,'done');
    assert.equal(client.current.coach.text,'Browser fetch works.');
  } finally {client.destroy();globalThis.fetch=original;}
});
