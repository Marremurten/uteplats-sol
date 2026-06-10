# Uteplats-sol — designspec

**Datum:** 2026-06-10
**Status:** Utkast för granskning

## Syfte

Svara exakt på frågan: *när får vår uteplats sol?* Uteplatsen ligger på en
nedsänkt gård på Södermalm i Stockholm (WGS84: 59.319274, 18.034358) och får
idag sol ungefär mitten av april till mitten av augusti. Omgivande byggnader
och gårdens nedsänkning skymmer den låga solen resten av året.

Lösningen är en interaktiv 3D-webbapp där man drar i datum- och tidsreglage
och ser skuggorna vandra över gården i realtid, med en tydlig avläsning av om
uteplatsen har sol just då samt dagens solfönster.

## Datakällor

| Data | Källa | Format/åtkomst |
|---|---|---|
| Terräng (den nedsänkta gården) | Lantmäteriets *Markhöjdmodell Nedladdning*, DTM 1 m-grid | Öppna data, CC BY 4.0. Nedladdningsbar via Lantmäteriets STAC-katalog (stacindex.org: "markhojdmodell-nedladdning-lantmateriet") eller Geotorget med gratis konto. GeoTIFF i SWEREF99 TM (EPSG:3006). |
| Byggnader (skuggkastarna) | Stockholms stads *3D-Byggnader (LOD1)* | Via dataportalen.stockholm.se / kartor.stockholm. Åtkomstform verifieras i steg 1. |
| Byggnader, reservplan | OpenStreetMap via Overpass API | Fotavtryck + `height`/`building:levels`. Gratis, ingen registrering. Höjder kompletteras manuellt för de närmaste husen om taggar saknas. |
| Solposition | SunCalc (JS-bibliotek) | Beräknas lokalt, inget API. |

**Områdesavgränsning:** en ruta om ca 500 × 500 m centrerad på uteplatsen.
Det räcker gott — på Södermalm är det husen i samma kvarter och närmaste
grannkvarter som skymmer; en låg vintersol i söder blockeras långt innan
horisonten 250 m bort spelar roll.

**Känd risk:** LOD1-datans åtkomst är obekräftad (kan kräva beställning).
Reservplanen (OSM) är beprövad och täcker Södermalm väl, så risken är låg
för projektet som helhet.

## Arkitektur

Två delar, tydligt separerade:

### 1. Datapipeline (körs en gång, Node-skript)

`scripts/prepare-data.mjs` + ev. hjälpskript:

- Laddar ner DTM-rutan/rutorna som täcker området, klipper till 500 × 500 m,
  och skriver ut en **höjdkarta** som webben kan läsa (binär Float32-fil +
  JSON-metadata med hörnkoordinater och upplösning).
- Hämtar byggnadsdata (LOD1 eller OSM), klipper till området, och skriver en
  **GeoJSON** med fotavtryck + takhöjd per byggnad, i SWEREF99 TM.
- All vidare koordinathantering i appen sker i ett lokalt metersystem med
  origo i uteplatsen (SWEREF99 TM minus origo) — three.js jobbar då i meter
  rakt av, och norr = −Z i scenen.

Resultatet checkas in i `public/data/` så att appen funkar utan att pipelinen
behöver köras om.

### 2. Webbapp (Vite + three.js, helt statisk)

- **Terräng:** höjdkartan blir en `PlaneGeometry` med förskjutna hörn
  (1 m-upplösning ⇒ ~500×500 vertexar, hanterbart).
- **Byggnader:** varje fotavtryck extruderas till takhöjd (`ExtrudeGeometry`).
  Basen sätts till terrängens *lägsta* punkt under fotavtrycket (så inga
  glipor uppstår på lutande mark). LOD1 anger takhöjd absolut (möh) och
  används rakt av; OSM-höjder enligt `height` (relativ ⇒ adderas på markens
  högsta punkt under fotavtrycket) eller `building:levels × 3 m + 1,5 m`
  som approximation.
- **Sol:** `DirectionalLight` med skuggkastning (shadow map, ortografisk
  kamera dimensionerad till området). Riktningen beräknas av SunCalc
  (azimut + höjd för lat/lon + valt datum/klockslag). När solen är under
  horisonten släcks ljuset och scenen visar "natt".
- **Uteplatsmarkör:** en synlig markör på uteplatsens koordinat.
- **UI:**
  - Datumreglage (1 jan–31 dec) och tidsreglage (00–24, visar gråzon
    utanför soluppgång/solnedgång).
  - Statuspanel: "☀️ Sol på uteplatsen" / "🌑 Skugga" för valt ögonblick.
  - **Dagens solfönster:** för valt datum sveps dagen i 5-minuterssteg och
    panelen visar t.ex. "Sol 11:20–14:35".
  - Orbit-kontroller för att snurra/zooma i scenen.

### Sol/skugga-avläsningen (kärnlogiken)

Avgörandet "har uteplatsen sol kl T?" görs **inte** via shadow map-avläsning
(opålitligt och GPU-bundet) utan med en **raycast**: en stråle från
uteplatspunkten (≈1 m över mark) mot solens riktning, testad mot terräng- och
byggnadsgeometrin. Träffar strålen något ⇒ skugga. Detta gör avläsningen
exakt, deterministisk och testbar — shadow map:en är bara den visuella
presentationen. Solfönster-svepet (288 raycasts/dag) är försumbart snabbt.

## Komponentindelning

| Modul | Ansvar |
|---|---|
| `scripts/prepare-data.mjs` | Hämta/klippa/konvertera geodata → `public/data/` |
| `src/data.js` | Läsa höjdkarta + GeoJSON, bygga lokala koordinater |
| `src/scene.js` | three.js-scen: terräng, byggnader, ljus, markör |
| `src/sun.js` | SunCalc-wrapper: (datum, tid) → solvektor i scenkoordinater |
| `src/shade.js` | Raycast-logik: är punkten solbelyst? + dagsvep för solfönster |
| `src/ui.js` | Reglage, statuspanel, koppling till scen |

`sun.js` och `shade.js` är rena funktioner utan DOM/GPU-beroende ⇒ enhetstestbara.

## Testning

- **Enhetstester (Vitest):** koordinatkonvertering (kända SWEREF99-punkter),
  solvektor (kända soluppgångar/middagshöjder för Stockholm, t.ex.
  sommarsolstånd ≈ 54° middagshöjd, vintersolstånd ≈ 7°), raycast-logik mot
  syntetisk geometri (en låda söder om punkten ⇒ skugga vid låg sol, sol vid
  hög).
- **Verifiering mot verkligheten:** facit finns! Appen ska reproducera det
  kända beteendet: solfönstret öppnar ~mitten av april och stänger ~mitten
  av augusti. Stämmer inte det är data eller geometri fel.
- **Visuell kontroll:** webapp-testning med skärmdumpar vid kända datum
  (midsommar kl 12 ⇒ sol; 1 februari ⇒ aldrig sol).

## Felhantering

- Pipeline: tydliga fel om STAC-/API-anrop misslyckas eller området saknar
  täckning; ingen tyst degradering.
- App: om datafiler saknas visas instruktion att köra pipelinen.
- Solen under horisonten: hanteras explicit (natt-läge), inga NaN-vinklar.

## Avgränsningar (YAGNI)

- Endast en plats (uteplatsen) — ingen "klicka var som helst"-funktion i v1
  (raycast-arkitekturen gör det lätt att lägga till senare).
- Ingen vegetation (träd) i v1 — DTM+LOD1 saknar träd; om verkligheten visar
  att ett träd spelar roll kan det läggas in manuellt som geometri.
- Ingen backend, ingen deploy — körs lokalt med `npm run dev`.
- Atmosfärisk refraktion och diffust ljus ignoreras; "sol" = direkt solljus
  enligt geometrin.
