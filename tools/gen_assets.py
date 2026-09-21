#!/usr/bin/env python3
"""生成测试资源：不同体积的 SVG 图片 / CSS / JSON，用于弱网模拟。"""
import json
import random
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "assets"
ASSETS.mkdir(exist_ok=True)
random.seed(42)

PALETTE = ["#4f8ef7", "#f7784f", "#4fc08d", "#b06ef2", "#f2c94c", "#eb5a8d"]


def make_svg(name: str, target_kb: int, hue_seed: int) -> None:
    """用随机矩形填充出接近目标体积的 SVG（不可压缩内容，体积≈文件大小）。"""
    rng = random.Random(hue_seed)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">',
        f'<rect width="640" height="360" fill="{PALETTE[hue_seed % len(PALETTE)]}" opacity="0.25"/>',
    ]
    target = target_kb * 1024
    size = sum(len(p) for p in parts)
    i = 0
    while size < target - 200:
        x, y = rng.randint(0, 600), rng.randint(0, 320)
        w, h = rng.randint(8, 80), rng.randint(8, 60)
        c = PALETTE[rng.randint(0, len(PALETTE) - 1)]
        o = round(rng.uniform(0.2, 0.9), 3)
        r = rng.randint(0, 30)
        rect = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{c}" opacity="{o}"/><!--{i:05d}-->'
        parts.append(rect)
        size += len(rect)
        i += 1
    parts.append(f'<text x="20" y="40" font-size="28" fill="#333">{name} ({target_kb}KB)</text>')
    parts.append("</svg>")
    (ASSETS / name).write_text("".join(parts), encoding="utf-8")
    print(f"  {name}: {(ASSETS / name).stat().st_size / 1024:.1f} KB")


def main() -> None:
    print("生成测试资源 →", ASSETS)
    make_svg("img-hero.svg", 400, 0)
    make_svg("img-1.svg", 120, 1)
    make_svg("img-2.svg", 60, 2)
    make_svg("img-3.svg", 30, 3)
    make_svg("img-4.svg", 200, 4)
    make_svg("img-5.svg", 90, 5)

    # 站点样式 ~8KB
    css_rules = [
        "body{font-family:system-ui,sans-serif;margin:0;background:#f5f6fa;color:#2c3e50}",
        ".site-header{background:linear-gradient(135deg,#4f8ef7,#b06ef2);color:#fff;padding:24px 32px}",
        ".site-header h1{margin:0 0 4px;font-size:24px}",
        ".tagline{margin:0;opacity:.85}",
        "main{padding:20px 32px;max-width:960px;margin:0 auto}",
        ".gallery{display:flex;flex-wrap:wrap;gap:2%;margin-bottom:24px}",
        ".photo{border-radius:8px;object-fit:cover;background:#dde3ee;display:block}",
        ".placeholder{display:flex;align-items:center;justify-content:center;color:#98a2b8;border:2px dashed #c3cad9;box-sizing:border-box}",
        ".api-data{background:#fff;border-radius:8px;padding:16px 20px;box-shadow:0 1px 4px rgba(0,0,0,.08)}",
        ".api-data h2{margin:0 0 8px;font-size:16px}",
        ".api-data pre{margin:0;color:#4fc08d;font-size:13px;white-space:pre-wrap}",
        "#offline-banner{background:#fff3cd;border:1px solid #ffe08a;color:#8a6d1a;padding:10px 16px;text-align:center;font-size:14px}",
        "footer{padding:12px 32px;color:#98a2b8;font-size:12px;text-align:center}",
    ]
    # 填充到 ~8KB：生成一批无害的实用类
    for i in range(180):
        css_rules.append(f".u-pad-{i}{{padding:{i % 48}px}}.u-mar-{i}{{margin:{i % 48}px}}")
    (ASSETS / "site.css").write_text("\n".join(css_rules), encoding="utf-8")
    print(f"  site.css: {(ASSETS / 'site.css').stat().st_size / 1024:.1f} KB")

    # 接口数据 ~64KB
    items = [
        {
            "id": i,
            "title": f"动态资讯第 {i} 期",
            "author": f"作者{i % 17}",
            "views": random.randint(100, 99999),
            "summary": "这是一段用于填充接口体积的摘要文本。" * 3,
            "tags": [f"tag{j}" for j in range(i % 5 + 1)],
        }
        for i in range(150)
    ]
    (ASSETS / "data.json").write_text(
        json.dumps({"items": items, "total": len(items)}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"  data.json: {(ASSETS / 'data.json').stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
