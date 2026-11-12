# 把 PDF 每页渲染成 PNG，供人眼复核排版。
# 用法：python render_pages.py <pdf> <outdir> [--dpi 110]
import json, os, sys, warnings
warnings.filterwarnings('ignore')

def main():
    argv = sys.argv[1:]
    if len(argv) < 2:
        print(json.dumps({'error': '用法：render_pages.py <pdf> <outdir> [--dpi 110]'})); return 1
    pdf, outdir = argv[0], argv[1]
    dpi = 110
    if '--dpi' in argv:
        dpi = int(argv[argv.index('--dpi') + 1])
    if not os.path.exists(pdf):
        print(json.dumps({'error': '文件不存在：' + pdf})); return 1
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz
    os.makedirs(outdir, exist_ok=True)
    doc = fitz.open(pdf)
    files = []
    for i, page in enumerate(doc, start=1):
        path = os.path.join(outdir, 'p%02d.png' % i)
        page.get_pixmap(dpi=dpi).save(path)
        files.append(path)
    print(json.dumps({'pages': len(files), 'dpi': dpi, 'files': files}, ensure_ascii=False))
    return 0

if __name__ == '__main__':
    sys.exit(main())
