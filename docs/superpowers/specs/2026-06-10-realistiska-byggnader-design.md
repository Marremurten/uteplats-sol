# Realistiska hus, fönster, skorstenar och träd

**Datum:** 2026-06-10
**Status:** Design godkänd, redo för implementationsplan

## Bakgrund

Appen kör idag i `dsm`-läge. Hela landskapet ritas som **en enda laser-yta** (1 m
höjdgrid) färgad per cell efter klass (mark / vatten / byggnad / vegetation). Husen
är alltså bara upphöjda klumpar i samma mesh som marken — det finns ingen
åtskillnad mellan tak och fasad, vilket gör att takfärgen "rinner ner" på husens
branta sidor. Husen ser inte ut som riktiga hus, och träden är gröna klumpar.

Skuggberäkningen för solfönstret på gården vilar på en separat, osynlig
laser-occluder (`occluderMesh`) som raycastas. Den är korrekt och ska **inte**
röras — allt nedan är förändringar i det *visuella* lagret.

## Mål

Få stadsmiljön att se realistisk ut:

1. Husen ska läsas som riktiga hus med tydlig tak/fasad-uppdelning.
2. Fasader ska variera i material och kulör (tegel/puts i olika nyanser).
3. Fönster på fasaderna, som lyser på natten i takt med dygnscykeln.
4. Skorstenar där taken faktiskt är ojämna.
5. Träd som ser ut som träd och varierar — inte identiska klumpar.

## Icke-mål (YAGNI)

- Ingen riktig fönstergeometri (urgröpta/utskjutande fönster).
- Inga balkonger, portar eller andra fasaddetaljer.
- Ingen OSM-materialtaggning (`building:material`/`building:colour`).
- Ingen LOD (level-of-detail).
- Ingen förändring av skuggberäkningen eller datapipelinen.

## Princip: kosmetik ovanpå oförändrad skuggvärld

Den auktoritativa skuggberäkningen (raycast mot `occluderMesh`, laser-griden)
behålls oförändrad. De nya husen, träden och skorstenarna är ett rent visuellt
lager. Eftersom husen byggs från samma laserhöjder som occludern matchar de
varandra nära, men det visuella behöver inte vara raycast-exakt.

## Designen

### 1. Rendering-omläggning (`dsm`-grenen i `createScene`)

Idag: `if (data.terrain.mode !== 'dsm')` hoppar över de extruderade husen, och
`terrainMesh` ritar hela DSM-ytan (mark + hus + träd) vertексfärgad.

Nytt i `dsm`-läget:

- **Basyta** byggs från markgriden (`groundFile` = `terrain.bin`, utan hus/träd).
  För celler som klassas som **vegetation** används istället DSM-höjden så att
  trädens silhuett finns kvar som referens — men se punkt 6: träden ritas som
  egna objekt, så vegetationen i basytan plattas i praktiken till mark och träden
  läggs ovanpå. Husceller plattas alltid till marknivå (de täcks av extruderade
  hus). Nettot: basytan är ren mark/vatten.
- **Husen** ritas via `makeLaserBuilding` (aktiveras även för `dsm`). Varje hus
  blir en grupp med vägg-mesh + tak-mesh, `castShadow`/`receiveShadow` på.
- **Skuggvärlden** är fortsatt `occluders = [occluderMesh]`, osynlig och orörd.

Returkontraktet från `createScene` (`requestRender`, `setSun`, `samplePoint`,
`occluders`) ändras inte, så `shade.js`/`main.js` påverkas inte.

### 2. Tak vs fasad + fix för "tak på fasaden"

Vägg och tak är redan separata meshar i `makeLaserBuilding` och får olika material
per definition. Problemet "tak på fasaden" är **branta takkjolar**: där lasern
fångat höga kanter nära fotavtryckets rand bildar takgriden en nästan vertikal yta
från takfot upp till kanthöjden, ritad med takmaterial.

Fix: **klassa takets trianglar efter normalens lutning.** Trianglar brantare än ett
tröskelvärde (riktvärde ~60° från horisontalplanet, dvs `normal.y` under ~0,5) får
**fasadmaterialet** istället för takmaterialet. En brant kant läses då som vägg.
Implementeras med två materialgrupper på tak-geometrin (`geometry.addGroup` +
material-array `[takMat, fasadMat]`), tilldelade per triangel utifrån beräknad
normal.

### 3. Fasadmaterial & palett

Varje hus tilldelas material deterministiskt via en hash av `b.id` (stabilt mellan
körningar, inget fladder). Ren funktion `pickBuildingStyle(id) -> { wallColor,
roofColor, isBrick }`, enhetstestbar.

Kurerad Stockholmspalett (riktvärden, justeras visuellt vid implementation):

- **Puts** (fasad): ockragul `#d8b376`, varmgrå `#b9b3a6`, bruten vit `#e6e0d4`,
  blekrosa `#d9b7a8`, ljus terrakotta `#cf9b76`.
- **Tegel** (fasad): rödbrun `#9c5e4a`, mörkare brunröd `#7d4536`.
- **Tak**, korrelerat med fasad: tegelfasad → tegelrött tak (`#8f4a39`);
  putsfasad → varierat mörkgrått/plåt (`#4a4a4e`, `#6a6a66`) med någon enstaka
  patinerat kopparngrönt (`#5a8a78`).

Fördelning styrs av hashen (t.ex. ~⅓ tegel, ~⅔ puts).

### 4. Fönster (procedurellt, lyser på natten)

Fönster "målas" på vägg-meshen genom att utöka standardmaterialet via
`onBeforeCompile` (eller motsvarande shader-injektion):

- **Rader** var ~3:e meter i höjdled (våningshöjd), räknat från takfot/mark.
- **Kolumner** i jämn horisontell takt längs väggen.
- Mörka glasrutor på dagen.
- En delad uniform `uNight` (0..1) styr ett **varmt emissivt sken** i fönstren när
  solen är under horisonten. `setSun` får sätta `uNight` utifrån solhöjden (samma
  `dayness`/altitud-logik som redan finns). Uniformen delas mellan alla
  hus-material (en registrerad referens som scenen uppdaterar i `setSun`).

Ingen extra geometri — i princip gratis även med många hus. Horisontellt
koordinatunderlag tas från väggens lokala position/UV; exakt mappning fastställs i
implementationen (ExtrudeGeometry-UV eller world-position-baserat).

### 5. Skorstenar (från laserspikarna)

`makeLaserBuilding` kör idag ett 3×3-medianfilter som tar bort takets punktspikar
(skorstenar/antenner/ventilation). De bortfiltrerade spikarna är en karta över var
skorstenarna sitter.

- Innan `inside` skrivs över med `smoothed`: spara **differensen** `raw - smoothed`
  per cell.
- Celler där differensen överstiger ett tröskelvärde (riktvärde > 1,0 m) och som är
  lokala toppar markeras som skorstenskandidater.
- **Klustra** ihopliggande kandidatceller till en skorsten var.
- Sätt en liten mörk låda (riktvärde ~0,8 m bred) från den utjämnade takytan upp
  till spikhöjden, med en **höjdtak-gräns** så att höga antennspikar inte blir
  orimliga skorstenar.
- Material: mörkt tegel/betong. `castShadow` på.

### 6. Träd (enkla 3D-träd, varierade)

Detektera **enskilda träd** ur vegetationsklassen (`classGrid` == 3):

- Klustra ihopliggande vegetationsceller; varje **lokal höjdtopp** i klustret = ett
  träd. Placeras på markhöjd (`sampleGround`), med kronhöjd/-bredd skalad från
  DSM-höjden i toppen.
- Varje träd = **stam (cylinder) + lövkrona**. Variation deterministiskt via hash
  av trädets position (stabilt mellan körningar):
  - **Form**: kronan väljs bland några typer — klot (lövträd), kägla (barrträd),
    bredare oval.
  - **Storlek**: höjd och kronbredd från laserhöjden + liten slumpvariation, så två
    lika höga träd inte blir identiska.
  - **Färg**: gröna nyanser varieras (ljus–mörk), någon enstaka höst/gulton.
  - **Rotation/lutning**: liten slumpmässig vridning + svag lutning.
- **`InstancedMesh` per krontyp** (en instans-grupp för klot, en för kägla, osv.)
  så olika geometrier tillåts samtidigt som det skalar till hundratals träd.
- Träden skuggar **inte** (medvetet, oförändrat) — de läggs inte i occludern.

### 7. Kodpåverkan

- `src/scene.js`: `dsm`-grenen i `createScene`; aktivera `makeLaserBuilding` för
  `dsm`; ny basyte-byggare (mark utan hus/träd); tak-triangelklassning;
  fönster-shader; skorstensdetektering i `makeLaserBuilding`; trädmodul
  (detektering + instansering); `uNight`-krok i `setSun`.
- Inga ändringar i `scripts/prepare-data.mjs` (datapipeline) eller `src/shade.js`
  (skuggberäkning). `data.js` exponerar redan `sampleGround`, `sampleOccluder`,
  `classGrid` som behövs.

### 8. Test

Befintliga tester ska fortsatt passera. Nya enhetstester för de rena funktionerna:

- `pickBuildingStyle(id)` — deterministisk, giltiga kulörer, rimlig
  tegel/puts-fördelning.
- Skorstensdetektering — given en liten höjdmatris med en spik hittas rätt cell;
  ingen falsk skorsten på jämn yta.
- Trädklustring — sammanhängande vegetationsceller ger rätt antal träd och toppar.

Visuell verifiering (skärmdump av scenen dag och natt) görs i implementationsfasen.

## Öppna detaljer som avgörs vid implementation

- Exakt lutningströskel för tak→fasad-klassningen.
- Horisontell koordinatmappning för fönsterrutnätet (UV vs world-position).
- Exakta tröskelvärden för skorstensspikar och trädklustring.
- Slutlig finjustering av palettkulörerna mot den faktiska scenen.
