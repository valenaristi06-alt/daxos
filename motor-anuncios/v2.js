// V2 · "Test de 1 minuto" — 15 s
const k1=txt('⏱️',170,170), k2=txt('Un test de<br><span class="rose" style="font-size:190px">1 minuto</span>',380,120), k3=txt('arma tu rutina de<br>calistenia asiática',820,78);
const F=fig(1060);
function quiz(q,opts,check){const c=mk(`<div class="card" style="top:330px"><h3>${q}</h3>${opts.map((o,i)=>`<div class="opt" data-i="${i}">${o}<span class="ck">✓</span></div>`).join('')}</div>`);return c}
const Q=[
 [quiz('¿Cuánto tiempo tienes al día?',['10 minutos','15 minutos','20 minutos']),[1],2.2],
 [quiz('¿Qué zonas quieres trabajar primero?',['🎯 Abdomen y cintura','🍑 Glúteos','🦵 Piernas','🧍‍♀️ Espalda y postura']),[0,2],4.3],
 [quiz('¿Sientes dolor en alguna zona?',['Espalda / lumbar','Rodillas','Cuello y hombros','Ninguna']),[1],6.4],
];
const step=txt('',200,40,'plum'); step.style.fontWeight=700;
const tap=mk('<div id="tap"></div>');
const ring=mk(`<svg id="ring" viewBox="0 0 100 100" style="top:560px"><circle cx="50" cy="50" r="42" fill="none" stroke="#f3d9dc" stroke-width="8"/><circle id="rc" cx="50" cy="50" r="42" fill="none" stroke="#c2456a" stroke-width="8" stroke-linecap="round" transform="rotate(-90 50 50)" stroke-dasharray="264" stroke-dashoffset="264"/><text id="rt" x="50" y="58" text-anchor="middle" font-size="22" font-weight="800" fill="#4a2a4f" font-family="Poppins">0%</text></svg>`);
const lt=txt('Creando tu plan<br>personalizado…',300,84);
const ok=txt('✓ Tu plan de 21 días está listo',180,62,'rose');
const P=phone(330);
const gift=txt('🎁 Y al final, un regalo<br>de bienvenida',300,80), c1=txt('Haz el test<br>de 1 minuto',560,130,'plum');
const C=cta(900,'Empezar el test →'), D=disc(), arrow=txt('👇',1090,120);
window.render=async t=>{
  $('#bar').style.width=(t/DUR*100)+'%';
  pop(k1,t,-.4,2.1); pop(k2,t,-.3,2.1,{dy:60}); pop(k3,t,-.2,2.1);
  F.style.opacity=t<2.2?1:0; if(t<2.2) drawFig(F,'tai-chi-brazos',t+.6,2);
  // preguntas
  let qi=-1;
  Q.forEach(([c,sel,t0],i)=>{const t1=t0+2.1;
    if(t>=t0&&t<t1){qi=i;c.style.opacity=cl((t-t0)/.2);c.style.transform=`translateX(${(1-eo((t-t0)/.35))*300}px)`;
      const opts=[...c.querySelectorAll('.opt')]; opts.forEach(o=>o.classList.remove('on'));
      sel.forEach((s,j)=>{const ts=t0+.75+j*.45; if(t>=ts){opts[s].classList.add('on'); if(t<ts+.45){const r=opts[s].getBoundingClientRect();tap.style.left=(r.left+r.width-150)+'px';tap.style.top=(r.top+r.height/2-60)+'px';tap.style.opacity=1-cl((t-ts)/.45);tap.style.transform=`scale(${.5+1.6*cl((t-ts)/.45)})`;}}});
    }else{c.style.opacity=0}
  });
  if(!Q.some(([c,s,t0])=>t>=t0+.75&&t<t0+2.1))tap.style.opacity=0;
  if(qi>=0){step.innerHTML=`Pregunta ${qi+1} de 3 · personalizando…`;step.style.opacity=1;step.style.transform='none'}else step.style.opacity=0;
  // carga
  const L0=8.5,L1=10.1; if(t>=L0&&t<L1){ring.style.opacity=1;const p=eo((t-L0)/1.4);$('#rc').setAttribute('stroke-dashoffset',264*(1-p));$('#rt').textContent=Math.round(p*100)+'%'}else ring.style.opacity=0;
  pop(lt,t,L0,L1-.1);
  // plan listo
  if(t>=10.1&&t<12.4){P.style.opacity=cl((t-10.1)/.25)*(t>12.1?1-cl((t-12.1)/.3):1);P.style.transform=`translateY(${(1-eo((t-10.1)/.4))*400}px)`;await setFrame(P.querySelector('img'),4.8+(t-10.1)*1.6)}else P.style.opacity=0;
  pop(ok,t,10.2,12.3);
  // CTA
  pop(gift,t,12.4,99); pop(c1,t,12.6,99,{dy:60}); pop(C,t,12.9,99);
  C.style.transform+=` scale(${t>13.2?1+.04*Math.sin((t-13.2)*7):1})`;
  pop(arrow,t,13.2,99); if(t>13.2)arrow.style.transform=`translateY(${Math.abs(Math.sin((t-13.2)*5))*-30}px)`;
  D.style.opacity=t>12.4?1:0;
};
