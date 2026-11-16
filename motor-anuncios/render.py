import asyncio, json, os, subprocess, sys
D = os.path.dirname(os.path.abspath(__file__))
H = D
os.makedirs(f'{D}/out', exist_ok=True)
FIG = open(f'{H}/figure.js').read()
EX = {e['id']: {'A': e['A'], 'B': e['B'], 'prop': e.get('prop')} for e in json.load(open(f'{H}/exercises_poses.json'))}

def build(name):
    s = open(f'{D}/engine.html').read().replace('/*FIGURE*/', FIG).replace('/*EXERCISES*/', json.dumps(EX)).replace('/*SCRIPT*/', open(f'{D}/{name}.js').read())
    p = f'{D}/_{name}.html'; open(p, 'w').write(s); return p

async def main(name, mode, times=None):
    from playwright.async_api import async_playwright
    p = build(name)
    async with async_playwright() as pw:
        b = await pw.chromium.launch()
        pg = await b.new_page(viewport={'width': 1080, 'height': 1920})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('file://' + p); await pg.wait_for_timeout(400)
        if mode == 'stills':
            for t in times:
                await pg.evaluate(f'render({t})'); await pg.wait_for_timeout(60)
                await pg.screenshot(path=f'{D}/out/{name}_{t}.jpg', type='jpeg', quality=80)
        else:
            dur = await pg.evaluate('DUR'); n = int(dur * 30)
            tmp = f'{D}/out/{name}.tmp.mp4'
            ff = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '30', '-c:v', 'mjpeg', '-i', '-',
                                   '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp], stdin=subprocess.PIPE)
            for i in range(n):
                await pg.evaluate(f'render({i/30})')
                ff.stdin.write(await pg.screenshot(type='jpeg', quality=92))
            ff.stdin.close(); ff.wait()
            if ff.returncode == 0: os.replace(tmp, f'{D}/out/{name}.mp4')
        print(name, 'errors:', errs)
        await b.close()

if __name__ == '__main__':
    name, mode = sys.argv[1], sys.argv[2]
    times = [float(x) for x in sys.argv[3:]]
    asyncio.run(main(name, mode, times))
