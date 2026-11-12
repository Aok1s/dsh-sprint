# -*- coding: utf-8 -*-
"""page_ocr.py — 把扫描件页面变成可检索的文字。

三种用法：
  page_ocr.py <pdf> <cacheDir> --page N          读一页（有缓存用缓存，没有就现场 OCR）
  page_ocr.py <pdf> <cacheDir> --page N --formulas  同上，再把公式行交 texify 出 LaTeX
  page_ocr.py <pdf> <cacheDir> --all             全书跑一遍，每页一个 pNNN.txt，最后打印索引

统一输出：最后一行是 JSON，其余是进度（stderr）。
"""
import argparse
import json
import os
import sys
import time

# 管道里 python 默认用 cp936 输出，中文字符串到 node 侧会变乱码。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

from pdfread import is_formula, read_page


def page_file(cache_dir, page):
    return os.path.join(cache_dir, f"p{page:03d}.txt")


def read_cached(cache_dir, page):
    path = page_file(cache_dir, page)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return [l for l in f.read().split("\n")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("cache")
    ap.add_argument("--page", type=int)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--dpi", type=int, default=220)
    ap.add_argument("--formulas", action="store_true")
    ap.add_argument("--from", dest="start", type=int)
    ap.add_argument("--to", dest="end", type=int)
    a = ap.parse_args()

    if a.all:
        os.makedirs(a.cache, exist_ok=True)
        from rapidocr_onnxruntime import RapidOCR
        ocr = RapidOCR()
        import pymupdf
        doc = pymupdf.open(a.pdf)
        total = len(doc)
        first = max(1, a.start or 1)
        last = min(total, a.end or total)
        t0 = time.time()
        index = {}
        for n in range(first, last + 1):
            text = read_cached(a.cache, n)
            if text is None:
                got = read_page(a.pdf, n, dpi=a.dpi, ocr=ocr)
                text = [l["text"] for l in got["lines"]]
                with open(page_file(a.cache, n), "w", encoding="utf-8") as f:
                    f.write("\n".join(text))
            index[n] = len(text)
            if n % 20 == 0:
                print(f"{n}/{last}  {time.time() - t0:.1f}s", file=sys.stderr, flush=True)
        with open(os.path.join(a.cache, "index.json"), "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False)
        print(json.dumps({"ok": True, "pages": len(index), "dir": a.cache, "seconds": round(time.time() - t0, 1), "empty": [k for k, v in index.items() if not v]}))
        return

    if not a.page:
        print(json.dumps({"error": "要传 --page 或 --all"}))
        return

    cache = a.cache
    text = read_cached(cache, a.page) if not a.formulas else None
    if text is not None:
        print(json.dumps({"ok": True, "page": a.page, "source": "cache", "lines": text, "count": len(text)}, ensure_ascii=False))
        return

    model = proc = None
    if a.formulas:
        # 国内直连 huggingface 会卡在连接超时上；模型一旦缓存过就干脆离线跑。
        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
        if os.environ.get("HF_HUB_OFFLINE") is None:
            cache = os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
            if os.path.isdir(cache):
                os.environ["HF_HUB_OFFLINE"] = "1"
        import transformers
        transformers.PretrainedConfig.to_diff_dict = lambda self, *x, **k: {}
        from texify.model.model import load_model
        from texify.model.processor import load_processor
        model, proc = load_model(), load_processor()

    got = read_page(a.pdf, a.page, dpi=300, model=model, proc=proc)
    lines = []
    for l in got["lines"]:
        item = {"text": l["text"]}
        if l.get("latex"):
            item["latex"] = l["latex"]
        lines.append(item)
    os.makedirs(cache, exist_ok=True)
    with open(page_file(cache, a.page), "w", encoding="utf-8") as f:
        f.write("\n".join(x["text"] for x in lines))
    print(json.dumps({"ok": True, "page": a.page, "source": "ocr", "lines": lines, "count": len(lines)}, ensure_ascii=False))


if __name__ == "__main__":
    main()