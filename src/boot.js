const params=new URLSearchParams(location.search);
const spectate=params.get('spectate')==='1';

if(spectate){
  await import('./spectate-ui.js');
}else{
  await import('./main.js');
  queueMicrotask(()=>{
    const actions=document.querySelector('.top-actions');
    if(!actions||actions.querySelector('#spectateBtn'))return;
    const button=document.createElement('button');
    button.className='btn spectate-launch';
    button.id='spectateBtn';
    button.textContent='Spectate';
    button.title='Watch FULL MAX ULTRA Vanta battle Stockfish';
    button.addEventListener('click',()=>{
      const url=new URL(location.href);
      url.searchParams.set('spectate','1');
      location.href=url.href;
    });
    actions.prepend(button);
  });
}
