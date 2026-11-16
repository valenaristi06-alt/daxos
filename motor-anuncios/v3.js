// V3 · "Sin castigar las rodillas" — 15 s
const h1=txt('Moverte<br><span class="rose">sin castigar</span><br>tus rodillas',220,128);
const F=fig(820);
const EXS=[['sentadilla-silla','Sentadilla a la silla'],['puente','Puente de glúteos'],['perro-pajaro','Perro-pájaro']];
const name=txt('',230,84), sub=txt('',380,48,'rose');
const b1=mk('<div class="badge" style="left:140px;top:1500px">Sin impacto</div>'), b2=mk('<div class="badge" style="right:140px;top:1500px;background:#c2456a">Con versión fácil</div>');
const r1=txt('¿Algo molesta?',240,96), r2=txt('Usa la versión fácil<br>o sáltalo.',430,80,'rose');
const P=phone(700);
const c1=txt('Haz el test<br>de 1 minuto',300,140), c2=txt('Tu plan de 21 días se adapta<br>si tienes molestias',640,62,'rose');
const C=cta(900,'Hacer el test →'), D=disc(), arrow=txt('👇',1090,120);
window.render=async t=>{
  $('#bar').style.width=(t/DUR*100)+'%';
  pop(h1,t,-.4,2.3,{dy:70});
  // figura
  let id=null, fs=0;
  if(t<2.4){id='sentadilla-silla'}else if(t<9){const i=Math.min(2,Math.floor((t-2.4)/2.2));id=EXS[i][0];fs=2.4+i*2.2;
    name.innerHTML=EXS[i][1]; sub.innerHTML=['Ejercicio 1 de 24','Ejercicio 2 de 24','Ejercicio 3 de 24'][i]; pop(name,t,fs,fs+2.05,{dy:40}); pop(sub,t,fs+.15,fs+2.05);}
  else{name.style.opacity=0;sub.style.opacity=0}
  if(id){drawFig(F,id,t+1,2.2);F.style.opacity=(fs===0?1:cl((t-fs)/.2))*(t>8.7?1-cl((t-8.7)/.3):1);F.style.top=(t<2.4?860:600)+'px'}else F.style.opacity=0;
  pop(b1,t,2.8,8.9,{dy:30}); pop(b2,t,3.1,8.9,{dy:30});
  // tip + teléfono
  pop(r1,t,9,12.2); pop(r2,t,9.3,12.2);
  if(t>=9.2&&t<12.4){P.style.opacity=cl((t-9.2)/.25)*(t>12.1?1-cl((t-12.1)/.3):1);P.style.transform=`translateY(${(1-eo((t-9.2)/.4))*400}px)`;await setFrame(P.querySelector('img'),7+(t-9.2)*1.2)}else P.style.opacity=0;
  // CTA
  pop(c1,t,12.4,99,{dy:70}); pop(c2,t,12.7,99); pop(C,t,13,99);
  C.style.transform+=` scale(${t>13.3?1+.04*Math.sin((t-13.3)*7):1})`;
  pop(arrow,t,13.3,99); if(t>13.3)arrow.style.transform=`translateY(${Math.abs(Math.sin((t-13.3)*5))*-30}px)`;
  D.style.opacity=t>12.4?1:0;
};
