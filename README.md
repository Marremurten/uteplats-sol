# ☀️ Sol på uteplatsen

Interaktiv 3D-simulering av när solen når uteplatsen på gården
(Södermalm, Stockholm). Dra i datum- och tidsreglagen och se skuggorna
vandra; panelen visar om uteplatsen har sol just då samt dagens solfönster.

## Köra

```bash
npm install
npm run dev        # öppna http://localhost:5173
```

Geodatan ligger incheckad i `public/data/`. För att uppdatera den:

```bash
npm run prepare-data
```

## Riktig terräng (valfritt men rekommenderat)

Som standard används platt mark med ett schablonmässigt gårdsdjup
(`courtyardDepth` i `site.config.json`). För riktig terräng från
Lantmäteriets markhöjdmodell (1 m-grid, öppna data CC BY 4.0):

1. Skapa gratis konto på [geotorget.lantmateriet.se](https://geotorget.lantmateriet.se)
   och beställ behörighet för **Markhöjdmodell Nedladdning**.
2. Kör pipelinen med inloggningen:

```bash
GEOTORGET_USER=... GEOTORGET_PASS=... npm run prepare-data
```

## Hur det funkar

- **Byggnader:** OpenStreetMap-fotavtryck (Overpass), höjd från `height`-tagg
  eller `building:levels` × 3 m + 1,5 m. Extruderas i three.js.
- **Sol:** SunCalc ger azimut/höjd; vektorn korrigeras för SWEREF99 TM:s
  meridiankonvergens (~2,6° i Stockholm).
- **"Sol eller skugga":** raycast från uteplatsen (1,2 m över mark) mot solen,
  mot terräng + byggnader. Skuggorna på skärmen är bara visualisering —
  avläsningen är geometrisk och deterministisk.
- **Solfönster:** dagen sveps i 5-minuterssteg.

## Verifiering

`npm test` kör enhetstester (solhöjder, koordinater, raycast).
`test/e2e_verify.py` (Playwright) sveper hela året i appen och jämför mot
det kända facit: solfönstret öppnar ~mitten av april och stänger ~slutet av
augusti. Senaste körning: första soldag ≈ 7 april, sista ≈ 7 september,
midsommar 09:55–17:10, 1 februari ingen sol.

Designspec: `docs/superpowers/specs/2026-06-10-uteplats-sol-design.md`
