# 抽取 PPTX：每页文字 + 内嵌图片（公式几乎都是图，必须一起导）。
# 用法：python extract_ppt.py <pptx> <outdir>
import json, os, sys, warnings
warnings.filterwarnings('ignore')

def main():
    if len(sys.argv) < 3:
        print(json.dumps({'error': '用法：extract_ppt.py <pptx> <outdir>'})); return 1
    ppt, outdir = sys.argv[1], sys.argv[2]
    if not os.path.exists(ppt):
        print(json.dumps({'error': '文件不存在：' + ppt})); return 1
    from pptx import Presentation
    os.makedirs(outdir, exist_ok=True)
    media = os.path.join(outdir, 'media'); os.makedirs(media, exist_ok=True)
    prs = Presentation(ppt)
    lines = []; images = []; chars = 0
    for si, slide in enumerate(prs.slides, start=1):
        lines.append('===== SLIDE %d =====' % si)
        for shape in slide.shapes:
            if getattr(shape, 'has_text_frame', False) and shape.has_text_frame:
                t = shape.text_frame.text.strip()
                if t:
                    lines.append(t); chars += len(t)
            try:
                if shape.shape_type == 13 or getattr(shape, 'image', None) is not None:
                    img = shape.image
                    ext = (img.ext or 'png').lower()
                    name = 's%02d_%d.%s' % (si, len(images) + 1, ext)
                    path = os.path.join(media, name)
                    with open(path, 'wb') as f:
                        f.write(img.blob)
                    images.append({'slide': si, 'file': path})
            except Exception:
                pass
        lines.append('')
    deck = os.path.join(outdir, 'slides.txt')
    with open(deck, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print(json.dumps({'slides': len(prs.slides._sldIdLst), 'chars': chars,
                      'images': len(images), 'files': [deck], 'mediaDir': media}, ensure_ascii=False))
    return 0

if __name__ == '__main__':
    sys.exit(main())
