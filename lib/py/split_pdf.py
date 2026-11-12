# 切分 PDF：逐页拆单页 + 按 ranges 合并成章，并写 index.json。
# 用法：python split_pdf.py <pdf> <outdir> [--mode pages|chapters|both] [--ranges JSON]
#       [--prefix p] [--password xxx] [--max-pages N] [--page-max-bytes N]
# 输出：<out>/pages/<prefix>0001.pdf、<out>/chapters/<name>.pdf、<out>/index.json，最后一行打印 JSON 摘要。
# 超过 --page-max-bytes（默认 2MB）的单页会重压图像（rewrite_images，必要时整页 JPEG 兜底），
# 否则扫描版封面这类单页仍是十几 MB，宿主那边不方便用。
import json, os, re, sys, warnings
warnings.filterwarnings('ignore')

MODES = ('pages', 'chapters', 'both')


def fail(msg):
    print(json.dumps({'error': msg}, ensure_ascii=True))
    return 1


def safe_name(name, fallback):
    # 只留中文/字母数字/_-，其它换成 _
    s = re.sub(r'[^\u4e00-\u9fffA-Za-z0-9_-]', '_', str(name or ''))
    s = s.strip('_')
    return s or fallback


def shrink_file(fitz, path, limit, tmp_path):
    # 单页文件超过 limit 时重压图像；先按几档质量试，仍超标就把整页栅格化成 JPEG。
    for dpi, quality in ((150, 80), (150, 70), (120, 60), (96, 50)):
        d = fitz.open(path)
        try:
            d.rewrite_images(dpi_target=dpi, quality=quality)
            d.save(tmp_path, garbage=4, deflate=True)
        finally:
            d.close()
        if os.path.getsize(tmp_path) <= limit:
            os.replace(tmp_path, path)
            return True
    d = fitz.open(path)
    try:
        out = fitz.open()
        try:
            for page in d:
                pix = page.get_pixmap(dpi=150, colorspace=fitz.csRGB)
                stream = pix.tobytes('jpg', jpg_quality=80)
                new = out.new_page(width=page.rect.width, height=page.rect.height)
                new.insert_image(page.rect, stream=stream, keep_proportion=True)
            out.save(tmp_path, garbage=4, deflate=True)
        finally:
            out.close()
    finally:
        d.close()
    if os.path.getsize(tmp_path) <= limit:
        os.replace(tmp_path, path)
        return True
    try:
        os.remove(tmp_path)
    except OSError:
        pass
    return False


def dir_size(path):
    total = 0
    if os.path.isdir(path):
        for entry in os.scandir(path):
            if entry.is_file():
                total += entry.stat().st_size
    return total


def main():
    argv = sys.argv[1:]
    if len(argv) < 2:
        return fail('用法：split_pdf.py <pdf> <outdir> [--mode pages|chapters|both] [--ranges JSON]')
    pdf, outdir = argv[0], argv[1]
    mode = 'both'
    ranges = None
    prefix = 'p'
    password = None
    max_pages = 0
    page_max_bytes = 2 * 1024 * 1024
    i = 2
    while i < len(argv):
        if argv[i] == '--mode':
            mode = argv[i + 1]; i += 2
        elif argv[i] == '--ranges':
            try:
                ranges = json.loads(argv[i + 1])
            except Exception as e:
                return fail('--ranges 不是合法 JSON：%s' % e)
            i += 2
        elif argv[i] == '--prefix':
            prefix = argv[i + 1]; i += 2
        elif argv[i] == '--password':
            password = argv[i + 1]; i += 2
        elif argv[i] == '--max-pages':
            try:
                max_pages = int(argv[i + 1])
            except Exception:
                return fail('--max-pages 需要整数：%s' % argv[i + 1])
            i += 2
        elif argv[i] == '--page-max-bytes':
            try:
                page_max_bytes = int(argv[i + 1])
            except Exception:
                return fail('--page-max-bytes 需要整数：%s' % argv[i + 1])
            i += 2
        else:
            i += 1
    if mode not in MODES:
        return fail('未知 --mode：%s（可选 pages|chapters|both）' % mode)
    if not os.path.isfile(pdf):
        return fail('文件不存在：' + pdf)
    if not prefix:
        return fail('--prefix 不能为空')

    try:
        import pymupdf as fitz
    except ImportError:
        import fitz

    outdir = os.path.abspath(outdir)
    try:
        os.makedirs(outdir, exist_ok=True)
    except Exception as e:
        return fail('无法创建输出目录：%s（%s）' % (outdir, e))

    try:
        doc = fitz.open(pdf)
    except Exception as e:
        return fail('无法打开 PDF：%s' % e)
    if doc.needs_pass:
        if not password or not doc.authenticate(password):
            doc.close()
            return fail('PDF 已加密，密码错误或未提供 --password')

    total = doc.page_count
    if total <= 0:
        doc.close()
        return fail('PDF 没有页面：' + pdf)

    warn_extra = []
    want_pages = mode in ('pages', 'both')
    want_chapters = mode in ('chapters', 'both')
    warn = None
    if max_pages and total > max_pages:
        warn = '总页数 %d 超过 --max-pages %d，已继续执行' % (total, max_pages)
    if want_chapters and not ranges:
        if mode == 'chapters':
            doc.close()
            return fail('chapters 模式需要 --ranges')
        warn = (warn + '；' if warn else '') + '未提供 --ranges，已跳过 chapters'
        want_chapters = False

    # 先把 ranges 全部校验完，避免写了一半才报错
    plan = []
    if want_chapters:
        if not isinstance(ranges, list) or not ranges:
            doc.close()
            return fail('--ranges 需要非空 JSON 数组')
        used = set()
        for n, ch in enumerate(ranges):
            tag = 'ranges[%d]' % n
            if not isinstance(ch, dict):
                doc.close(); return fail(tag + ' 不是对象')
            if 'from' not in ch or 'to' not in ch:
                doc.close(); return fail(tag + ' 缺少 from 或 to')
            try:
                a = int(ch['from']); b = int(ch['to'])
            except Exception:
                doc.close(); return fail('%s 的 from/to 不是整数' % tag)
            if a < 1 or b < 1:
                doc.close(); return fail('%s 页码从 1 开始：from=%d to=%d' % (tag, a, b))
            if a > total or b > total:
                doc.close(); return fail('%s 超出页码范围 1..%d：from=%d to=%d' % (tag, total, a, b))
            if a > b:
                doc.close(); return fail('%s 的 from=%d 大于 to=%d' % (tag, a, b))
            base = safe_name(ch.get('name'), 'ch%d' % (n + 1))
            name = base
            k = 2
            while name in used:
                name = '%s_%d' % (base, k); k += 1
            used.add(name)
            plan.append({'name': name, 'from': a, 'to': b})
            if name != base:
                warn = (warn + '；' if warn else '') + '章节名 %s 重名，已改为 %s' % (base, name)

    try:
        page_w = round(float(doc[0].rect.width), 2)
        page_h = round(float(doc[0].rect.height), 2)
        chars = []
        for page in doc:
            chars.append(len(page.get_text('text') or ''))

        pages_dir = os.path.join(outdir, 'pages')
        chapters_dir = os.path.join(outdir, 'chapters')
        width = max(4, len(str(total)))
        entries = []
        chapter_entries = []
        shrunk = 0

        if want_pages:
            os.makedirs(pages_dir, exist_ok=True)
            for idx in range(1, total + 1):
                rel = 'pages/%s%0*d.pdf' % (prefix, width, idx)
                path = os.path.join(outdir, rel.replace('/', os.sep))
                one = fitz.open()
                try:
                    one.insert_pdf(doc, from_page=idx - 1, to_page=idx - 1)
                    one.save(path, garbage=3, deflate=True)
                finally:
                    one.close()
                if page_max_bytes > 0 and os.path.getsize(path) > page_max_bytes:
                    if shrink_file(fitz, path, page_max_bytes,
                                   os.path.join(outdir, '.shrink.tmp.pdf')):
                        shrunk += 1
                    else:
                        warn_extra.append('第 %d 页重压后仍超过 %d 字节' % (idx, page_max_bytes))
                entries.append({'page': idx, 'file': rel, 'chars': chars[idx - 1]})

        if want_chapters:
            os.makedirs(chapters_dir, exist_ok=True)
            for ch in plan:
                rel = 'chapters/%s.pdf' % ch['name']
                path = os.path.join(outdir, rel.replace('/', os.sep))
                one = fitz.open()
                try:
                    one.insert_pdf(doc, from_page=ch['from'] - 1, to_page=ch['to'] - 1)
                    expect = ch['to'] - ch['from'] + 1
                    if one.page_count != expect:
                        return fail('章节 %s 合并后页数 %d，预期 %d' % (ch['name'], one.page_count, expect))
                    one.save(path, garbage=3, deflate=True)
                finally:
                    one.close()
                chapter_entries.append({'name': ch['name'], 'from': ch['from'], 'to': ch['to'],
                                        'file': rel, 'pages': expect})
    except Exception as e:
        doc.close()
        return fail('切分失败：%s' % e)

    index = {
        'pdf': os.path.abspath(pdf),
        'totalPages': total,
        'pageWidth': page_w,
        'pageHeight': page_h,
        'pages': entries,
        'chapters': chapter_entries,
        'bytes': {
            'source': os.path.getsize(pdf),
            'pagesDir': dir_size(pages_dir),
            'chaptersDir': dir_size(chapters_dir),
        },
    }
    index_path = os.path.join(outdir, 'index.json')
    try:
        with open(index_path, 'w', encoding='utf-8') as f:
            json.dump(index, f, ensure_ascii=False, indent=1)
    except Exception as e:
        doc.close()
        return fail('写 index.json 失败：%s' % e)
    doc.close()

    result = {
        'ok': True,
        'out': outdir,
        'totalPages': total,
        'pageFiles': len(entries),
        'chapters': [{'name': c['name'], 'from': c['from'], 'to': c['to'],
                      'file': c['file'], 'pages': c['pages']} for c in chapter_entries],
        'index': index_path,
        'bytes': index['bytes'],
    }
    if shrunk:
        result['shrunkPages'] = shrunk
    if warn_extra:
        warn = (warn + '；' if warn else '') + '；'.join(warn_extra)
    if warn:
        result['warn'] = warn
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
