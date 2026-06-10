"""Närbilder: zooma in mot uteplatsen för att granska tak, skorstenar, träd."""
import sys
from playwright.sync_api import sync_playwright

errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1400, 'height': 900})
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))

    page.goto('http://localhost:5173')
    page.wait_for_load_state('networkidle')
    page.wait_for_function(
        "document.getElementById('status').textContent !== 'Laddar…'"
    )

    def set_sliders(doy, minutes):
        page.evaluate(
            """([doy, minutes]) => {
                const d = document.getElementById('date-slider')
                const t = document.getElementById('time-slider')
                d.value = doy
                t.value = minutes
                d.dispatchEvent(new Event('input', { bubbles: true }))
                t.dispatchEvent(new Event('input', { bubbles: true }))
            }""",
            [doy, minutes],
        )
        page.wait_for_timeout(500)

    set_sliders(172, 13 * 60)

    # Zooma in mot mitten (uteplatsen) med skrollhjulet
    page.mouse.move(700, 480)
    for _ in range(6):
        page.mouse.wheel(0, -240)
        page.wait_for_timeout(120)
    page.wait_for_timeout(500)
    page.screenshot(path='/tmp/uteplats_narbild.png')

    # Ännu närmare — fasader och fönster
    for _ in range(4):
        page.mouse.wheel(0, -240)
        page.wait_for_timeout(120)
    page.wait_for_timeout(500)
    page.screenshot(path='/tmp/uteplats_fasad.png')

    # Samma vy på natten
    set_sliders(172, 23 * 60 + 30)
    page.screenshot(path='/tmp/uteplats_fasad_natt.png')

    browser.close()

if errors:
    print('KONSOLFEL:')
    for e in errors:
        print(' ', e)
    sys.exit(1)
print('OK')
