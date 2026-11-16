// V1 · "Sin saltos" — 15 s
const h1=txt('CALISTENIA<br>ASIÁTICA',210,150), h2=txt('para mujeres de 40+',530,84,'rose');
const F=fig(760);
const l1=mk('<div class="line" style="top:250px"><b>✓</b>Sin saltos</div>');
const l2=mk('<div class="line" style="top:430px"><b>✓</b>Sin gimnasio</div>');
const l3=mk('<div class="line" style="top:610px"><b>✓</b>Sin equipo</div>');
const m15=txt('<span style="font-size:230px">15</span><br>minutos al día',880,90,'rose');
const P=phone(600), ph1=txt('Tu plan de 21 días<br>en el celular',190,92), chips=mk('<div class="abs" style="top:420px;opacity:0"><span class="chip">🎬 Demostración animada</span><span class="chip">🌸 Versión fácil</span></div>');
const c1=txt('Haz el test<br>de 1 minuto',300,140), c2=txt('y recibe tu plan de<br>calistenia asiática de 21 días',640,64,'rose');
const C=cta(880,'Hacer el test →'), D=disc(), arrow=txt('👇',1080,120);
window.render=async t=>{
  $('#bar').style.width=(t/DUR*100)+'%';
  pop(h1,t,-.4,2.3,{dy:80}); pop(h2,t,-.4,2.3);
  // figura: escenas 1 y 2
  const fv=t<6.5; F.style.opacity=fv?1:0;
  if(fv){
    const id=t<2.4?'sentadilla-silla':t<3.6?'puente':t<4.8?'flexion-pared':'gato-vaca';
    drawFig(F,id,t+1,2.2);
    F.style.top=(t<2.4?760:820)+'px'; F.style.transform=`scale(${t<2.4?1:.82})`;
    const s=[0,2.4,3.6,4.8].filter(x=>t>=x).pop(); F.style.opacity=(s===0?1:cl((t-s)/.2))*(t>6.2?1-cl((t-6.2)/.3):1);
  }
  pop(l1,t,2.4,6.3,{dy:60}); pop(l2,t,3.6,6.3,{dy:60}); pop(l3,t,4.8,6.3,{dy:60});
  if(t>2.4&&t<6.6) F.style.top='760px';
  pop(m15,t,5.4,6.3,{dy:60}); if(t>5.4&&t<6.6){F.style.opacity=0}
  // escena 3: teléfono
  if(t>=6.5&&t<11.8){P.style.opacity=cl((t-6.5)/.3)*(t>11.5?1-cl((t-11.5)/.3):1);P.style.transform=`translateY(${(1-eo((t-6.5)/.5))*500}px)`;await setFrame(P.querySelector('img'),4.6+(t-6.5)*1.15)}else P.style.opacity=0;
  pop(ph1,t,6.6,11.6); chips.style.opacity=t>7.2&&t<11.7?cl((t-7.2)/.3):0;
  // escena 4: CTA
  pop(c1,t,11.8,99,{dy:80}); pop(c2,t,12.15,99); pop(C,t,12.5,99,{scale:true});
  C.style.transform+=` scale(${t>12.9?1+.04*Math.sin((t-12.9)*7):1})`;
  pop(arrow,t,12.9,99); if(t>12.9)arrow.style.transform=`translateY(${Math.abs(Math.sin((t-12.9)*5))*-30}px)`;
  D.style.opacity=t>11.8?1:0;
};
