/**
 * Generates src/themes.css — the palette every chrome surface is painted from.
 *
 * The UI was hand-tuned as one blue-grey ramp (220 shades, all around hue 223) lit by an
 * orange accent. That ramp is the whole design: surfaces sit at the dark end, text at the
 * light end, borders in between. So a theme is not a pile of colours — it is that same
 * ramp re-hued, plus an accent.
 *
 * MIDNIGHT below lists the ramp as it was authored; its lightness and saturation are read
 * back out of those hexes and reused by every dark theme, which only swap the hue. That is
 * why re-theming does not flatten the elevation the design depends on. PAPER carries its
 * own ladder, because a light UI compresses its text range rather than mirroring the dark one.
 *
 * Run: node packages/app/tools/gen-themes.mjs
 */
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'themes.css')

// --------------------------------------------------------------- colour maths ----
const hex2hsl = (hex) => {
  const h = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  const d = mx - mn
  if (!d) return { h: 0, s: 0, l: l * 100 }
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
  const hue =
    mx === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : mx === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60
  return { h: hue, s: s * 100, l: l * 100 }
}

const hsl2hex = ({ h, s, l }) => {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
  const f = (n) => {
    const k = (n + h / 30) % 12
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n))

// ------------------------------------------------------------- the base ramp ----
// The authored greys, darkest surface (n0) to brightest text (n37). Every literal the CSS
// used to hardcode lands within about one lightness point of one of these steps.
const MIDNIGHT_RAMP = [
  '#04050a', '#07080d', '#0a0c12', '#0b0e16', '#0d0f16', '#0e1119', '#0f1420', '#111624',
  '#121724', '#141a28', '#151b29', '#171d2a', '#1a1f2e', '#1b2230', '#1d2433', '#1e2534',
  '#232838', '#232b3d', '#262e40', '#2a3348', '#333c52', '#3a4260', '#41495e', '#4e5770',
  '#5c6680', '#6b7691', '#7c8aa8', '#8892ad', '#8f9ab4', '#9aa3b8', '#aab6d3', '#b9c3d9',
  '#cbd3e6', '#d7dcea', '#dfe4f0', '#e8ecf8', '#f3f5fb', '#ffffff',
]
const BASE = MIDNIGHT_RAMP.map(hex2hsl)

/** A dark theme: the authored ladder, re-hued. `sat` scales saturation, `warm` shifts hue by step. */
const darkRamp = ({ hue, sat = 1, twist = 0 }) =>
  BASE.map((c, i) =>
    hsl2hex({
      h: (hue + twist * (i / (BASE.length - 1))) % 360,
      s: clamp(c.s * sat, 0, 100),
      l: c.l,
    }),
  )

/**
 * A light theme inverts the ramp's *role*, not its numbers: surfaces crowd the top of the
 * lightness range while text stays well short of black, which is what keeps a light UI from
 * looking like a photo negative of a dark one.
 */
const lightRamp = ({ hue, sat = 1 }) => {
  const L = [
    100, 99.2, 98.4, 97.6, 97, 96.4, 95.6, 94.6, 94, 93, 92.2, 91.4, 90.4, 89.4, 88, 86.6,
    84, 81.5, 79, 74, 68, 62, 58, 50, 44, 39, 34, 30, 28, 26, 22, 19, 16, 14, 12, 10, 7, 4,
  ]
  const S = [
    18, 20, 22, 24, 24, 24, 24, 24, 24, 24, 24, 23, 22, 22, 21, 20, 19, 18, 17, 16, 15, 14,
    14, 14, 14, 15, 15, 16, 16, 17, 18, 19, 20, 21, 22, 24, 26, 28,
  ]
  return L.map((l, i) => hsl2hex({ h: hue, s: clamp(S[i] * sat), l }))
}

// ------------------------------------------------------------------- the themes ----
// `chroma` names the lit colours. Each is [base, light, pale, ink, border, tint] where ink is
// the text that sits *on* a solid fill of that colour and tint is its faint background wash.
const THEMES = [
  {
    id: 'midnight',
    name: 'Midnight',
    blurb: 'The original: deep blue-black under an orange sun',
    ramp: darkRamp({ hue: 223 }),
    acc: '#ff7a45',
    chroma: { ok: '#3ddc97', warn: '#ffc94f', err: '#ff6b7a', info: '#5b9dff', cyan: '#56d8ff', violet: '#c792ea' },
  },
  {
    id: 'nebula',
    name: 'Nebula',
    blurb: 'Violet dust and a lilac accent',
    ramp: darkRamp({ hue: 265, sat: 1.15 }),
    acc: '#a78bfa',
    chroma: { ok: '#4ade80', warn: '#fbbf24', err: '#fb7185', info: '#818cf8', cyan: '#67e8f9', violet: '#e879f9' },
  },
  {
    id: 'terminal',
    name: 'Terminal',
    blurb: 'Phosphor green on near-neutral graphite',
    ramp: darkRamp({ hue: 155, sat: 0.45 }),
    acc: '#3ddc97',
    chroma: { ok: '#4ee3a3', warn: '#e3c34e', err: '#ff7a7a', info: '#5fb3d4', cyan: '#56d8ff', violet: '#b48ead' },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    blurb: 'Warm ash and a low gold sun',
    ramp: darkRamp({ hue: 20, sat: 0.8, twist: 12 }),
    acc: '#f0a742',
    chroma: { ok: '#7fb069', warn: '#ffd166', err: '#ef6f6c', info: '#6a9fb5', cyan: '#78c6d0', violet: '#c78ac0' },
  },
  {
    id: 'glacier',
    name: 'Glacier',
    blurb: 'Cold slate under pale ice blue',
    ramp: darkRamp({ hue: 200, sat: 0.9 }),
    acc: '#38bdf8',
    chroma: { ok: '#2dd4bf', warn: '#fcd34d', err: '#f87171', info: '#60a5fa', cyan: '#67e8f9', violet: '#a5b4fc' },
  },
  {
    id: 'paper',
    name: 'Paper',
    blurb: 'Ink on warm white, for daylight',
    light: true,
    ramp: lightRamp({ hue: 225, sat: 1 }),
    acc: '#c2410c',
    chroma: { ok: '#15803d', warn: '#a16207', err: '#be123c', info: '#1d4ed8', cyan: '#0e7490', violet: '#7e22ce' },
  },
]

// -------------------------------------------------------------------- emitting ----
/** Lit colours need a family, not a single value: a fill, a hover, a wash, a border, an ink. */
const family = (name, base, light) => {
  const c = hex2hsl(base)
  const lt = hsl2hex({ ...c, l: clamp(c.l + (light ? -10 : 10)) })
  const pale = hsl2hex({ ...c, l: clamp(c.l + (light ? -22 : 24)), s: clamp(c.s * 0.95) })
  const bd = hsl2hex({ ...c, s: clamp(c.s * (light ? 0.55 : 0.42)), l: light ? 78 : 22 })
  const tint = hsl2hex({ ...c, s: clamp(c.s * (light ? 0.6 : 0.5)), l: light ? 95 : 10 })
  // Ink rides on a solid fill of this colour, so it takes the opposite end of the ramp.
  const ink = c.l > 55 ? hsl2hex({ ...c, s: clamp(c.s * 0.75), l: 7 }) : '#ffffff'
  return [
    `  --${name}:${base};`,
    `  --${name}-lt:${lt};`,
    `  --${name}-pale:${pale};`,
    `  --${name}-bd:${bd};`,
    `  --${name}-bg:${tint};`,
    `  --${name}-ink:${ink};`,
  ].join('\n')
}

const block = (t) => {
  // The scope is not tied to :root, so any element can wear a theme — which is how the
  // gallery previews one: a card marked data-theme="paper" paints itself in Paper.
  // The third selector is the way back out of the stage's fixed dark palette, for chrome
  // that happens to be mounted inside #stage (the browser dock). It outranks the stage
  // block on specificity, which a plain :root-level rule would not.
  const at = t.id === 'midnight' ? ':root:not([data-theme])' : `:root[data-theme="${t.id}"]`
  const sel = [
    t.id === 'midnight' ? ':root' : `:root[data-theme="${t.id}"]`,
    `[data-theme="${t.id}"]`,
    `${at} #stage .themed`,
  ].join(',\n')
  const n = t.ramp
  const lines = [`/* ${t.name} — ${t.blurb} */`, `${sel}{`]
  lines.push(`  color-scheme:${t.light ? 'light' : 'dark'};`)
  lines.push(`  /* neutral ramp: n0 sits furthest from the text, n37 is the text itself */`)
  for (let i = 0; i < n.length; i += 1) lines.push(`  --n${i}:${n[i]};`)

  lines.push(`  /* lit colours */`)
  lines.push(family('acc', t.acc, t.light))
  for (const [k, v] of Object.entries(t.chroma)) lines.push(family(k, v, t.light))

  // A white inset highlight reads as "lit from above" on dark surfaces; on light ones the
  // same job falls to a faint black, otherwise the edge simply disappears.
  lines.push(`  /* surface treatments */`)
  lines.push(`  --hl:${t.light ? '0,0,0' : '255,255,255'};`)
  lines.push(`  --shadow:${t.light ? '215,25%,55%' : '0,0%,0%'};`)
  lines.push(`  --on-solid:#ffffff;`)

  // The names the existing CSS already speaks, re-pointed at the ramp.
  lines.push(`  /* aliases the components were written against */`)
  lines.push(aliasLines())
  lines.push('}')
  return lines.join('\n')
}

const ALIAS = {
  bg: 'n1', pan: 'n4', pan2: 'n8', ln: 'n17', tx: 'n35', dim: 'n27', dim2: 'n24',
  'pan-top': 'n9', 'pan-bot': 'n6', hair: 'n11',
  's-bg': 'n6', 's-panel': 'n5', 's-line': 'n13', 's-line2': 'n9', 's-mut': 'n25', 's-mut2': 'n23',
  blue: 'info',
}
/**
 * Aliases resolve where they are declared, not where they are read, so any scope that
 * restates the ramp has to restate these too or they keep pointing at the old colours.
 */
const aliasLines = () =>
  Object.entries(ALIAS)
    .map(([k, v]) => `  --${k}:var(--${v});`)
    .join('\n')

/**
 * The graph canvas is WebGL: it paints its own nodes and edges for a dark room and knows
 * nothing about themes. So the stage, and everything floating on it, keeps Midnight's ramp
 * whatever the rest of the app is wearing — the same way a 3D viewport or a map stays dark
 * inside a light IDE. Only the accent follows the theme, which reads fine against the canvas.
 *
 * Chrome that merely happens to be mounted inside #stage — the browser dock — opts back out
 * of this with class="themed".
 */
const stageScope = () => {
  const sel = ['#stage', '.hud', '#tip'].join(',\n')
  return [
    '/* The 3D stage is its own instrument: it stays dark in every theme. */',
    `${sel}{`,
    '  color-scheme:dark;',
    ...THEMES[0].ramp.map((v, i) => `  --n${i}:${v};`),
    '  --hl:255,255,255;',
    '  --shadow:0,0%,0%;',
    aliasLines(),
    '}',
  ].join('\n')
}

const css = `/* GENERATED by tools/gen-themes.mjs — edit the generator, not this file. */

${THEMES.map(block).join('\n\n')}

${stageScope()}
`

writeFileSync(OUT, css)

// The gallery needs a swatch per theme; keeping it derived means it cannot drift from the CSS.
const swatches = THEMES.map((t) => ({
  id: t.id,
  name: t.name,
  blurb: t.blurb,
  light: !!t.light,
  swatch: [t.ramp[1], t.ramp[8], t.ramp[19], t.acc, t.ramp[35]],
}))
console.log(`themes.css written — ${THEMES.length} themes, ${BASE.length} ramp steps`)
console.log(JSON.stringify(swatches, null, 2))
