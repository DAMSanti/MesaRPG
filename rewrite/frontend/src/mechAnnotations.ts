import { useEffect, useState } from 'react'
import { listMechAnnotations, type MechAnnotation } from './api'

/** MechLab's saved per-model annotations, and the one place that reads a
 * limb's real membership out of them.
 *
 * Lives in its own module rather than in HexMap (where the cache used to
 * sit) because Mech3D needs it too, and HexMap already imports Mech3D —
 * putting it there would close an import cycle.
 */

// Real user request: "no es muy largo hacer que las armas disparen de esas
// zonas y los impactos se hagan en esos puntos?" — MechLab's own
// mech_model_annotations only ever get written by that editor, so they
// change rarely and this only needs to be "close enough," not live-reactive
// to someone editing MechLab in another tab.
//
// ONE fetch for the whole page, not one per component. This used to be per
// mounted view, which was fine while only the three views called it; now
// every Mech3D on the board reads it too, and a board with eight mechs on
// it would have asked the server the same question eight times.
const EMPTY: MechAnnotation[] = []
let cached: MechAnnotation[] | null = null
let inFlight: Promise<MechAnnotation[]> | null = null
const waiting = new Set<(annotations: MechAnnotation[]) => void>()

/** Drops the cache so the next mount refetches — MechLab calls this after
 * saving, which is the only thing in the app that ever writes these. Without
 * it, annotating a limb and going straight back to the board would show you
 * the data as it was when the tab was opened. */
export function invalidateMechAnnotations() {
  cached = null
  inFlight = null
}

export function useMechAnnotationsCache() {
  const [annotations, setAnnotations] = useState<MechAnnotation[]>(cached ?? EMPTY)
  useEffect(() => {
    if (cached) {
      setAnnotations(cached)
      return
    }
    waiting.add(setAnnotations)
    if (!inFlight) {
      inFlight = listMechAnnotations()
      inFlight
        .then((rows) => {
          cached = rows
          for (const notify of [...waiting]) notify(rows)
          waiting.clear()
        })
        // Cleared so a later mount retries rather than being stuck on empty
        // for the life of the tab because the server blinked once.
        .catch(() => { inFlight = null })
    }
    return () => { waiting.delete(setAnnotations) }
  }, [])
  return annotations
}

/** Which limb location each of a model's nodes belongs to, keyed by the
 * node's own name folded to lower case.
 *
 * Real user report: "el perder extremidades no hace nada, el mech no
 * pierde sus extremidades, debería hacer igual que en mechlab."
 *
 * It behaved differently BECAUSE the two screens were reading different
 * things. MechLab hides exactly the nodes listed in the model's saved
 * `kind: 'limb'` annotation — the list you build by hand in its
 * Extremidades tab, which is what "tener las extremidades configuradas"
 * means. The board, meanwhile, was matching node names against a
 * hardcoded guess ('brazoi', 'leftarm', 'piernai', ...) that had never
 * been reconciled with what the models are actually called. On the Jenner
 * that guess got the arms and missed both legs: two of its nodes share a
 * name with a bone in its own skeleton, so GLTFLoader renames them
 * `PiernaI_1`/`PiernaD_1` on load, and no hardcoded list was ever going
 * to contain a suffix three.js invents at load time. The annotation has
 * the real names because it was saved from the loaded scene.
 *
 * So the saved data wins, and the hardcoded list survives only as the
 * fallback for a model nobody has annotated yet.
 *
 * A limb whose annotation lists BONE names instead of mesh names (MechLab
 * lets you paint a limb that way, for the single-mesh chassis with no
 * separate arm node to click) resolves to nothing here — there is no mesh
 * to hide, and hiding the bone would take the whole model with it. Those
 * chassis keep the silhouette they have today; splitting a skinned mesh
 * by weight at render time is a different job from this one.
 */
export function limbLocationLookup(
  annotations: MechAnnotation[],
  modelUrl: string | null | undefined,
): ReadonlyMap<string, string> {
  const lookup = new Map<string, string>()
  if (!modelUrl) return lookup
  for (const annotation of annotations) {
    if (annotation.kind !== 'limb' || annotation.location == null) continue
    if (annotation.model_url !== modelUrl) continue
    for (const name of annotation.mesh_names ?? []) {
      lookup.set(name.trim().toLowerCase(), annotation.location)
    }
  }
  return lookup
}
