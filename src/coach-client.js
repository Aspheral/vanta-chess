import { moveFacts, coachRequestForGame } from './engine/commentary.js';
import { readEvents } from './coach-stream.js';

export class CoachClient {
  constructor({fetchImpl=(...args)=>globalThis.fetch(...args),onChange=()=>{},endpoint=null,timeoutMs=18000,spectating=false}={}) {
    this.fetchImpl=fetchImpl;this.onChange=onChange;this.endpoint=endpoint;this.timeoutMs=timeoutMs;
    this.spectating=spectating;this.enabled=true;this.current=null;this.abort=null;this.generation=0;this.accessToken='';this.active=true;
  }
  cancel() {this.generation++;this.abort?.abort();this.abort=null;}
  configure(endpoint,token='') {
    const url=new URL(endpoint);
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('Use an HTTPS coach URL, or localhost for local play.');
    if(url.username||url.password)throw new Error('Use the access token field instead.');
    if(token.startsWith('sk-'))throw new Error('Use a coach access token, never your OpenAI API key.');
    this.cancel();this.endpoint=url.href;this.accessToken=token;this.retry();
  }
  async getEndpoint() {
    if(this.endpoint)return this.endpoint;
    try {
      const response=await this.fetchImpl(new URL('../coach-config.json',import.meta.url),{cache:'no-store'});
      const config=await response.json();
      if(config.endpoint){
        const url=new URL(config.endpoint);
        if(url.protocol!=='https:')throw new Error('Invalid configured endpoint');
        this.endpoint=url.href;return this.endpoint;
      }
    } catch { /* Local same-origin server is the default. */ }
    return new URL('../api/coach',import.meta.url).href;
  }
  sync(game,vantaColor,active=true) {
    const entry=game.cursor?game.timeline[game.cursor]:null;
    const changed=entry!==this.current||active!==this.active;
    this.game=game;this.vantaColor=vantaColor;this.active=active;
    if(changed){this.cancel();this.current=entry;}
    if(!active||!this.enabled||!entry){this.onChange();return;}
    if(!entry.coach) {
      const facts=moveFacts(game,vantaColor);
      entry.coach={state:facts.actor==='opponent'&&!facts.noteworthy?'quiet':'idle',text:'',san:entry.san,actor:facts.actor};
    }
    if(changed&&entry.coach.state==='loading')entry.coach={...entry.coach,state:'idle',text:''};
    if(entry.coach.state==='idle')this.start(game,entry);
    this.onChange();
  }
  toggle() {this.enabled=!this.enabled;this.cancel();if(this.enabled)this.retry();else this.onChange();}
  retry() {
    if(!this.current||!this.enabled||!this.active){this.onChange();return;}
    this.cancel();this.current.coach=null;this.sync(this.game,this.vantaColor,this.active);
  }
  async start(game,entry) {
    const generation=++this.generation;this.abort=new AbortController();
    const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(this.timeoutMs)]);
    const payload={...coachRequestForGame(game,this.vantaColor),spectating:this.spectating};
    const live=()=>generation===this.generation&&this.current===entry&&this.enabled&&this.active;
    entry.coach.state='loading';entry.coach.text='';this.onChange();
    try {
      const endpoint=await this.getEndpoint();
      if(!live())return;
      const response=await this.fetchImpl(endpoint,{method:'POST',signal,headers:{'Content-Type':'application/json',...(this.accessToken?{Authorization:`Bearer ${this.accessToken}`}:{})},body:JSON.stringify(payload)});
      if(!live()){await response.body?.cancel();return;}
      if(response.status===204){entry.coach.state='quiet';return;}
      if(!response.ok) {
        const error=await response.json().catch(()=>({}));
        throw new Error(error.message||(response.status===404?'Connect a coach server in Connection settings. GitHack serves the board, but cannot run OpenAI requests securely.':'The coach is unavailable. Please retry.'));
      }
      if(!response.headers.get('content-type')?.includes('text/event-stream'))throw new Error('Connect a coach server in Connection settings.');
      let done=false;
      for await(const event of readEvents(response.body)) {
        if(!live())break;
        if(event.type==='error')throw new Error(event.message);
        if(event.type==='delta') {
          if(typeof event.text!=='string'||entry.coach.text.length+event.text.length>2000)throw new Error('Invalid coach response.');
          entry.coach.text+=event.text;this.onChange();
        }
        if(event.type==='done'){done=true;entry.coach.state='done';break;}
      }
      if(live()&&(!done||!entry.coach.text))throw new Error('The coach lost its connection. Please retry.');
    } catch(error) {
      if(live()){entry.coach.state='error';entry.coach.text='';entry.coach.message=signal.aborted?'The coach took too long. You can keep playing or retry.':error.message;}
    } finally {if(live()){this.abort=null;this.onChange();}}
  }
  destroy(){this.cancel();}
}

// A persistent view above the board: streamed words never re-render the board.
export class CoachView {
  constructor(root,client) {
    this.root=root;this.client=client;
    root.innerHTML=`<section class="coach-card" aria-label="Vanta coach"><div class="coach-heading"><div><span class="coach-eyebrow">VANTA COACH</span><b data-move>Ready when you are</b></div><button class="btn" data-toggle aria-pressed="true">On</button></div><p class="coach-thought" data-thought></p><div class="coach-bottom"><span data-status role="status" aria-live="polite"></span><button class="btn" data-retry hidden>Retry</button></div><details class="coach-connection"><summary>Connection settings</summary><form><label>Coach server URL<input name="endpoint" type="url" placeholder="https://your-coach-server/api/coach" required></label><label>Coach access token<input name="token" type="password" autocomplete="off" placeholder="If your coach server requires one"></label><button class="btn" type="submit">Connect</button><span data-config-error role="alert"></span></form></details></section>`;
    root.querySelector('[data-toggle]').onclick=()=>client.toggle();
    root.querySelector('[data-retry]').onclick=()=>client.retry();
    root.querySelector('form').onsubmit=e=>{
      e.preventDefault();const form=e.currentTarget;
      try {client.configure(form.elements.endpoint.value,form.elements.token.value);root.querySelector('[data-config-error]').textContent='';root.querySelector('details').open=false;}
      catch(error){root.querySelector('[data-config-error]').textContent=error.message;}
    };
    client.onChange=()=>this.render();this.render();
  }
  render() {
    const c=this.client,note=c.current?.coach;
    this.root.hidden=!c.active;
    const set=(selector,text)=>{const el=this.root.querySelector(selector);if(el.textContent!==text)el.textContent=text;};
    set('[data-move]',c.current?`${note?.actor==='opponent'?(c.spectating?'Opponent played':'Your move'):'Vanta played'} · ${c.current.san}`:'Ready when you are');
    set('[data-toggle]',c.enabled?'On':'Off');this.root.querySelector('[data-toggle]').setAttribute('aria-pressed',String(c.enabled));
    let text='Play a move. I’ll explain what matters as we go.',status='OpenAI coach';
    if(!c.enabled){text='Coaching is off.';status='Paused';}
    else if(note?.state==='error'){text=note.message;status='Coach unavailable';}
    else if(note?.state==='quiet'){text=c.spectating?'I’m considering that reply.':'I’m considering your move. I’ll weigh in when there’s something useful to point out.';status='Considering the reply';}
    else if(note?.state==='loading'){text=note.text||'One moment—let’s look at that move.';status='Thinking…';}
    else if(note?.state==='done'){text=note.text;status='OpenAI coach · current move';}
    set('[data-thought]',text);set('[data-status]',status);
    this.root.querySelector('[data-retry]').hidden=!c.enabled||note?.state!=='error';
    this.root.querySelector('.coach-card').classList.toggle('is-streaming',c.enabled&&note?.state==='loading');
  }
}
