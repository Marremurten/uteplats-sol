"""Skärmdumpar för visuell verifiering: dag, kväll och natt + närbild."""
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
        page.wait_for_timeout(600)

    # Midsommardag kl 13 — full sol
    set_sliders(172, 13 * 60)
    page.screenshot(path='/tmp/uteplats_dag.png')

    # Midsommarnatt kl 23.30 — fönstren ska lysa
    set_sliders(172, 23 * 60 + 30)
    page.screenshot(path='/tmp/uteplats_natt.png')

    # Vinterkväll kl 17 — mörkt, tända fönster
    set_sliders(35, 17 * 60)
    page.screenshot(path='/tmp/uteplats_vinterkvall.png')

    browser.close()

if errors:
    print('KONSOLFEL:')
    for e in errors:
        print(' ', e)
    sys.exit(1)
print('OK — skärmdumpar i /tmp/uteplats_*.png')
