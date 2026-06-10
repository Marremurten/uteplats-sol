"""E2E-verifiering: svep året och läs av uteplatsens solfönster per dag.

Facit från verkligheten: solen når uteplatsen ~mitten av april till
~mitten av augusti.
"""
import json
import re
import sys
from playwright.sync_api import sync_playwright

errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))

    page.goto('http://localhost:5173')
    page.wait_for_load_state('networkidle')
    page.wait_for_function(
        "document.getElementById('status').textContent !== 'Laddar…'"
    )

    # Skärmdumpar: midsommar kl 13 och 1 februari kl 13
    def set_sliders(doy, minutes):
        page.evaluate(
            """([doy, minutes]) => {
                const d = document.getElementById('date-slider')
                const t = document.getElementById('time-slider')
                d.value = doy; t.value = minutes
                d.dispatchEvent(new Event('input'))
                t.dispatchEvent(new Event('input'))
            }""",
            [doy, minutes],
        )

    set_sliders(172, 13 * 60)  # 21 juni 13:00
    page.wait_for_timeout(400)
    page.screenshot(path='/tmp/uteplats_midsommar.png')
    midsummer_status = page.text_content('#status').strip()
    midsummer_windows = page.text_content('#windows').strip()

    set_sliders(32, 13 * 60)  # 1 februari 13:00
    page.wait_for_timeout(400)
    page.screenshot(path='/tmp/uteplats_februari.png')
    feb_status = page.text_content('#status').strip()
    feb_windows = page.text_content('#windows').strip()

    # Årssvep: var 3:e dag, läs av om dagen har något solfönster
    year = []
    for doy in range(1, 366, 3):
        set_sliders(doy, 12 * 60)
        page.wait_for_timeout(30)
        w = page.text_content('#windows').strip()
        has_sun = 'Ingen sol' not in w
        m = re.findall(r'(\d\d:\d\d)–(\d\d:\d\d)', w)
        year.append({'doy': doy, 'sun': has_sun, 'windows': m})

    browser.close()

sunny = [d for d in year if d['sun']]
first = sunny[0]['doy'] if sunny else None
last = sunny[-1]['doy'] if sunny else None

print(json.dumps({
    'midsommar': {'status': midsummer_status, 'windows': midsummer_windows},
    'februari': {'status': feb_status, 'windows': feb_windows},
    'forsta_soldag_doy': first,
    'sista_soldag_doy': last,
    'antal_soldagar_av_122_samplade': len(sunny),
    'js_errors': errors[:5],
}, ensure_ascii=False, indent=1))

# Facit: fönstret öppnar ~doy 105 (15 apr) och stänger ~doy 227 (15 aug)
ok = first is not None and 85 <= first <= 125 and 210 <= last <= 250
print('FACIT-CHECK:', 'OK' if ok else 'AVVIKER', file=sys.stderr)
