class ChessAudio {
  constructor(){
    this.ctx=null;
    this.enabled=true;
    this.unlockBound=()=>this.unlock();
    document.addEventListener('pointerdown',this.unlockBound,{passive:true});
    document.addEventListener('touchstart',this.unlockBound,{passive:true});
    document.addEventListener('keydown',this.unlockBound,{passive:true});
  }

  async unlock(){
    if(!this.enabled)return;
    const AudioCtx=globalThis.AudioContext||globalThis.webkitAudioContext;
    if(!AudioCtx)return;
    try{
      if(!this.ctx)this.ctx=new AudioCtx();
      if(this.ctx.state==='suspended')await this.ctx.resume();
    }catch{}
  }

  setEnabled(enabled){this.enabled=Boolean(enabled);}

  playMoveResult(position){
    if(!this.enabled)return;
    this.unlock();
    if(!this.ctx||this.ctx.state!=='running')return;
    const status=position.status?.(1);
    if(status?.over&&status.reason==='checkmate')this.checkmate();
    else if(position.isInCheck?.(position.turn))this.check();
    else this.move();
  }

  move(at=this.ctx?.currentTime||0){
    if(!this.ctx)return;
    this.noise(at,.042,.055,900);
    this.tone(150,'triangle',at,.045,.032,116);
  }

  check(){
    if(!this.ctx)return;
    const t=this.ctx.currentTime;
    this.move(t);
    this.tone(660,'sine',t+.045,.11,.055,850);
    this.tone(990,'sine',t+.09,.12,.035,1040);
  }

  checkmate(){
    if(!this.ctx)return;
    const t=this.ctx.currentTime;
    this.move(t);
    this.tone(196,'triangle',t+.05,.24,.055,178);
    this.tone(247,'triangle',t+.09,.27,.045,220);
    this.tone(294,'triangle',t+.13,.30,.04,262);
    this.tone(587,'sine',t+.18,.34,.045,523);
  }

  tone(freq,type,start,duration,gain,endFreq=freq){
    const ctx=this.ctx;
    if(!ctx)return;
    const osc=ctx.createOscillator();
    const amp=ctx.createGain();
    osc.type=type;
    osc.frequency.setValueAtTime(freq,start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20,endFreq),start+duration);
    amp.gain.setValueAtTime(.0001,start);
    amp.gain.exponentialRampToValueAtTime(Math.max(.0002,gain),start+.008);
    amp.gain.exponentialRampToValueAtTime(.0001,start+duration);
    osc.connect(amp).connect(ctx.destination);
    osc.start(start);
    osc.stop(start+duration+.015);
  }

  noise(start,duration,gain,cutoff){
    const ctx=this.ctx;
    if(!ctx)return;
    const frames=Math.max(1,Math.floor(ctx.sampleRate*duration));
    const buffer=ctx.createBuffer(1,frames,ctx.sampleRate);
    const data=buffer.getChannelData(0);
    for(let i=0;i<frames;i++)data[i]=(Math.random()*2-1)*(1-i/frames);
    const source=ctx.createBufferSource();
    const filter=ctx.createBiquadFilter();
    const amp=ctx.createGain();
    filter.type='lowpass';
    filter.frequency.value=cutoff;
    amp.gain.setValueAtTime(gain,start);
    amp.gain.exponentialRampToValueAtTime(.0001,start+duration);
    source.buffer=buffer;
    source.connect(filter).connect(amp).connect(ctx.destination);
    source.start(start);
    source.stop(start+duration+.01);
  }
}

export const chessAudio=new ChessAudio();
