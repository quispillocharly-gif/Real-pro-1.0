(()=>{
let socket=null,ready=false,currency='USD',accountId=null,busy=false,proposalReq=1000,buyReq=2000;
const $=x=>document.getElementById(x);
const set=(s)=>{if($('authStatus'))$('authStatus').textContent=s};
const errMsg=(j,fallback)=>j?.errors?.[0]?.message||j?.error?.message||fallback;

function updateBalance(val){
 if($('balance') && val !== undefined && val !== null){
  $('balance').textContent = '$' + Number(val).toFixed(2);
 }
}

async function api(path,opts={}){
 const pat=$('pat').value.trim(),app=$('app').value.trim();
 const r=await fetch('https://api.derivws.com'+path,{...opts,headers:{'Authorization':'Bearer '+pat,'Deriv-App-ID':app,'Content-Type':'application/json',...(opts.headers||{})}});
 let j={};try{j=await r.json()}catch(_){}
 if(!r.ok)throw new Error(errMsg(j,'HTTP '+r.status));return j;
}

async function fetchBalance(){
 try{
  if(!accountId)return;
  const a=await api('/trading/v1/options/accounts');
  const rows=Array.isArray(a.data)?a.data:(a.data?[a.data]:[]);
  const acc=rows.find(x=>String(x.account_id)===String(accountId));
  if(acc && acc.balance !== undefined) updateBalance(acc.balance);
 }catch(_){}
}

async function connectAccount(){
 if(busy)return;busy=true;ready=false;window.demoReady=false;set('CONECTANDO…');
 try{
  const pat=$('pat').value.trim(),app=$('app').value.trim();
  if(!pat||!app)throw new Error('Falta App ID o PAT');

  // Detectar el modo seleccionado en la interfaz (REAL o DEMO)
  const selectedMode = ($('mode')?.value || 'DEMO').toUpperCase();
  const isReal = selectedMode === 'REAL';

  const a=await api('/trading/v1/options/accounts',{method:'GET'});
  const rows=Array.isArray(a.data)?a.data:(a.data?[a.data]:[]);
  
  // Filtrar según el modo elegido
  const targetAcc = rows.find(x => {
   const type = String(x.account_type || '').toLowerCase();
   const status = String(x.status || 'active').toLowerCase();
   if(status !== 'active') return false;
   return isReal ? (type === 'real' || type !== 'demo') : (type === 'demo');
  });

  if(!targetAcc) throw new Error(`No encontré una cuenta Options ${isReal ? 'REAL' : 'DEMO'} activa`);

  accountId = targetAcc.account_id;
  currency = targetAcc.currency || 'USD';

  // Reflejar el saldo inicial inmediatamente
  if(targetAcc.balance !== undefined) updateBalance(targetAcc.balance);

  const o=await api('/trading/v1/options/accounts/'+encodeURIComponent(accountId)+'/otp',{method:'POST'});
  const url=o?.data?.url;
  if(!url)throw new Error('Deriv no devolvió URL OTP');

  if(socket)try{socket.close()}catch(_){}
  
  const modeTag = isReal ? 'REAL' : 'DEMO';
  socket = new WebSocket(url);

  socket.onopen=()=>{
   ready=true;
   window.demoReady=true;
   set(`${modeTag} CONECTADO · ${accountId}`);
   busy=false;
   try{ socket.send(JSON.stringify({balance:1,subscribe:1})); }catch(_){}
  };

  socket.onerror=()=>{ready=false;window.demoReady=false;set('ERROR WEBSOCKET');busy=false};
  socket.onclose=()=>{
   ready=false;
   window.demoReady=false;
   if($('authStatus').textContent.includes('CONECTADO')) set(`${modeTag} DESCONECTADO`);
  };
  
  socket.onmessage=onMessage;
 }catch(e){
  busy=false;ready=false;window.demoReady=false;set('ERROR · '+e.message);
 }
}

let pendingProposal=null,activeContract=null,settled=new Set();

function onMessage(ev){
 let m;try{m=JSON.parse(ev.data)}catch(_){return}

 // Actualización automática de saldo por WebSocket
 if(m.msg_type === 'balance' && m.balance){
  updateBalance(m.balance.balance);
 }

 if(m.error){
  if(pendingProposal){
   let rej=pendingProposal.reject;pendingProposal=null;rej(new Error(m.error.message||'Error Deriv'));
  }else{
   window.demoTradeError?.(new Error(m.error.message||'Error Deriv'));
  }
  return;
 }

 if(m.msg_type==='proposal'&&pendingProposal){
  const p=pendingProposal;pendingProposal=null;
  const id=m.proposal?.id,ask=Number(m.proposal?.ask_price);
  if(!id||!Number.isFinite(ask)){p.reject(new Error('Propuesta inválida'));return}
  socket.send(JSON.stringify({buy:id,price:ask,req_id:++buyReq}));p.resolve();
 }

 if(m.msg_type==='buy'&&m.buy?.contract_id){
  activeContract=m.buy.contract_id;
  const tag = (accountId && !accountId.toLowerCase().startsWith('vrt')) ? 'REAL' : 'DEMO';
  set(`${tag} CONECTADO · ${accountId} · CONTRATO ${activeContract}`);
  socket.send(JSON.stringify({proposal_open_contract:1,contract_id:activeContract,subscribe:1,req_id:3001}));
 }

 if(m.msg_type==='proposal_open_contract'&&m.proposal_open_contract){
  const c=m.proposal_open_contract,id=c.contract_id;
  if(c.is_sold&&!settled.has(id)){
   settled.add(id);activeContract=null;
   const profit=Number(c.profit);
   window.demoSettlement?.(profit);
   const tag = (accountId && !accountId.toLowerCase().startsWith('vrt')) ? 'REAL' : 'DEMO';
   set(`${tag} CONECTADO · ${accountId}`);
   if(m.subscription?.id)socket.send(JSON.stringify({forget:m.subscription.id}));
   // Actualizar el saldo tras finalizar la operación
   fetchBalance();
  }
 }
}

window.sendDemoTrade=(digit,stake)=>new Promise((resolve,reject)=>{
 if(!ready||!socket||socket.readyState!==WebSocket.OPEN){reject(new Error('Conexión con Deriv no establecida'));return}
 if(activeContract||pendingProposal){reject(new Error('Ya existe una operación en curso'));return}
 digit=Number(digit);stake=Number(stake);
 if(!Number.isInteger(digit)||digit<0||digit>9||!Number.isFinite(stake)||stake<=0){reject(new Error('Parámetros inválidos'));return}
 pendingProposal={resolve,reject};
 socket.send(JSON.stringify({proposal:1,amount:Number(stake.toFixed(2)),basis:'stake',contract_type:'DIGITDIFF',currency,barrier:String(digit),duration:1,duration_unit:'t',underlying_symbol:'R_75',req_id:++proposalReq}));
});

$('auth').onclick=connectAccount;
window.demoReady=false;
})();