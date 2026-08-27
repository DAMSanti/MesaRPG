// Die-style catalog (real user request: "muchos diseños, perlados,
// metalicos, con puntos, con numeros, tanta variedad como en la vida
// real") — every player and the GM can each pick ONE of these, exclusive
// across the whole campaign (see app/dice_styles.py's DIE_STYLE_IDS,
// which must match this file's ids 1:1 — kept in sync by eye, same as
// pilotColors.ts vs scripts/backfill_pilot_colors.py, no shared config
// between the two languages in this codebase).
import type { Campaign, Pilot } from './api'

export type DieMaterialKind = 'standard' | 'metallic' | 'pearl' | 'glass'
export type DieMarkingKind = 'pips' | 'numbers'

// Real user follow-up: "quiero texturizar los dados de verdad, ahora
// solo son colores planos con 'brillo'... dados metalicos con textura...
// mapa metalico, roughness y glossiness, normales, ambient occlusion,
// mascara de oxido" — 'metallic' styles now carry a REAL scanned PBR set
// (Die.tsx loads color/normal/roughness/metalness maps from
// public/textures/dice/, see its own CREDITS.md entry) instead of a flat
// tinted color. Two sets: 'chrome' (Metal032, clean polished steel) and
// 'rust' (Metal025, real oxidation baked into its own color/roughness —
// the "mascara de oxido" ask, from an actually weathered scan rather
// than a hand-painted mask layer).
export type DieTextureSet = 'chrome' | 'rust'

export interface DieStyle {
  id: string
  name: string
  color: string
  material: DieMaterialKind
  marking: DieMarkingKind
  textureSet?: DieTextureSet
  /** 'pearl' only — the accent color its procedural veining is drawn in
   * (Die.tsx's createPearlVeinTexture). Real user request: "quiero
   * tambien subsurface scattering para los dados perlados... con vetas
   * de otro color/textura intravenado". */
  veinColorHex?: string
}

export const DIE_STYLES: DieStyle[] = [
  { id: 'standard-ivory', name: 'Marfil clásico', color: '#eef1ef', material: 'standard', marking: 'pips' },
  { id: 'standard-onyx', name: 'Ónix clásico', color: '#232323', material: 'standard', marking: 'pips' },
  { id: 'crimson-pip', name: 'Carmesí', color: '#b33033', material: 'standard', marking: 'pips' },
  { id: 'cobalt-pip', name: 'Cobalto', color: '#2a5ea8', material: 'standard', marking: 'pips' },
  { id: 'verdant-pip', name: 'Esmeralda', color: '#2f7d4f', material: 'standard', marking: 'pips' },
  { id: 'amber-numeral', name: 'Ámbar numerado', color: '#c98a2c', material: 'standard', marking: 'numbers' },
  { id: 'slate-numeral', name: 'Pizarra numerada', color: '#4d5760', material: 'standard', marking: 'numbers' },
  { id: 'chrome-metallic', name: 'Cromo', color: '#c7ccd1', material: 'metallic', marking: 'numbers', textureSet: 'chrome' },
  { id: 'gunmetal-metallic', name: 'Metal oxidado', color: '#3a3f45', material: 'metallic', marking: 'pips', textureSet: 'rust' },
  { id: 'opal-pearl', name: 'Ópalo perlado', color: '#e9e4f0', material: 'pearl', marking: 'pips', veinColorHex: '#8fa0e0' },
  // Real user request: "dados traslucidos que generen causticas sobre la
  // grid cuando les de la luz" — real alpha transparency + an emissive
  // glow (see resolveDieStyle's own doc comment for why NOT
  // MeshPhysicalMaterial's transmission feature, despite that being the
  // obvious first choice for "real glass"). Its own caustic light-pattern
  // projection is DieCausticsProjector, wired in wherever this style
  // rolls (TableView) — that part is unaffected either way.
  { id: 'jade-glass', name: 'Cristal de jade', color: '#3fae7a', material: 'glass', marking: 'numbers' },
]

export interface ResolvedDieLook {
  color: string
  roughness: number
  metalness: number
  marking: DieMarkingKind
  iridescence?: number
  sheen?: number
  sheenColorHex?: string
  textureSet?: DieTextureSet
  ior?: number
  veinColorHex?: string
  clearcoat?: number
  clearcoatRoughness?: number
  envMapIntensity?: number
  /** Real alpha transparency — see this function's own doc comment on
   * why glass/pearl use this instead of MeshPhysicalMaterial's
   * transmission feature. 1 (fully opaque) when unset. */
  opacity?: number
  /** A soft inner glow tinted by this color — Die.tsx applies it as an
   * emissiveMap sourced from the SAME canvas the face color itself was
   * drawn from, so whichever areas are actually vein-colored (pearl) is
   * what glows, not a flat all-over wash. 'pearl' only now — see the
   * 'glass' fields below for why glass uses real transmission instead. */
  glowColorHex?: string
  glowIntensity?: number
  /** 'glass' only — real refraction (MeshPhysicalMaterial's transmission).
   * Real user demand, after an opacity-only fallback was rejected as "una
   * puta mierda... devuelvelos al punto donde eran de cristal de verdad
   * con trasmision": genuine transmission, not another faked-translucency
   * substitute. Setting this is also the flag Die.tsx's own materials
   * useMemo uses to switch that one style onto a single atlased material
   * instead of the usual per-face array — see resolveDieStyle's own doc
   * comment on the glass branch for why that's required. Unset (0/undefined)
   * for every other style. */
  transmission?: number
  thickness?: number
  attenuationColorHex?: string
  attenuationDistance?: number
}

// Falls back to the legacy plain-box look (a pilot's own `color`, matte
// plastic, pips) when no style is picked — zero visual regression for
// anyone who never engages with this feature. 'metallic' uses a real
// scanned PBR texture set (see DieTextureSet above) PLUS the shared HDRI
// environment (TableView's own <Environment>, offline/bundled — see
// public/textures/CREDITS.md) for real reflections, closing the "won't
// read as true chrome" gap the old flat-metalness version had.
//
// 'pearl' real user follow-up: "deben tener mucha mas subsurface
// scattering, ahora mismo apenas penetra la luz" — a real pearl isn't
// very see-through to begin with, so it stays on plain alpha opacity plus
// an emissive glow sourced from its own vein texture (glowColorHex);
// that combination is what actually reads as "light gathering in the
// veins" for a nacreous, mostly-opaque surface.
//
// 'glass' real user follow-up chain: "los dados de cristal de jade han
// perdido su textura de cristal, ya no es transparente para nada" (the
// root cause: a real, documented three.js limitation — transmission
// doesn't reliably engage when a mesh's `material` is an ARRAY, which
// every style here needs for its own per-face pip/number texture) ->
// (an opacity-only fallback, same technique as pearl) -> explicitly
// rejected: "asi son una puta mierda... devuelvelos al punto donde eran
// de cristal de verdad con trasmision... o soluciona lo del
// transmision... dedicale tiempo". The real fix: transmission itself
// isn't broken, only its multi-material-array interaction is — so
// 'glass' alone gets a SINGLE material (all 6 faces' numbers baked into
// one shared atlas texture, see Die.tsx's buildFaceAtlasTexture/
// remapUvsToAtlas) instead of joining every other style's per-face
// array, which sidesteps the real limitation instead of faking around it.
export function resolveDieStyle(styleId: string | null | undefined, fallbackColor: string): ResolvedDieLook {
  const found = DIE_STYLES.find((s) => s.id === styleId)
  if (!found) return { color: fallbackColor, roughness: 0.45, metalness: 0.05, marking: 'pips' }
  if (found.material === 'metallic') {
    return {
      color: found.color, roughness: 0.25, metalness: 0.85, marking: found.marking, textureSet: found.textureSet,
      envMapIntensity: 1.6,
    }
  }
  if (found.material === 'pearl') {
    // Real user follow-up: "deben tener mucha mas subsurface scattering,
    // ahora mismo apenas penetra la luz" — a strong emissive glow tinted
    // by the vein color (Die.tsx sources its emissiveMap from the exact
    // same veined canvas the face color itself uses) is what actually
    // reads as "light gathering in the veins" now, on top of its
    // existing iridescence/sheen/clearcoat for the nacre finish. A real
    // pearl isn't very see-through, so opacity stays high — the
    // translucent read comes from the glow, not from seeing through it.
    return {
      color: found.color, roughness: 0.3, metalness: 0.1, marking: found.marking,
      iridescence: 1, sheen: 1, sheenColorHex: found.color,
      clearcoat: 0.6, clearcoatRoughness: 0.15,
      envMapIntensity: 1.3,
      opacity: 0.95,
      veinColorHex: found.veinColorHex,
      glowColorHex: found.veinColorHex ?? found.color, glowIntensity: 1.1,
    }
  }
  if (found.material === 'glass') {
    // Real transmission again — see this function's own doc comment
    // above for the full chain of why. thickness/attenuationColor/
    // attenuationDistance are transmission's own "how much and what
    // color the glass absorbs over distance" controls — a real gem tints
    // deeper on light that travels further through it, which is what
    // attenuationColor (this style's own base color) does here.
    return {
      color: found.color, roughness: 0.04, metalness: 0, marking: found.marking,
      ior: 1.5,
      envMapIntensity: 1.8,
      transmission: 1,
      thickness: 0.6,
      attenuationColorHex: found.color,
      attenuationDistance: 1.1,
    }
  }
  return { color: found.color, roughness: 0.45, metalness: 0.05, marking: found.marking }
}

// styleId -> display name of whoever holds it ('GM' or a pilot's own
// name) — shared by both GMView's and PlayerView's settings modals so
// this lookup logic isn't duplicated twice.
export function buildHeldByMap(
  pilots: Pick<Pilot, 'id' | 'die_style' | 'name'>[],
  campaign: Pick<Campaign, 'gm_die_style'> | null,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const p of pilots) if (p.die_style) map.set(p.die_style, p.name)
  if (campaign?.gm_die_style) map.set(campaign.gm_die_style, 'GM')
  return map
}
