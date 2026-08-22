import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useCampaignId } from '../useCampaignId'
import { useMapId } from '../useMapId'
import { useTableSocket } from '../ws'
import { PilotForm } from '../components/PilotForm'
import { MechLocationsGrid } from '../components/MechLocationsGrid'
import { MechRecordSheet } from '../components/MechRecordSheet'
import { MechImportSelector } from '../components/MechImportSelector'
import { WeaponVolleyPanel } from '../components/WeaponVolleyPanel'
import { FirstPersonView } from '../components/FirstPersonView'
import {
  buildMechLocationsPayload, emptyLocationsForm, locationsFormFromMechLocationIn, previewMechFromLocationsForm,
} from '../characterSheet'
import { getDeviceToken } from '../deviceToken'
import {
  addMechWeapon,
  attack,
  createMech,
  createPilot,
  getUnits,
  getVisibility,
  getWeaponCatalog,
  listCampaigns,
  listMechChassis,
  listMechs,
  listPilots,
  markRoundActed,
  requestMovement,
  resubmitMech,
  resubmitPilot,
  requestInitiative,
  updateMechCritical,
  updateMechLocation,
  updatePilot,
  type Campaign,
  type Mech,
  type MechImportData,
  type MovementType,
  type Pilot,
  type Unit,
  type WeaponStats,
} from '../api'
import { activeMoverPilotId, formatRolls } from '../rounds'
import { suggestPilotColor } from '../pilotColors'
import { MECH_CHASSIS_ASSETS } from '../mechAssets'
import './PlayerView.css'

function usePilotId() {
  const [params, setParams] = useSearchParams()
  const fromUrl = params.get('pilot')
  return {
    pilotId: fromUrl ? Number(fromUrl) : null,
    choose: (id: number) => setParams((p) => ({ ...Object.fromEntries(p), pilot: String(id) })),
  }
}

export function PlayerView() {
  const campaignId = useCampaignId({ allowPicker: false })
  const { pilotId, choose } = usePilotId()
  const { lastAttack, activeMapId, roundState, visibility } = useTableSocket(campaignId)
  const mapId = useMapId(campaignId, activeMapId)

  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [pilots, setPilots] = useState<Pilot[]>([])
  const [mechs, setMechs] = useState<Mech[]>([])
  const [units, setUnits] = useState<Unit[]>([])
  const [visible, setVisible] = useState<Record<string, number[]>>({})
  const [log, setLog] = useState<string[]>([])
  const [weaponId, setWeaponId] = useState<number | ''>('')
  const [selectedTarget, setSelectedTarget] = useState<Unit | null>(null)
  const [firingVolley, setFiringVolley] = useState(false)
  const [joinName, setJoinName] = useState('')
  const [joinCallsign, setJoinCallsign] = useState('')
  const [joinGunnery, setJoinGunnery] = useState(4)
  const [joinPiloting, setJoinPiloting] = useState(5)
  const [joinColor, setJoinColor] = useState(() => suggestPilotColor(pilots.length))
  const [joinChassis, setJoinChassis] = useState('')
  const [chassisOptions, setChassisOptions] = useState<string[]>([])
  const [joinModel, setJoinModel] = useState('')
  const [joinTonnage, setJoinTonnage] = useState(50)
  const [joinWalkMp, setJoinWalkMp] = useState(4)
  const [joinRunMp, setJoinRunMp] = useState(6)
  const [joinHeatSinks, setJoinHeatSinks] = useState(10)
  const [joinLocations, setJoinLocations] = useState(emptyLocationsForm())
  const [joinPendingWeapons, setJoinPendingWeapons] = useState<{ weapon_name: string; location: string }[]>([])
  const [joinPendingCriticals, setJoinPendingCriticals] = useState<Record<string, string[]>>({})
  const [weaponCatalog, setWeaponCatalog] = useState<Record<string, WeaponStats>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'ficha' | 'acciones'>('ficha')
  const [showFirstPerson, setShowFirstPerson] = useState(false)

  const refetch = async () => {
    if (campaignId == null) return
    const token = getDeviceToken()
    try {
      setPilots(await listPilots(campaignId, token))
      setMechs(await listMechs(campaignId, token))
      const all = await listCampaigns()
      setCampaign(all.find((c) => c.id === campaignId) ?? null)
      if (mapId != null) {
        setUnits(await getUnits(mapId))
        setVisible((await getVisibility(mapId)).visible)
      }
    } catch {
      setError('No se pudo conectar con el servidor.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    listMechChassis().then(setChassisOptions).catch(() => {})
  }, [])

  useEffect(() => {
    refetch()
    getWeaponCatalog().then(setWeaponCatalog).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, mapId, lastAttack, visibility])

  // Every resolved attack in the campaign, GM or any player's — see
  // GMView's identical fix for why (logging only from this client's own
  // submitWeaponVolley meant nobody else's shots ever showed up here).
  // Declared up here (using setLog directly, not the pushLog helper
  // defined further down) so this hook runs before this component's own
  // early returns below — a hook declared after them would be called
  // conditionally, which React doesn't allow.
  useEffect(() => {
    if (!lastAttack) return
    const targetChassis = mechs.find((m) => m.id === lastAttack.target_mech_id)?.chassis ?? `mech #${lastAttack.target_mech_id}`
    const line = lastAttack.hit
      ? `${lastAttack.weapon_name ?? 'Ataque'} → ${targetChassis}: impacto en ${lastAttack.location}${lastAttack.mech_destroyed ? ' — ¡DESTRUIDO!' : ''} (tirada ${lastAttack.roll})`
      : `${lastAttack.weapon_name ?? 'Ataque'} → ${targetChassis}: fallo (tirada ${lastAttack.roll} vs ${lastAttack.target_number})`
    setLog((l) => [line, ...l].slice(0, 8))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAttack])

  const importJoinMech = (data: MechImportData) => {
    setJoinChassis(data.chassis)
    setJoinModel(data.model)
    setJoinTonnage(data.tonnage)
    setJoinWalkMp(data.walk_mp)
    setJoinRunMp(data.run_mp)
    setJoinHeatSinks(data.heat_sinks)
    setJoinLocations(locationsFormFromMechLocationIn(data.locations))
    setJoinPendingWeapons(data.weapons)
    setJoinPendingCriticals(data.criticals)
  }

  // "Rellenar la ficha directamente" (ROADMAP.md Fase R3) — piloto y mech
  // se crean juntos, en estado pending con el token de este dispositivo,
  // a la espera de que el GM los apruebe o rechace (cada uno por
  // separado — ver la sección "Fichas pendientes" en /gm).
  const join = async () => {
    if (campaignId == null || !joinName || !joinChassis) return
    const token = getDeviceToken()
    try {
      const p = await createPilot(campaignId, {
        name: joinName,
        callsign: joinCallsign || undefined,
        gunnery: joinGunnery,
        piloting: joinPiloting,
        status: 'pending',
        owner_token: token,
        color: joinColor,
      })
      const m = await createMech(campaignId, {
        chassis: joinChassis,
        model: joinModel || undefined,
        tonnage: joinTonnage,
        walk_mp: joinWalkMp,
        run_mp: joinRunMp,
        heat_sinks: joinHeatSinks,
        pilot_id: p.id,
        locations: buildMechLocationsPayload(joinLocations),
        status: 'pending',
        owner_token: token,
        criticals: Object.keys(joinPendingCriticals).length > 0 ? joinPendingCriticals : undefined,
      })
      for (const w of joinPendingWeapons) {
        await addMechWeapon(m.id, w.weapon_name, w.location, token).catch(() => {})
      }
      // Without this, the URL switches to the new pilot but `pilots` state
      // hasn't caught up yet (the fetch effect doesn't depend on pilotId),
      // so the view briefly renders blank — found by auditing, not assumed.
      await refetch()
      choose(p.id)
    } catch {
      setError('No se pudo crear tu ficha. Inténtalo de nuevo.')
    }
  }

  if (campaignId == null) {
    return (
      <div className="player-view">
        <h1>Necesitas un enlace</h1>
        <p className="hint">Los jugadores no elegís campaña — pídele al GM el enlace de vuestra partida (incluye <code>?campaign=</code>).</p>
      </div>
    )
  }

  if (pilotId == null) {
    // Un jugador solo ve pilotos ya aprobados o los suyos propios — no
    // puede ver ni "robar" el borrador pendiente/rechazado de otro.
    const visiblePilots = pilots.filter((p) => p.status === 'approved' || p.is_own)
    return (
      <div className="player-view">
        <h1>¿Quién eres?</h1>
        {loading && <p className="loading">Cargando…</p>}
        {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}

        {visiblePilots.length > 0 && (
          <div className="pilot-picker">
            {visiblePilots.map((p) => (
              <button key={p.id} onClick={() => choose(p.id)}>
                {p.name} {p.callsign && `"${p.callsign}"`}
                {p.status !== 'approved' && <span className={`status-tag status-${p.status}`}>{p.status}</span>}
              </button>
            ))}
          </div>
        )}

        <section>
          <h2>Crear mi ficha</h2>
          <p className="hint">Rellénala como en la hoja de papel — el GM la revisará y la aprobará o te pedirá cambios.</p>
          <h3 className="step-label">Piloto</h3>
          <PilotForm
            name={joinName} onName={setJoinName}
            callsign={joinCallsign} onCallsign={setJoinCallsign}
            gunnery={joinGunnery} onGunnery={setJoinGunnery}
            piloting={joinPiloting} onPiloting={setJoinPiloting}
            color={joinColor} onColor={setJoinColor}
            onSubmit={join} submitLabel="Crear ficha" submitDisabled={!joinName || !joinChassis} hideSubmit
          />
          <h3 className="step-label">Mech</h3>
          <MechImportSelector onImport={importJoinMech} />
          <div className="row">
            <select value={joinChassis} onChange={(e) => setJoinChassis(e.target.value)}>
              <option value="">chasis…</option>
              {chassisOptions.map((c) => (
                <option key={c} value={c}>{MECH_CHASSIS_ASSETS[c] ? `🛠️ ${c}` : c}</option>
              ))}
            </select>
            <input placeholder="modelo" value={joinModel} onChange={(e) => setJoinModel(e.target.value)} />
            <label>ton <input type="number" value={joinTonnage} onChange={(e) => setJoinTonnage(Number(e.target.value))} style={{ width: 56 }} /></label>
            <label>walk <input type="number" value={joinWalkMp} onChange={(e) => setJoinWalkMp(Number(e.target.value))} style={{ width: 48 }} /></label>
            <label>run <input type="number" value={joinRunMp} onChange={(e) => setJoinRunMp(Number(e.target.value))} style={{ width: 48 }} /></label>
            <label>disipadores <input type="number" value={joinHeatSinks} onChange={(e) => setJoinHeatSinks(Number(e.target.value))} style={{ width: 48 }} /></label>
          </div>
          <MechLocationsGrid locations={joinLocations} onChange={setJoinLocations} />
          <h3 className="step-label">Vista previa de la hoja</h3>
          <MechRecordSheet
            mech={previewMechFromLocationsForm(joinChassis, joinModel, joinLocations, {
              tonnage: joinTonnage, walk_mp: joinWalkMp, run_mp: joinRunMp, jump_mp: 0,
            })}
            pilot={{ gunnery: joinGunnery, piloting: joinPiloting }}
            readOnly
            previewFullHealth
          />
          <button onClick={join} disabled={!joinName || !joinChassis}>Crear ficha</button>
        </section>
      </div>
    )
  }

  const pilot = pilots.find((p) => p.id === pilotId)
  const myMech = mechs.find((m) => m.pilot_id === pilotId)
  const myUnit = units.find((u) => u.pilot_id === pilotId)

  const visibleEnemies = units.filter(
    (u) => u.pilot_id !== pilotId && (visible[u.id] ?? []).includes(pilotId),
  )

  const mechForUnit = (u: Unit) => mechs.find((m) => m.id === u.mech_id) ?? null

  // Same "who's flying it" naming as the GM's mech cards (GMView.tsx's
  // mechCardName) — kept as its own small copy since it's the only thing
  // here that would otherwise justify importing GM-specific logic into
  // the player route.
  const targetCardName = (u: Unit) => {
    const mech = mechForUnit(u)
    if (!mech) return `unidad #${u.id}`
    const targetPilot = pilots.find((p) => p.id === u.pilot_id)
    const chassisModel = `${mech.chassis} ${mech.model ?? ''}`.trim()
    return targetPilot ? `${targetPilot.callsign || targetPilot.name} - ${chassisModel}` : chassisModel
  }

  const pushLog = (line: string) => setLog((l) => [line, ...l].slice(0, 8))

  const editPilotHits = async (value: number) => {
    if (!pilot) return
    await updatePilot(pilot.id, { hits: value }, getDeviceToken())
    refetch()
  }

  const editLocation = async (
    location: string,
    field: 'armor_current' | 'armor_rear_current' | 'structure_current',
    value: number,
  ) => {
    if (!myMech) return
    await updateMechLocation(myMech.id, location, { [field]: value }, getDeviceToken())
    refetch()
  }

  const toggleCritical = async (location: string, slotIndex: number, hit: boolean) => {
    if (!myMech) return
    await updateMechCritical(myMech.id, location, slotIndex, hit, getDeviceToken())
    refetch()
  }

  const resubmitMyPilot = async () => {
    if (!pilot) return
    try {
      await resubmitPilot(pilot.id, getDeviceToken())
      refetch()
    } catch {
      setError('No se pudo reenviar tu ficha de piloto.')
    }
  }

  const resubmitMyMech = async () => {
    if (!myMech) return
    try {
      await resubmitMech(myMech.id, getDeviceToken())
      refetch()
    } catch {
      setError('No se pudo reenviar tu mech.')
    }
  }

  const markMyActivation = async () => {
    if (!campaignId || !pilot) return
    try {
      await markRoundActed(campaignId, pilot.id)
    } catch {
      setError('No se pudo marcar tu activación.')
    }
  }

  // Doesn't roll anything here — asks the shared table (TableView) to
  // physically throw dice for this pilot; the round-indicator line below
  // already updates with the real result once it lands (roundState
  // arrives live over WS).
  const rollMyInitiative = async () => {
    if (!campaignId || !pilot) return
    try {
      await requestInitiative(campaignId, pilot.id)
    } catch {
      setError('No se pudo pedir la tirada de iniciativa.')
    }
  }

  const submitMovement = async (type: MovementType) => {
    if (!myUnit) return
    try {
      await requestMovement(myUnit.id, type)
    } catch {
      setError('No se pudo calcular el movimiento.')
    }
  }

  // Same sequential "fire every toggled weapon against this fixed
  // target" flow as GMView's own submitWeaponVolley — see its comment
  // for why sequential (heat/ammo ordering) and why one weapon failing
  // doesn't abort the rest. The hit/miss line itself isn't pushed here —
  // see the lastAttack effect below, same "log every broadcast, not just
  // the ones this client happened to fire" fix as GMView's own.
  const submitWeaponVolley = async (weaponIds: number[]) => {
    if (!campaignId || !myUnit || !selectedTarget) return
    setFiringVolley(true)
    for (const weaponId of weaponIds) {
      try {
        await attack(campaignId, {
          attacker_unit_id: myUnit.id,
          target_unit_id: selectedTarget.id,
          weapon_id: weaponId,
        })
      } catch {
        pushLog('Un arma no pudo disparar (fuera de alcance, sin munición o sin línea de visión).')
      }
    }
    if (pilot) await markRoundActed(campaignId, pilot.id).catch(() => {})
    setFiringVolley(false)
    setSelectedTarget(null)
    refetch()
  }

  return (
    <div className="player-view">
      <nav className="player-tabs">
        <button className={tab === 'ficha' ? 'active' : ''} onClick={() => setTab('ficha')}>
          <span className="nav-icon">📋</span><span className="nav-label">Ficha</span>
        </button>
        <button className={tab === 'acciones' ? 'active' : ''} onClick={() => setTab('acciones')}>
          <span className="nav-icon">⚔️</span><span className="nav-label">Acciones</span>
        </button>
        <span className="player-tabs-campaign">{campaign?.name ?? ''}</span>
      </nav>
      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}
      <h1>{pilot?.name} {pilot?.callsign && `"${pilot.callsign}"`}</h1>
      <p className="sub">Gunnery {pilot?.gunnery} · Piloting {pilot?.piloting}</p>

      {pilot && pilot.status === 'pending' && (
        <p className="sub status-banner status-pending">Tu ficha de piloto está pendiente de aprobación del GM.</p>
      )}
      {pilot && pilot.status === 'rejected' && (
        <p className="sub status-banner status-rejected">
          El GM rechazó tu ficha de piloto{pilot.review_note ? `: "${pilot.review_note}"` : ''}. Corrígela arriba y
          {' '}<button onClick={resubmitMyPilot}>reenviar</button>
        </p>
      )}

      {tab === 'ficha' && (
        <section>
          <h2>Mi mech</h2>
          {myMech ? (
            <>
              <MechRecordSheet
                mech={myMech}
                pilot={pilot}
                weaponCatalog={weaponCatalog}
                selectedWeaponId={weaponId === '' ? null : weaponId}
                onArmorChange={(loc, v) => editLocation(loc, 'armor_current', v)}
                onArmorRearChange={(loc, v) => editLocation(loc, 'armor_rear_current', v)}
                onStructureChange={(loc, v) => editLocation(loc, 'structure_current', v)}
                onSelectWeapon={setWeaponId}
                onPilotHitsChange={editPilotHits}
                onToggleCritical={toggleCritical}
              />
              {!myUnit && <p className="hint">Tu mech aún no está colocado en el mapa (pídeselo al GM).</p>}
              {myMech.status === 'pending' && (
                <p className="sub status-banner status-pending">Tu mech está pendiente de aprobación del GM.</p>
              )}
              {myMech.status === 'rejected' && (
                <p className="sub status-banner status-rejected">
                  El GM rechazó tu mech{myMech.review_note ? `: "${myMech.review_note}"` : ''}. Corrígelo y
                  {' '}<button onClick={resubmitMyMech}>reenviar</button>
                </p>
              )}
            </>
          ) : (
            <p className="hint">No tienes mech asignado todavía — pídeselo al GM en /gm.</p>
          )}
        </section>
      )}

      {tab === 'acciones' && (
        <>
      {roundState && roundState.round_number > 0 && (
        // roundState.mode (not campaign.initiative_mode) — roundState
        // already refreshes live over WS on every round event, while
        // `campaign` here is only fetched once on mount, so it can go
        // stale if the GM switches modes after this page already loaded.
        roundState.mode === 'individual' && pilot && !roundState.rolls.some((r) => r.pilot_id === pilot.id) ? (
          // Acting before rolling doesn't make sense in individual mode
          // (activeTurnPilotIds never treats an unrolled pilot as "their
          // turn" either) — show only the roll prompt, not the acted
          // line, so "ya actuaste" can never appear before you've rolled.
          <p className="sub round-indicator initiative-pending">
            La ronda ha comenzado, tira tu iniciativa
            <button className="act-button" onClick={rollMyInitiative}>Tirar iniciativa</button>
          </p>
        ) : (
          <p className="sub round-indicator">
            Ronda {roundState.round_number} — {formatRolls(roundState.rolls)}
            {pilot && roundState.acted_pilot_ids.includes(pilot.id) ? (
              <span className="acted-tag"> · ya actuaste</span>
            ) : (
              <button className="act-button" onClick={markMyActivation}>Terminé mi activación</button>
            )}
          </p>
        )
      )}
      <section>
        <h2>Vista del mech</h2>
        {myUnit ? (
          <button className="act-button" onClick={() => setShowFirstPerson(true)}>Vista en 1ª persona</button>
        ) : (
          <p className="hint">Tu mech aún no está colocado en el mapa.</p>
        )}
      </section>

      {roundState && myUnit && pilot && activeMoverPilotId(roundState) === pilot.id && (
        // Fase de movimiento (requested directly) — se activa sola en
        // cuanto todos han tirado iniciativa, empezando por quien menos
        // sacó (rounds.ts's activeMoverPilotId). PlayerView no tiene mapa
        // propio — elegir un tipo aquí pide al servidor que difunda las
        // casillas alcanzables (api.ts's requestMovement), y es la Vista
        // de Mesa la que pinta el resaltado y captura el click de
        // confirmación (mismo reparto que la tirada de iniciativa).
        <section>
          <h2>Movimiento</h2>
          <p className="hint">Es tu turno de moverte — elige cómo, y confirma en la Vista de Mesa.</p>
          <div className="row">
            <button className="act-button" onClick={() => submitMovement('walk')}>Caminar</button>
            <button className="act-button" onClick={() => submitMovement('run')}>Correr</button>
            {(myMech?.jump_mp ?? 0) > 0 && (
              <button className="act-button" onClick={() => submitMovement('jump')}>Saltar</button>
            )}
          </div>
        </section>
      )}

      <section>
        <h2>Objetivos a la vista</h2>
        {visibleEnemies.length === 0 && <p className="hint">No ves ningún enemigo ahora mismo.</p>}
        {visibleEnemies.length > 0 && (
          <div className="card-list">
            {visibleEnemies.map((u) => (
              <div key={u.id} className="entity-card" onClick={() => setSelectedTarget(u)}>
                <span className="entity-card-name">{targetCardName(u)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {log.length > 0 && (
        <section>
          <h2>Registro</h2>
          <ul className="log">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </section>
      )}
        </>
      )}

      {selectedTarget && myUnit && myMech && (
        <WeaponVolleyPanel
          attackerMech={myMech}
          target={selectedTarget}
          targetMech={mechForUnit(selectedTarget)}
          weaponCatalog={weaponCatalog}
          firing={firingVolley}
          onFire={submitWeaponVolley}
          onClose={() => setSelectedTarget(null)}
        />
      )}

      {showFirstPerson && myUnit && (
        <FirstPersonView
          unit={myUnit}
          mech={myMech ?? null}
          units={units}
          roundState={roundState}
          visibility={visibility}
          onClose={() => setShowFirstPerson(false)}
        />
      )}
    </div>
  )
}
