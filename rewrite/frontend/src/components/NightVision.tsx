import './NightVision.css'

/** Night-vision goggles over the GM's map.
 *
 * Real user request: "cuando en GMview se hace completamente de noche,
 * quiero que se active un modo night vision automáticamente para que el GM
 * pueda verlo todo aun a oscuras. Se verá como unas gafas de visión
 * nocturna."
 *
 * Two halves that have to be read together. The LOOK is here — the green
 * phosphor cast, the circular field the goggles actually see, the grain.
 * The ability to SEE is not: no amount of tinting rescues an image that is
 * genuinely black, so SceneLighting takes a `nightVision` flag and lifts
 * the board's own light to something legible first. Tinting alone would
 * have produced a green black screen.
 *
 * Deliberately only the GM's. A player in the cockpit is supposed to be
 * fighting at night; the GM is supposed to be able to run the fight.
 *
 * Nothing here is interactive and nothing here is a game rule — it does not
 * reveal a hidden unit or change line of sight. It is a way of looking at a
 * dark board. */
export function NightVision({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <div className="night-vision-overlay" aria-hidden>
      {/* The bright ring at the edge of the intensifier tube, and the fall
          off to black outside the goggles' own field. */}
      <div className="night-vision-field" />
      {/* Sensor noise. The thing that sells an intensified image more than
          the colour does — a perfectly clean green picture reads as a
          filter, a noisy one reads as a device. */}
      <div className="night-vision-grain" />
      <div className="night-vision-scanlines" />
      <div className="night-vision-readout">
        <span className="night-vision-dot" />
        NV
      </div>
    </div>
  )
}
