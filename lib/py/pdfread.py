# -*- coding: utf-8 -*-
"""pdfread.py v3 — 扫描件页面读取：RapidOCR 出文字与坐标，公式行再交 texify 出 LaTeX。

为什么不用 PDF 自带文字层：扫描件的隐形 OCR 层质量差（S2→Sz、0→O、公式丢失），
RapidOCR 在 300dpi 渲染图上反而更准（"通信原理（第5版）"都能认对）。
"""
import io
import json
import re
import sys

import pymupdf

CJK = re.compile(r"[\u4e00-\u9fff]")
OP = re.compile(r"[=≈≤≥±×÷∑∫√^_]")
BAD_TAIL = re.compile(r"[，。；：、]$")


def is_formula(text):
    t = text.strip()
    if not t or len(t) > 45:
        return False
    frac = len(CJK.findall(t)) / len(t)
    if BAD_TAIL.search(t):
        return False
    return bool(OP.search(t)) and frac < 0.35


def plausible(latex, ocr_text):
    """texify 对过小的裁切图会编出「* [16] A. A. K.」这类东西；用原文对一遍就能筛掉。

    做法：把 LaTeX 里的命令、括号、空白全去掉，剩下的字母数字应当基本都能在
    OCR 原文里找到——找不到的比例过高，说明模型在自由发挥。
    """
    body = re.sub(r"\\[a-zA-Z]+", "", latex)
    body = re.sub(r"[^0-9A-Za-z]", "", body).lower()
    if len(body) < 2:
        return False
    src = ocr_text.lower()
    hit = sum(1 for ch in body if ch in src)
    return hit / len(body) >= 0.7


def clean_latex(s):
    s = s.strip().strip("$").strip()
    if len(s) > 160 or CJK.search(s) or s.count("\\!") > 6:
        return None
    if re.search(r"(.{6,}?)\1{4,}", s):
        return None
    return s


def read_page(pdf_path, page_no, dpi=300, model=None, proc=None, ocr=None):
    from PIL import Image, ImageOps
    from rapidocr_onnxruntime import RapidOCR

    if ocr is None:
        ocr = RapidOCR()
    doc = pymupdf.open(pdf_path)
    page = doc[page_no - 1]
    pix = page.get_pixmap(dpi=dpi)
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    import numpy as np
    res, _ = ocr(np.array(img))
    lines = []
    for box, text, score in (res or []):
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        lines.append({
            "text": text,
            "score": round(float(score), 3),
            "bbox": [min(xs), min(ys), max(xs), max(ys)],
            "formula": is_formula(text),
        })
    # 太窄的碎片（「S2(t)=0」这种）放大后比例失真，texify 会胡说，干脆不送。
    cand = [l for l in lines if l["formula"] and (l["bbox"][2] - l["bbox"][0]) >= 90]
    if cand and model is not None:
        from texify.inference import batch_inference
        imgs = []
        for l in cand:
            x0, y0, x1, y1 = [int(v) for v in l["bbox"]]
            crop = img.crop((x0 - 12, y0 - 8, x1 + 12, y1 + 8))
            crop = ImageOps.expand(crop, border=24, fill="white")
            crop = crop.resize((crop.width * 2, crop.height * 2), Image.LANCZOS)
            imgs.append(crop)
        outs = batch_inference(imgs, model, proc)
        for l, o in zip(cand, outs):
            tex = clean_latex(o)
            if tex and plausible(tex, l["text"]):
                l["latex"] = tex
    return {"page": page_no, "dpi": dpi, "lines": lines}


if __name__ == "__main__":
    import transformers
    transformers.PretrainedConfig.to_diff_dict = lambda self, *a, **k: {}
    from texify.model.model import load_model
    from texify.model.processor import load_processor
    pdf, pg = sys.argv[1], int(sys.argv[2])
    m, p = load_model(), load_processor()
    out = read_page(pdf, pg, model=m, proc=p)
    json.dump(out, open(f"G:/workplace/study-kit/_ocr{pg}.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps({"page": pg, "lines": len(out["lines"]), "formula": sum(1 for l in out["lines"] if l["formula"])}))