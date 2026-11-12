# 抽取 PDF 全文：按页保留边界，可选按章切分。
# 用法：python extract_pdf.py <pdf> <outdir> [--offset N] [--ranges JSON] [--max-chars N]
# 输出：book_all.txt（带 ===== PDFPAGE n ===== 标记）、pages.jsonl、ch*.txt，最后一行打印 JSON 摘要。
import json, os, sys, warnings
warnings.filterwarnings('ignore')

def main():
    argv = sys.argv[1:]
    if len(argv) < 2:
        print(json.dumps({'error': '用法：extract_pdf.py <pdf> <outdir> [--offset N] [--ranges JSON]'})); return 1
    pdf, outdir = argv[0], argv[1]
    offset = 0; ranges = None; max_chars = 0
    i = 2
    while i < len(argv):
        if argv[i] == '--offset': offset = int(argv[i + 1]); i += 2
        elif argv[i] == '--ranges': ranges = json.loads(argv[i + 1]); i += 2
        elif argv[i] == '--max-chars': max_chars = int(argv[i + 1]); i += 2
        else: i += 1
    if not os.path.exists(pdf):
        print(json.dumps({'error': '文件不存在：' + pdf})); return 1
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz
    os.makedirs(outdir, exist_ok=True)
    doc = fitz.open(pdf)
    pages = []
    all_path = os.path.join(outdir, 'book_all.txt')
    with open(all_path, 'w', encoding='utf-8') as f:
        for idx, page in enumerate(doc, start=1):
            text = page.get_text('text') or ''
            text = text.replace('\r\n', '\n')
            pages.append({'pdfPage': idx, 'bookPage': idx - offset, 'chars': len(text)})
            f.write('===== PDFPAGE %d =====\n' % idx)
            f.write(text.rstrip() + '\n')
    with open(os.path.join(outdir, 'pages.jsonl'), 'w', encoding='utf-8') as f:
        for p in pages:
            f.write(json.dumps(p, ensure_ascii=False) + '\n')
    files = [all_path, os.path.join(outdir, 'pages.jsonl')]
    chapters = []
    if ranges:
        for ch in ranges:
            name = ch.get('name') or ('ch%d' % (len(chapters) + 1))
            a = int(ch['from']); b = int(ch['to'])
            chunks = []
            for page in doc:
                idx = page.number + 1
                if a <= idx <= b:
                    chunks.append('===== PDFPAGE %d =====\n%s' % (idx, (page.get_text('text') or '').rstrip()))
            body = '\n'.join(chunks)
            if max_chars and len(body) > max_chars:
                body = body[:max_chars] + '\n\n[... 已按 max-chars 截断 ...]\n'
            path = os.path.join(outdir, name + '.txt')
            with open(path, 'w', encoding='utf-8') as f:
                f.write(body + '\n')
            files.append(path)
            chapters.append({'name': name, 'from': a, 'to': b, 'chars': len(body)})
    total = sum(p['chars'] for p in pages)
    empty = [p['pdfPage'] for p in pages if p['chars'] < 20]
    print(json.dumps({'pages': len(pages), 'chars': total, 'emptyPages': empty[:20],
                      'offset': offset, 'files': files, 'chapters': chapters}, ensure_ascii=False))
    return 0

if __name__ == '__main__':
    sys.exit(main())
