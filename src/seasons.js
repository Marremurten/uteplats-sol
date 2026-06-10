// Årstidsmodell: dag på året (1–365) → mjukt interpolerade visuella
// parametrar för scenen. Ren JS utan beroenden så att modulen kan
// enhetstestas. Brytpunkterna är satta efter Stockholmsklimat.

// Kronpaletter — används av scene.js för instansfärger.
export const AUTUMN_CROWN_COLORS = [
  0xc46a2e, 0xb33d2b, 0xd9a83a, 0x8a6b3a, 0xcf8f33,
]
export const BLOSSOM_COLORS = [0xf3e6ea, 0xf6d7de]
export const SPRING_LEAF = 0x9fbf6a
export const TWIG_COLOR = 0x6b5a48

const clamp01 = (x) => Math.min(Math.max(x, 0), 1)
const smooth01 = (x) => {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

// [dag, värde]-keyframes med smoothstep emellan. Utanför första/sista
// nyckeln hålls ändvärdet — tabellerna har matchande värden vid års-
// skiftet så att alla kanaler är kontinuerliga över nyår.
function channel(doy, keys) {
  if (doy <= keys[0][0]) return keys[0][1]
  for (let i = 1; i < keys.length; i++) {
    const [d1, v1] = keys[i]
    if (doy <= d1) {
      const [d0, v0] = keys[i - 1]
      return v0 + (v1 - v0) * smooth01((doy - d0) / (d1 - d0))
    }
  }
  return keys[keys.length - 1][1]
}

const KEYS = {
  // Lövmängd på lövträden: lövsprickning mitten av april → slutet av maj,
  // lövfall oktober → mitten av november.
  foliage: [[105, 0], [150, 1], [274, 1], [318, 0]],
  // Grönt → höstpalett: september → mitten av oktober.
  autumnBlend: [[243, 0], [292, 1], [320, 1], [345, 0]],
  // Blomning (körsbär/fruktträd): slutet av april → slutet av maj.
  blossom: [[110, 0], [126, 1], [140, 1], [154, 0]],
  // Snötäcke: smälter slutet av februari → slutet av mars, kommer
  // slutet av november → mitten av december.
  snowCover: [[58, 1], [88, 0], [330, 0], [352, 1]],
  // Frostblek mark — syns när snötäcket är ofullständigt; ser till att
  // marken inte är sommargrön i mars.
  frost: [[58, 0.5], [95, 0.5], [125, 0], [288, 0], [315, 0.7], [340, 0.6], [365, 0.5]],
  // Allmän avmättnad av gräset utanför växtsäsongen.
  groundDull: [[1, 0.55], [120, 0], [270, 0], [300, 0.55]],
  // Lövförna på marken kring lövträd.
  leafLitter: [[1, 0.5], [100, 0.3], [130, 0], [270, 0], [300, 0.8], [320, 1], [365, 0.5]],
  // Vattnet fryser — släpar efter snötäcket något åt båda håll.
  ice: [[74, 1], [100, 0], [335, 0], [356, 1]],
  // Partikeldrivare.
  leafFallIntensity: [[272, 0], [285, 0.8], [300, 1], [315, 0.4], [325, 0]],
  snowfallIntensity: [[1, 0.8], [40, 0.6], [58, 0.3], [80, 0], [330, 0], [345, 0.8]],
}

export function seasonIcon(p, doy) {
  if (p.snowCover >= 0.4) return '❄️'
  if (
    p.autumnBlend > 0.2 ||
    p.leafFallIntensity > 0 ||
    (p.leafLitter > 0.35 && doy > 200)
  )
    return '🍂'
  if (doy >= 60 && doy <= 151) return '🌸'
  return '☀️'
}

export function seasonParams(doy) {
  const p = {}
  for (const k in KEYS) p[k] = channel(doy, KEYS[k])
  p.winterness = p.snowCover
  p.autumness = p.autumnBlend * (0.3 + 0.7 * p.foliage)
  p.icon = seasonIcon(p, doy)
  return p
}
