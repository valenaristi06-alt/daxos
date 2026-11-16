import asyncio, json, base64
import os
H=os.path.dirname(os.path.abspath(__file__))
os.makedirs('out',exist_ok=True)
FIG=open(f'{H}/figure.js').read()
EX={e['id']:{'A':e['A'],'B':e['B'],'prop':e.get('prop')} for e in json.load(open(f'{H}/exercises_poses.json'))}
mock='data:image/webp;base64,'+base64.b64encode(open(f'{H}/../img/app-mockup.webp','rb').read()).decode()
CSS='''*{box-sizing:border-box;margin:0;padding:0}body{width:1080px;height:1350px;overflow:hidden;font-family:Poppins,'Noto Color Emoji';color:#1d1520;background:radial-gradient(circle at 50% 40%,#fde2e9,#fbeef1 45%,#fffaf5 85%);position:relative}
.tag{position:absolute;top:56px;left:0;right:0;text-align:center;font-weight:800;letter-spacing:8px;font-size:28px;color:#4a2a4f}
h1{position:absolute;left:60px;right:60px;text-align:center;font-weight:900;line-height:1.04;color:#4a2a4f}.rose{color:#c2456a}
.cta{position:absolute;left:120px;right:120px;bottom:90px;height:150px;border-radius:75px;background:#c2456a;color:#fff;font-size:56px;font-weight:800;display:flex;align-items:center;justify-content:center;box-shadow:0 20px 44px rgba(194,69,106,.4)}
.disc{position:absolute;bottom:34px;left:0;right:0;text-align:center;font-size:24px;color:#6f6472}
.line{display:flex;align-items:center;gap:24px;background:#fff;border-radius:34px;padding:26px 34px;font-size:50px;font-weight:800;color:#4a2a4f;margin-bottom:24px;box-shadow:0 12px 34px rgba(74,42,79,.1)}
.line b{width:68px;height:68px;border-radius:50%;background:#c2456a;color:#fff;font-size:42px;display:flex;align-items:center;justify-content:center}
.card{background:#fff;border-radius:44px;box-shadow:0 24px 60px rgba(74,42,79,.16);padding:50px 46px}.card h3{font-size:54px;font-weight:800;line-height:1.12;margin-bottom:26px}
.opt{border:4px solid #ecdfe4;border-radius:26px;padding:26px 32px;font-size:44px;font-weight:600;margin-top:20px;display:flex;justify-content:space-between;align-items:center}
.opt.on{border-color:#c2456a;background:#fbe9ee;color:#4a2a4f}.ck{width:50px;height:50px;border-radius:14px;border:4px solid #d9c6cf;display:flex;align-items:center;justify-content:center;font-size:34px;color:#fff}.on .ck{background:#c2456a;border-color:#c2456a}'''
TAG='<div class="tag">🌸 MÉTODO HANA</div>'
FOOT='<div class="disc">Contenido educativo. No reemplaza la indicación de tu médico.</div>'
S={
's1':f'''{TAG}<h1 style="top:130px;font-size:118px">CALISTENIA ASIÁTICA<br><span class="rose" style="font-size:70px">para mujeres de 40+</span></h1>
<svg id="f" viewBox="0 28 200 166" style="position:absolute;left:40px;top:480px;width:520px;height:432px"></svg>
<div style="position:absolute;right:60px;top:500px;width:500px"><div class="line"><b>✓</b>Sin saltos</div><div class="line"><b>✓</b>Sin gimnasio</div><div class="line"><b>✓</b>Sin equipo</div><div class="line"><b>⏱</b>15 min al día</div></div>
<div class="cta">Haz el test de 1 minuto →</div>{FOOT}<script>{FIG}</script><script>const e={json.dumps(EX['sentadilla-silla'])};HanaFig.scene(document.getElementById('f'),HanaFig.mix(e.A,e.B,.95),e.prop)</script>''',
's2':f'''{TAG}<h1 style="top:120px;font-size:86px">Tu plan de calistenia<br>asiática de <span class="rose">21 días</span></h1>
<div style="position:absolute;top:330px;left:0;right:0;text-align:center;font-size:44px;font-weight:600;color:#6f6472">armado con un test de 1 minuto</div>
<img src="{mock}" style="position:absolute;top:410px;left:120px;width:840px;border-radius:40px;box-shadow:0 24px 60px rgba(74,42,79,.18)">
<div class="cta">Empezar el test →</div>{FOOT}''',
's3':f'''{TAG}<h1 style="top:120px;font-size:68px;white-space:nowrap;left:0;right:0">Calistenia que <span class="rose">se adapta</span><br>a tus rodillas</h1>
<div class="card" style="position:absolute;left:120px;right:120px;top:330px"><h3>¿Sientes dolor en alguna zona?</h3>
<div class="opt">Espalda / lumbar<span class="ck">✓</span></div><div class="opt on">Rodillas<span class="ck">✓</span></div><div class="opt">Ninguna<span class="ck">✓</span></div></div>
<div style="position:absolute;top:1040px;left:0;right:0;text-align:center;font-size:38px;font-weight:700;color:#4a2a4f">Sin impacto · Con versión fácil · 15 min</div>
<div class="cta">Haz el test de 1 minuto →</div>{FOOT}''',
}
async def main():
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={'width':1080,'height':1350})
        for k,v in S.items():
            await pg.set_content(f'<html><head><meta charset="utf-8"><style>{CSS}</style></head><body>{v}</body></html>'); await pg.wait_for_timeout(300)
            await pg.screenshot(path=f'out/{k}.jpg',type='jpeg',quality=92)
        await b.close()
asyncio.run(main())
from PIL import Image
o=Image.new('RGB',(360*3,450),'white')
for i,k in enumerate(S): o.paste(Image.open(f'out/{k}.jpg').resize((360,450)),(i*360,0))
o.save('out/statics_check.jpg')
