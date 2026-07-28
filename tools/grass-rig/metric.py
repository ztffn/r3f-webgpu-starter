import sys, numpy as np
from PIL import Image
# Foreground grass band: lower-middle of frame, away from sky/horizon.
CROP=(60, 210, 500, 340)
def score(p):
    a=np.array(Image.open(p).convert("RGB")).astype(float)
    x0,y0,x1,y1=CROP; g=a[y0:y1,x0:x1]
    dh=np.abs(np.diff(g,axis=1)).mean(); dv=np.abs(np.diff(g,axis=0)).mean()
    lum=g.mean(axis=2); sig=lum-lum.mean(axis=1,keepdims=True); v0=(sig*sig).mean()
    hac=[(sig[:,:-l]*sig[:,l:]).mean()/v0 for l in (1,4,8,12)]
    vac=[(sig[:-l,:]*sig[l:,:]).mean()/v0 for l in (1,4,8,12)]
    print(f"{p:26} h/v={dh/max(dv,1e-6):5.2f}  |dx|={dh:5.2f} |dy|={dv:5.2f}  "
          f"hAC={' '.join(f'{x:+.2f}' for x in hac)}  vAC={' '.join(f'{x:+.2f}' for x in vac)}")
for p in sys.argv[1:]: score(p)
print("TARGET (reference df2_grass_3/5):  h/v ~= 1.60, vAC decaying SLOWER than hAC")
