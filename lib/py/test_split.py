# 自测 split_pdf.py：单页小文件、整本书 both+ranges、单页体积、非法 ranges。
# 用法：python test_split.py
# 全部通过时最后一行打印 {"ok":true,"cases":[...]}；失败打印 {"ok":false,...} 并退出码 1。
import json, os, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'split_pdf.py')
HOME_PDF = r'G:\workplace\prepare\题目\第四章作业题.pdf'
BOOK_PDF = r'G:\workplace\prepare\激光原理_0_1758851633633.pdf'
MAX_PAGE_BYTES = 2 * 1024 * 1024


def run(args, timeout=1800):
    proc = subprocess.run([sys.executable, SCRIPT] + args, capture_output=True,
                          text=True, encoding='utf-8', errors='replace', timeout=timeout)
    lines = [ln for ln in (proc.stdout or '').splitlines() if ln.strip()]
    if not lines:
        raise AssertionError('没有 stdout，stderr=%s' % (proc.stderr or '')[-800:])
    return proc.returncode, json.loads(lines[-1])


def expect_error(args):
    code, data = run(args)
    assert code == 1, '退出码应为 1，实际 %s' % code
    assert 'error' in data and data['error'], '缺少 error 字段：%s' % data
    return data['error']


def need(cond, msg):
    if not cond:
        raise AssertionError(msg)


def case_pages_small(tmp):
    out = os.path.join(tmp, 'small')
    code, data = run([HOME_PDF, out, '--mode', 'pages'])
    need(code == 0, '退出码非 0：%s' % data)
    need(data.get('ok') is True, 'ok 不是 true：%s' % data)
    need(data['totalPages'] == 1, 'totalPages 应为 1，实际 %s' % data['totalPages'])
    need(data['pageFiles'] == 1, 'pageFiles 应为 1，实际 %s' % data['pageFiles'])
    files = sorted(os.listdir(os.path.join(out, 'pages')))
    need(files == ['p0001.pdf'], '单页文件应为 p0001.pdf，实际 %s' % files)
    with open(data['index'], encoding='utf-8') as f:
        index = json.load(f)
    need(index['totalPages'] == 1 and len(index['pages']) == 1, 'index.json 内容不对：%s' % index)
    need(index['pages'][0]['page'] == 1 and index['pages'][0]['file'] == 'pages/p0001.pdf',
         'index pages 条目不对：%s' % index['pages'])
    need(index['bytes']['source'] == os.path.getsize(HOME_PDF), 'index bytes.source 不对')
    return {'name': 'single-page', 'totalPages': 1, 'pageFiles': 1, 'indexOk': True,
            'pageChars': index['pages'][0]['chars']}


def case_book(tmp):
    out = os.path.join(tmp, 'book')
    ranges = json.dumps([{'name': 'ch1', 'from': 9, 'to': 26}, {'name': 'ch2', 'from': 27, 'to': 36}],
                        ensure_ascii=False)
    code, data = run([BOOK_PDF, out, '--mode', 'both', '--ranges', ranges])
    need(code == 0, '退出码非 0：%s' % data)
    need(data.get('ok') is True, 'ok 不是 true：%s' % data)
    total = data['totalPages']
    need(total == 276, 'totalPages 应为 276，实际 %s' % total)
    need(data['pageFiles'] == 276, 'pageFiles 应为 276，实际 %s' % data['pageFiles'])
    page_dir = os.path.join(out, 'pages')
    page_files = [os.path.join(page_dir, n) for n in os.listdir(page_dir) if n.endswith('.pdf')]
    need(len(page_files) == 276, 'pages/ 下应有 276 个 PDF，实际 %d' % len(page_files))
    biggest = max(os.path.getsize(p) for p in page_files)
    need(biggest < MAX_PAGE_BYTES, '有单页文件超过 2MB：%d 字节' % biggest)
    need(os.path.getsize(HOME_PDF) > 0, '原书文件尺寸异常')

    import pymupdf
    chapters = {c['name']: c for c in data['chapters']}
    need(len(chapters) == 2, 'chapters 应有 2 个，实际 %s' % list(chapters))
    need(chapters['ch1']['pages'] == 18, 'ch1 页数应为 18，实际 %s' % chapters['ch1']['pages'])
    need(chapters['ch2']['pages'] == 10, 'ch2 页数应为 10，实际 %s' % chapters['ch2']['pages'])
    for name, want in (('ch1', 18), ('ch2', 10)):
        path = os.path.join(out, chapters[name]['file'].replace('/', os.sep))
        need(os.path.isfile(path), '章节文件不存在：%s' % path)
        with pymupdf.open(path) as d:
            need(d.page_count == want, '%s 实际页数 %d，预期 %d' % (name, d.page_count, want))
    chap_bytes = sum(os.path.getsize(os.path.join(out, c['file'].replace('/', os.sep)))
                     for c in data['chapters'])
    src_bytes = os.path.getsize(BOOK_PDF)
    need(chap_bytes * 2 < src_bytes,
         '章节总大小没有明显小于原书：%d vs %d' % (chap_bytes, src_bytes))
    need(data['bytes']['pagesDir'] > 0 and data['bytes']['chaptersDir'] > 0, 'bytes 统计不对：%s' % data['bytes'])

    with open(data['index'], encoding='utf-8') as f:
        index = json.load(f)
    need(len(index['pages']) == 276, 'index.pages 应有 276 条，实际 %d' % len(index['pages']))
    need(len(index['chapters']) == 2, 'index.chapters 应有 2 条，实际 %d' % len(index['chapters']))
    need(index['pageWidth'] > 0 and index['pageHeight'] > 0, '页面尺寸缺失：%s' % index)
    return {'name': 'book-both', 'totalPages': total, 'pageFiles': 276,
            'chapterPages': {'ch1': 18, 'ch2': 10},
            'largestPageBytes': biggest, 'chaptersBytes': chap_bytes, 'sourceBytes': src_bytes,
            'indexOk': True}


def case_bad_range(tmp):
    out = os.path.join(tmp, 'bad')
    msg = expect_error([HOME_PDF, out, '--mode', 'chapters',
                        '--ranges', json.dumps([{'name': 'x', 'from': 1, 'to': 999}])])
    return {'name': 'bad-range', 'error': msg[:120]}


def case_bad_range_reverse(tmp):
    # 用 276 页的书测：两个页码都在范围内，只有 from > to
    msg = expect_error([BOOK_PDF, out_dummy(tmp), '--mode', 'chapters',
                        '--ranges', json.dumps([{'name': 'x', 'from': 26, 'to': 9}])])
    need('大于' in msg, 'from>to 应报 from 大于 to，实际：%s' % msg)
    return {'name': 'from-gt-to', 'error': msg[:120]}


def out_dummy(tmp):
    return os.path.join(tmp, 'bad2')


def main():
    started = time.time()
    tmp = tempfile.mkdtemp(prefix='splittest-')
    cases = []
    try:
        cases.append(case_pages_small(tmp))
        cases.append(case_book(tmp))
        cases.append(case_bad_range(tmp))
        cases.append(case_bad_range_reverse(tmp))
    except Exception as e:
        print(json.dumps({'ok': False, 'cases': cases, 'error': str(e), 'tmp': tmp}, ensure_ascii=True))
        return 1
    shutil.rmtree(tmp, ignore_errors=True)
    print(json.dumps({'ok': True, 'cases': cases, 'seconds': round(time.time() - started, 1)},
                     ensure_ascii=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
