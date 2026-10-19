from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Awaitable, Callable

CHANNELS = ("msedge", "chrome", None)


class Step:
    def __init__(self) -> None:
        self.steps: list[dict[str, Any]] = []

    async def run(self, name: str, fn: Callable[[], Awaitable[Any]]) -> Any:
        start = time.monotonic()
        try:
            detail = await fn()
            self.steps.append({"name": name, "ok": True, "detail": "" if detail is None else str(detail)[:300],
                               "ms": int((time.monotonic() - start) * 1000)})
            return detail
        except Exception as exc:  # each step reports its own failure; later steps still run where meaningful
            self.steps.append({"name": name, "ok": False, "detail": f"{type(exc).__name__}: {str(exc)[:400]}",
                               "ms": int((time.monotonic() - start) * 1000)})
            return None


async def _supply_chain(page, s: Step) -> None:
    async def inventory_rows():
        await page.wait_for_selector("#inventory-table tbody tr", timeout=8000)
        n = await page.locator("#inventory-table tbody tr").count()
        assert n > 0, "no inventory rows"
        return f"{n} inventory rows"

    async def forecast():
        await page.click('button[data-tab="forecast"]')
        await page.wait_for_selector("#forecast-chart path, #forecast-chart polyline", timeout=8000)
        rows = await page.locator("#backtest-table tbody tr").count()
        assert rows > 0, "no backtest rows"
        return f"chart rendered, {rows} backtest rows"

    async def replenishment():
        await page.click('button[data-tab="replenishment"]')
        await page.wait_for_selector("#replenishment-table tbody tr", timeout=8000)
        return f"{await page.locator('#replenishment-table tbody tr').count()} recommendations"

    async def scenario():
        await page.click('button[data-tab="scenarios"]')
        form = page.locator("#scenario-form")
        await form.locator('[name="name"]').fill("Browser check +20% demand")
        await form.locator('[name="demandMultiplier"]').fill("1.2")
        await form.locator('button[type="submit"]').click()
        await page.wait_for_selector("#scenario-summary", timeout=8000)
        return (await page.locator("#scenario-summary").inner_text())[:200]

    await s.run("inventory table populated", inventory_rows)
    await s.run("forecast chart and backtest", forecast)
    await s.run("replenishment recommendations", replenishment)
    await s.run("what-if scenario", scenario)


async def _design_editor(page, s: Step) -> None:
    async def count() -> int:
        return int(await page.get_attribute("body", "data-layer-count") or "0")

    async def draw(tool: str, x0: float, y0: float, x1: float, y1: float):
        await page.click(f'button[data-tool="{tool}"]')
        box = await page.locator("#canvas").bounding_box()
        assert box, "canvas not visible"
        before = await count()
        await page.mouse.move(box["x"] + x0, box["y"] + y0)
        await page.mouse.down()
        await page.mouse.move(box["x"] + x1, box["y"] + y1, steps=6)
        await page.mouse.up()
        after = await count()
        assert after == before + 1, f"layer count {before} -> {after}"
        return f"layers: {after}"

    async def undo_redo():
        before = await count()
        await page.click("#undo")
        mid = await count()
        await page.click("#redo")
        after = await count()
        assert mid == before - 1 and after == before, f"{before} -> {mid} -> {after}"
        return f"{before} -> {mid} -> {after}"

    async def export_svg():
        async with page.expect_download(timeout=8000) as dl:
            await page.click("#export-svg")
        download = await dl.value
        size = int(await page.get_attribute("body", "data-last-export") or "0")
        assert size > 100, "empty SVG export"
        return f"{download.suggested_filename} ({size} chars)"

    async def save():
        await page.click("#save")
        await page.wait_for_function("() => /^Saved/.test(document.querySelector('#status')?.textContent || '')", timeout=6000)
        return (await page.locator("#status").inner_text())[:200]

    await s.run("draw rectangle", lambda: draw("rect", 80, 80, 220, 180))
    await s.run("draw ellipse", lambda: draw("ellipse", 260, 100, 380, 200))
    await s.run("undo and redo", undo_redo)
    await s.run("export SVG", export_svg)
    await s.run("save design", save)


async def _generic(page, s: Step) -> None:
    async def add_item():
        await page.fill('#item-form [name="title"]', "Browser check item")
        await page.click('#item-form button[type="submit"]')
        await page.wait_for_selector("#items li", timeout=6000)
        return f"{await page.locator('#items li').count()} items"

    async def features_mounted():
        html = await page.inner_html("#features")
        if not html.strip():
            raise AssertionError("feature module rendered nothing into #features")
        return f"features section has {len(html)} chars of markup"

    await s.run("add item via UI", add_item)
    await s.run("feature module mounted", features_mounted)


CHECKS = {"supply_chain": _supply_chain, "design_editor": _design_editor, "generic": _generic}


async def run_browser_check(check: str, url: str, out_dir: Path, timeout_s: float = 60) -> dict[str, Any]:
    """Drive a running preview with Playwright. Returns status passed/failed/skipped with per-step evidence."""
    if check not in CHECKS:
        return {"status": "skipped", "reason": f"no browser check defined for {check!r}", "steps": []}
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        return {"status": "skipped", "reason": "playwright Python package is not installed", "steps": []}
    out_dir.mkdir(parents=True, exist_ok=True)
    s = Step()
    console_errors: list[str] = []
    page_errors: list[str] = []
    start = time.monotonic()
    async with async_playwright() as pw:
        browser = None
        launch_errors = []
        used = None
        for channel in CHANNELS:
            try:
                browser = await pw.chromium.launch(channel=channel, headless=True) if channel else await pw.chromium.launch(headless=True)
                used = channel or "bundled-chromium"
                break
            except Exception as exc:
                launch_errors.append(f"{channel or 'bundled'}: {str(exc).splitlines()[0][:160]}")
        if browser is None:
            return {"status": "skipped", "reason": "no Chromium-based browser could be launched", "launch_errors": launch_errors,
                    "steps": []}
        try:
            context = await browser.new_context(viewport={"width": 1366, "height": 860}, accept_downloads=True)
            page = await context.new_page()
            page.set_default_timeout(timeout_s * 1000 / 4)
            page.on("console", lambda m: console_errors.append(m.text[:300]) if m.type == "error" else None)
            page.on("pageerror", lambda e: page_errors.append(str(e)[:300]))

            async def load():
                await page.goto(url, wait_until="domcontentloaded")
                await page.wait_for_selector('body[data-ready="true"]', timeout=12000)
                return await page.title()

            loaded = await s.run("page loads and reports ready", load)
            if loaded is not None:
                await CHECKS[check](page, s)
            shot = out_dir / f"{check}.png"
            try:
                await page.screenshot(path=str(shot), full_page=False)
            except Exception:
                shot = None
        finally:
            await browser.close()
    ok = all(step["ok"] for step in s.steps) and not page_errors
    return {"status": "passed" if ok else "failed", "browser": used, "url": url, "steps": s.steps,
            "console_errors": console_errors[:20], "page_errors": page_errors[:20],
            "screenshot": str(shot) if shot else None, "duration_ms": int((time.monotonic() - start) * 1000)}
