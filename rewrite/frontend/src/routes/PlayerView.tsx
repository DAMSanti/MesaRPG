import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useCampaignId } from '../useCampaignId'
import { useMapId } from '../useMapId'
import { useTableSocket } from '../ws'
import { PilotForm } from '../components/PilotForm'
import { PinPrompt } from '../components/PinPrompt'
import { Modal } from '../components/Modal'
import { MechRecordSheet } from '../components/MechRecordSheet'
import { FirstPersonView } from '../components/FirstPersonView'
import { FacingPicker } from '../components/FacingPicker'
import { buildMechLocationsPayload, emptyLocationsForm, locationsFormFromMechLocationIn } from '../characterSheet'
import { getDeviceToken } from '../deviceToken'
import {
  addMechEquipment,
  addMechWeapon,
  createMech,
  createPilot,
  deleteMech,
  getMechImport,
  getUnits,
  getWeaponCatalog,
  listCampaigns,
  listMechChassis,
  listMechModels,
  listMechs,
  listPilots,
  markRoundActed,
  moveUnit,
  requestMovement,
  resubmitPilot,
  requestInitiative,
  updateMechCritical,
  updateMechLocation,
  updatePilot,
  type Campaign,
  type Mech,
  type MechImportData,
  type MechModelResult,
  type MovementType,
  type Pilot,
  type Unit,
  type WeaponStats,
} from '../api'
import { activeAttackPilotIds, activeMoverPilotId, currentPhase, PHASE_LABELS } from '../rounds'
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
  const { lastAttack, activeMapId, roundState, visibility, rosterVersion } = useTableSocket(campaignId)
  const mapId = useMapId(campaignId, activeMapId)

  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [pilots, setPilots] = useState<Pilot[]>([])
  const [mechs, setMechs] = useState<Mech[]>([])
  const [units, setUnits] = useState<Unit[]>([])
  const [log, setLog] = useState<string[]>([])
  const [weaponId, setWeaponId] = useState<number | ''>('')
  // "¿Quién eres?" starts in 'pick' mode (list of existing pilots + a
  // "crear nuevo" button) — the pilot/mech creation form (below) only
  // shows once the player explicitly asks for it, instead of always
  // being visible alongside the picker (real user request: quitar esa
  // sección de la pantalla inicial). pendingPilot is which pilot from
  // the list is currently waiting on a correct PIN before `choose()`
  // actually runs — see PinPrompt.tsx's own doc comment for why this
  // asks every time rather than remembering a device.
  const [joinMode, setJoinMode] = useState<'pick' | 'create'>('pick')
  const [pendingPilot, setPendingPilot] = useState<Pilot | null>(null)
  const [joinPin, setJoinPin] = useState('')
  const [joinName, setJoinName] = useState('')
  const [joinCallsign, setJoinCallsign] = useState('')
  const [joinGunnery, setJoinGunnery] = useState(4)
  const [joinPiloting, setJoinPiloting] = useState(5)
  const [joinColor, setJoinColor] = useState(() => suggestPilotColor(pilots.length))
  // Chassis → model, same two cascading dropdowns as GMView's own "Nuevo
  // mech" modal (real user request: "copia la forma de hacerlo de GM
  // view") — tonnage/movement/armor/structure all come from the picked
  // model file, never typed by hand here.
  const [joinChassis, setJoinChassis] = useState('')
  const [chassisOptions, setChassisOptions] = useState<string[]>([])
  const [joinModel, setJoinModel] = useState('')
  const [joinModelOptions, setJoinModelOptions] = useState<MechModelResult[]>([])
  const [joinSelectedModelFile, setJoinSelectedModelFile] = useState('')
  const [joinTonnage, setJoinTonnage] = useState(50)
  const [joinWalkMp, setJoinWalkMp] = useState(4)
  const [joinRunMp, setJoinRunMp] = useState(6)
  const [joinHeatSinks, setJoinHeatSinks] = useState(10)
  const [joinLocations, setJoinLocations] = useState(emptyLocationsForm())
  const [joinPendingWeapons, setJoinPendingWeapons] = useState<{ weapon_name: string; location: string }[]>([])
  const [joinPendingEquipment, setJoinPendingEquipment] = useState<{ equipment_name: string; location: string }[]>([])
  const [joinPendingCriticals, setJoinPendingCriticals] = useState<Record<string, string[]>>({})

  // ---- editing a REJECTED pilot/mech — only reachable from the
  // rejection banner below, and resubmitting only ever happens as part
  // of saving this edit (real user request: "solo cuando se edita se
  // puede reenviar"), never as a bare "reenviar" button. ----
  const [editingRejectedPilot, setEditingRejectedPilot] = useState(false)
  const [editPilotName, setEditPilotName] = useState('')
  const [editPilotCallsign, setEditPilotCallsign] = useState('')
  const [editPilotGunnery, setEditPilotGunnery] = useState(4)
  const [editPilotPiloting, setEditPilotPiloting] = useState(5)
  const [editPilotColor, setEditPilotColor] = useState('')

  // Same chassis→model cascade as the create flow — a rejected mech is
  // always still 'pending'-eligible, never placed on a map (GM approval
  // required first), so replacing it outright (delete + recreate with
  // the freshly picked model's real stats) is safe and correct — a
  // PATCH could only ever change chassis/model/tonnage/mp/heat_sinks,
  // never armor/structure/weapons, which would leave the OLD mech's
  // loadout stuck on a newly picked chassis.
  const [editingRejectedMech, setEditingRejectedMech] = useState(false)
  const [editMechChassis, setEditMechChassis] = useState('')
  const [editMechModel, setEditMechModel] = useState('')
  const [editMechModelOptions, setEditMechModelOptions] = useState<MechModelResult[]>([])
  const [editMechSelectedModelFile, setEditMechSelectedModelFile] = useState('')
  const [editMechTonnage, setEditMechTonnage] = useState(50)
  const [editMechWalkMp, setEditMechWalkMp] = useState(4)
  const [editMechRunMp, setEditMechRunMp] = useState(6)
  const [editMechHeatSinks, setEditMechHeatSinks] = useState(10)
  const [editMechLocations, setEditMechLocations] = useState(emptyLocationsForm())
  const [editMechPendingWeapons, setEditMechPendingWeapons] = useState<{ weapon_name: string; location: string }[]>([])
  const [editMechPendingEquipment, setEditMechPendingEquipment] = useState<{ equipment_name: string; location: string }[]>([])
  const [editMechPendingCriticals, setEditMechPendingCriticals] = useState<Record<string, string[]>>({})

  const [weaponCatalog, setWeaponCatalog] = useState<Record<string, WeaponStats>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'ficha' | 'acciones'>('ficha')
  const [showFirstPerson, setShowFirstPerson] = useState(false)
  const [showRotatePicker, setShowRotatePicker] = useState(false)

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
    if (!joinChassis) {
      setJoinModelOptions([])
      return
    }
    listMechModels(joinChassis).then(setJoinModelOptions).catch(() => setJoinModelOptions([]))
    setJoinSelectedModelFile('')
  }, [joinChassis])

  useEffect(() => {
    if (!joinSelectedModelFile) return
    getMechImport(joinSelectedModelFile).then(importJoinMech).catch(() => setError('No se pudo cargar ese modelo del catálogo.'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinSelectedModelFile])

  useEffect(() => {
    if (!editMechChassis) {
      setEditMechModelOptions([])
      return
    }
    listMechModels(editMechChassis).then(setEditMechModelOptions).catch(() => setEditMechModelOptions([]))
    setEditMechSelectedModelFile('')
  }, [editMechChassis])

  useEffect(() => {
    if (!editMechSelectedModelFile) return
    getMechImport(editMechSelectedModelFile).then(importEditMech).catch(() => setError('No se pudo cargar ese modelo del catálogo.'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMechSelectedModelFile])

  useEffect(() => {
    refetch()
    getWeaponCatalog().then(setWeaponCatalog).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, mapId, lastAttack, visibility, rosterVersion])

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
    setJoinPendingEquipment(data.equipment)
    setJoinPendingCriticals(data.criticals)
  }

  const importEditMech = (data: MechImportData) => {
    setEditMechChassis(data.chassis)
    setEditMechModel(data.model)
    setEditMechTonnage(data.tonnage)
    setEditMechWalkMp(data.walk_mp)
    setEditMechRunMp(data.run_mp)
    setEditMechHeatSinks(data.heat_sinks)
    setEditMechLocations(locationsFormFromMechLocationIn(data.locations))
    setEditMechPendingWeapons(data.weapons)
    setEditMechPendingEquipment(data.equipment)
    setEditMechPendingCriticals(data.criticals)
  }

  // "Rellenar la ficha directamente" (ROADMAP.md Fase R3) — piloto y mech
  // se crean juntos, en estado pending con el token de este dispositivo,
  // a la espera de que el GM los apruebe o rechace (cada uno por
  // separado — ver la sección "Fichas pendientes" en /gm).
  const join = async () => {
    if (campaignId == null || !joinName || !joinChassis || joinPin.length !== 4) return
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
        pin: joinPin,
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
      for (const eq of joinPendingEquipment) {
        await addMechEquipment(m.id, eq.equipment_name, eq.location, token).catch(() => {})
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
    // puede ver ni "robar" el borrador pendiente/rechazado de otro. Y
    // solo de facción 'player' — los mechs enemigos/NPC son del GM, no
    // seleccionables como propios (real user request).
    const visiblePilots = pilots.filter(
      (p) => (p.status === 'approved' || p.is_own) && p.faction === 'player',
    )
    // Cada jugador (cada dispositivo) solo puede tener un piloto propio
    // — el backend ya lo impide (pilots.py's DuplicateOwnerPilot), esto
    // solo evita ofrecer el botón cuando ya no tiene sentido.
    const hasOwnPilot = pilots.some((p) => p.is_own)

    const pickPilot = (p: Pilot) => {
      if (p.has_pin) setPendingPilot(p)
      else choose(p.id)
    }

    return (
      <div className="player-view">
        <h1>¿Quién eres?</h1>
        {loading && <p className="loading">Cargando…</p>}
        {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}

        {pendingPilot && (
          <PinPrompt
            pilotId={pendingPilot.id}
            pilotName={pendingPilot.name}
            onSuccess={() => {
              choose(pendingPilot.id)
              setPendingPilot(null)
            }}
            onCancel={() => setPendingPilot(null)}
          />
        )}

        {visiblePilots.length > 0 ? (
          <div className="pilot-picker">
            {visiblePilots.map((p) => (
              <button key={p.id} onClick={() => pickPilot(p)}>
                {p.name} {p.callsign && `"${p.callsign}"`}
                {p.has_pin && ' 🔒'}
                {p.status !== 'approved' && <span className={`status-tag status-${p.status}`}>{p.status}</span>}
              </button>
            ))}
          </div>
        ) : (
          !loading && <p className="hint">Todavía no hay personajes en esta partida — crea el tuyo.</p>
        )}
        {!hasOwnPilot && (
          <button onClick={() => setJoinMode('create')}>+ Crear nuevo personaje</button>
        )}

        {joinMode === 'create' && (
          <Modal title="Crear mi ficha" onClose={() => setJoinMode('pick')}>
            <p className="hint">El GM la revisará y la aprobará o te pedirá cambios.</p>
            <h3 className="step-label">Piloto</h3>
            <PilotForm
              name={joinName} onName={setJoinName}
              callsign={joinCallsign} onCallsign={setJoinCallsign}
              gunnery={joinGunnery} onGunnery={setJoinGunnery}
              piloting={joinPiloting} onPiloting={setJoinPiloting}
              color={joinColor} onColor={setJoinColor}
              pin={joinPin} onPin={setJoinPin}
              onSubmit={join} submitLabel="Crear ficha" submitDisabled={!joinName || !joinChassis || joinPin.length !== 4} hideSubmit
            />
            <h3 className="step-label">Mech</h3>
            <div className="row">
              <select value={joinChassis} onChange={(e) => setJoinChassis(e.target.value)}>
                <option value="">chasis…</option>
                {chassisOptions.map((c) => (
                  <option key={c} value={c}>{MECH_CHASSIS_ASSETS[c] ? `🛠️ ${c}` : c}</option>
                ))}
              </select>
              <select
                value={joinSelectedModelFile}
                onChange={(e) => setJoinSelectedModelFile(e.target.value)}
                disabled={joinModelOptions.length === 0}
              >
                <option value="">modelo…</option>
                {joinModelOptions.map((m) => (
                  <option key={m.file} value={m.file}>
                    {MECH_CHASSIS_ASSETS[joinChassis]?.models[m.model] ? `🛠️ ${m.model}` : m.model}
                  </option>
                ))}
              </select>
            </div>
            <button onClick={join} disabled={!joinName || !joinChassis || joinPin.length !== 4}>Crear ficha</button>
          </Modal>
        )}
      </div>
    )
  }

  const pilot = pilots.find((p) => p.id === pilotId)
  const myMech = mechs.find((m) => m.pilot_id === pilotId)
  const myUnit = units.find((u) => u.pilot_id === pilotId)
  // "Acciones" (movimiento, ataque, iniciativa…) no tiene sentido hasta
  // que el GM haya aceptado tanto al piloto como al mech — real user
  // request.
  const canAct = pilot?.status === 'approved' && myMech?.status === 'approved'

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

  const openEditRejectedPilot = () => {
    if (!pilot) return
    setEditPilotName(pilot.name)
    setEditPilotCallsign(pilot.callsign ?? '')
    setEditPilotGunnery(pilot.gunnery)
    setEditPilotPiloting(pilot.piloting)
    setEditPilotColor(pilot.color)
    setEditingRejectedPilot(true)
  }

  const submitEditRejectedPilot = async () => {
    if (!pilot || !editPilotName) return
    const token = getDeviceToken()
    try {
      await updatePilot(pilot.id, {
        name: editPilotName,
        callsign: editPilotCallsign || undefined,
        gunnery: editPilotGunnery,
        piloting: editPilotPiloting,
        color: editPilotColor,
      }, token)
      await resubmitPilot(pilot.id, token)
      setEditingRejectedPilot(false)
      refetch()
    } catch {
      setError('No se pudo reenviar tu ficha de piloto.')
    }
  }

  const openEditRejectedMech = () => {
    setEditMechChassis('')
    setEditMechModelOptions([])
    setEditMechSelectedModelFile('')
    setEditingRejectedMech(true)
  }

  // Delete + recreate rather than PATCH — see the state declarations'
  // own comment on why a rejected mech is always safe to replace
  // outright instead of editing in place.
  const submitEditRejectedMech = async () => {
    if (!myMech || !pilot || !editMechChassis) return
    const token = getDeviceToken()
    try {
      await deleteMech(myMech.id)
      const m = await createMech(campaignId!, {
        chassis: editMechChassis,
        model: editMechModel || undefined,
        tonnage: editMechTonnage,
        walk_mp: editMechWalkMp,
        run_mp: editMechRunMp,
        heat_sinks: editMechHeatSinks,
        pilot_id: pilot.id,
        locations: buildMechLocationsPayload(editMechLocations),
        status: 'pending',
        owner_token: token,
        criticals: Object.keys(editMechPendingCriticals).length > 0 ? editMechPendingCriticals : undefined,
      })
      for (const w of editMechPendingWeapons) {
        await addMechWeapon(m.id, w.weapon_name, w.location, token).catch(() => {})
      }
      for (const eq of editMechPendingEquipment) {
        await addMechEquipment(m.id, eq.equipment_name, eq.location, token).catch(() => {})
      }
      setEditingRejectedMech(false)
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

  // Same "record a 0-hex move" backend path as GMView's own Cambiar
  // dirección/Saltar movimiento (main.py's /move endpoint already
  // counts a same-position reposition as this round's move — see its
  // own comment) — no map of its own needed here, unlike Caminar/
  // Correr/Saltar above, since staying in place needs no highlight/
  // confirm-on-table round trip at all.
  const submitRotate = async (facingDeg: number) => {
    setShowRotatePicker(false)
    if (!myUnit) return
    try {
      await moveUnit(myUnit.id, myUnit.q, myUnit.r, facingDeg)
      refetch()
    } catch {
      setError('No se pudo cambiar de dirección.')
    }
  }

  const submitSkipMovement = async () => {
    if (!myUnit) return
    try {
      await moveUnit(myUnit.id, myUnit.q, myUnit.r)
      refetch()
    } catch {
      setError('No se pudo saltar el movimiento.')
    }
  }

  return (
    <div className="player-view">
      <nav className="player-tabs">
        <button className={tab === 'ficha' ? 'active' : ''} onClick={() => setTab('ficha')}>
          <span className="nav-icon">📋</span><span className="nav-label">Ficha</span>
        </button>
        {canAct && (
          <button className={tab === 'acciones' ? 'active' : ''} onClick={() => setTab('acciones')}>
            <span className="nav-icon">⚔️</span><span className="nav-label">Acciones</span>
          </button>
        )}
        <span className="player-tabs-campaign">{campaign?.name ?? ''}</span>
      </nav>
      {error && <div className="error-banner">{error} <button onClick={() => setError(null)}>×</button></div>}
      <h1>
        {pilot?.name} {pilot?.callsign && `"${pilot.callsign}"`}
        <button
          className="icon-button eye-button"
          onClick={() => setShowFirstPerson(true)}
          disabled={!myUnit}
          title={myUnit ? 'Vista en 1ª persona' : 'Tu mech aún no está colocado en el mapa'}
        >
          👁️
        </button>
      </h1>
      <p className="sub">Gunnery {pilot?.gunnery} · Piloting {pilot?.piloting}</p>

      {pilot && pilot.status === 'pending' && (
        <p className="sub status-banner status-pending">Tu ficha de piloto está pendiente de aprobación del GM.</p>
      )}
      {pilot && pilot.status === 'rejected' && (
        <p className="sub status-banner status-rejected">
          El GM rechazó tu ficha de piloto{pilot.review_note ? `: "${pilot.review_note}"` : ''}.
          {' '}<button onClick={openEditRejectedPilot}>Editar</button>
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
                  El GM rechazó tu mech{myMech.review_note ? `: "${myMech.review_note}"` : ''}.
                  {' '}<button onClick={openEditRejectedMech}>Editar</button>
                </p>
              )}
            </>
          ) : (
            <p className="hint">No tienes mech asignado todavía — pídeselo al GM en /gm.</p>
          )}
        </section>
      )}

      {tab === 'acciones' && canAct && (
        <>
      {/* Visor de fase — real user request: ronda + fase claras arriba,
          y debajo cada acción posible con su propio control, atenuada
          cuando no toca ahora mismo en vez de aparecer/desaparecer sin
          más contexto. roundState.mode (not campaign.initiative_mode) —
          roundState already refreshes live over WS on every round event,
          while `campaign` here is only fetched once on mount, so it can
          go stale if the GM switches modes after this page already loaded. */}
      <section className="phase-panel">
        <div className="phase-header">
          <span className="phase-round">
            Ronda {roundState && roundState.round_number > 0 ? roundState.round_number : '—'}
          </span>
          <span className="phase-name">{PHASE_LABELS[roundState ? currentPhase(roundState) : 'none']}</span>
        </div>
        <ul className="phase-actions">
          {roundState && roundState.mode === 'individual' && (() => {
            const hasRolled = pilot ? roundState.rolls.some((r) => r.pilot_id === pilot.id) : false
            const canRoll = roundState.round_number > 0 && !hasRolled
            return (
              <li className={canRoll ? '' : 'phase-action-disabled'}>
                <span className="phase-action-label">{hasRolled ? '✓ Iniciativa tirada' : 'Tirar iniciativa'}</span>
                <button className="icon-button" onClick={rollMyInitiative} disabled={!canRoll} title="Tirar iniciativa">🎲</button>
              </li>
            )
          })()}
          {(() => {
            const isMyMoveTurn = !!(roundState && myUnit && pilot && activeMoverPilotId(roundState) === pilot.id)
            return (
              <li className={isMyMoveTurn ? '' : 'phase-action-disabled'}>
                <span className="phase-action-label">Moverse</span>
                <div className="row">
                  <button onClick={() => submitMovement('walk')} disabled={!isMyMoveTurn}>Caminar</button>
                  <button onClick={() => submitMovement('run')} disabled={!isMyMoveTurn}>Correr</button>
                  {(myMech?.jump_mp ?? 0) > 0 && (
                    <button onClick={() => submitMovement('jump')} disabled={!isMyMoveTurn}>Saltar</button>
                  )}
                  <button onClick={() => setShowRotatePicker(true)} disabled={!isMyMoveTurn}>Cambiar dirección</button>
                  <button onClick={submitSkipMovement} disabled={!isMyMoveTurn}>Saltar movimiento</button>
                </div>
              </li>
            )
          })()}
          {(() => {
            const canAttackNow = !!(roundState && pilot && activeAttackPilotIds(roundState).has(pilot.id))
            return (
              <li className={canAttackNow ? '' : 'phase-action-disabled'}>
                <span className="phase-action-label">Atacar</span>
                <button onClick={() => setShowFirstPerson(true)} disabled={!canAttackNow || !myUnit}>🎯 Ver y atacar</button>
              </li>
            )
          })()}
          {(() => {
            const hasActed = !!(roundState && pilot && roundState.acted_pilot_ids.includes(pilot.id))
            const canEndActivation = !!(roundState && roundState.round_number > 0 && !hasActed)
            return (
              <li className={canEndActivation ? '' : 'phase-action-disabled'}>
                <span className="phase-action-label">{hasActed ? '✓ Ya actuaste' : 'Terminar activación'}</span>
                <button onClick={markMyActivation} disabled={!canEndActivation}>Terminé mi activación</button>
              </li>
            )
          })()}
        </ul>
      </section>

      {log.length > 0 && (
        <section>
          <h2>Registro</h2>
          <ul className="log">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </section>
      )}
        </>
      )}

      {showFirstPerson && myUnit && (
        <FirstPersonView
          unit={myUnit}
          mech={myMech ?? null}
          units={units}
          roundState={roundState}
          visibility={visibility}
          lastAttack={lastAttack}
          onClose={() => setShowFirstPerson(false)}
        />
      )}

      {showRotatePicker && (
        <FacingPicker
          x={window.innerWidth / 2}
          y={window.innerHeight / 2}
          onPick={submitRotate}
          onDismiss={() => setShowRotatePicker(false)}
        />
      )}

      {editingRejectedPilot && (
        <Modal title="Editar mi piloto" onClose={() => setEditingRejectedPilot(false)}>
          <PilotForm
            name={editPilotName} onName={setEditPilotName}
            callsign={editPilotCallsign} onCallsign={setEditPilotCallsign}
            gunnery={editPilotGunnery} onGunnery={setEditPilotGunnery}
            piloting={editPilotPiloting} onPiloting={setEditPilotPiloting}
            color={editPilotColor} onColor={setEditPilotColor}
            onSubmit={submitEditRejectedPilot} submitLabel="Guardar y reenviar" submitDisabled={!editPilotName}
          />
        </Modal>
      )}

      {editingRejectedMech && (
        <Modal title="Editar mi mech" onClose={() => setEditingRejectedMech(false)}>
          <div className="row">
            <select value={editMechChassis} onChange={(e) => setEditMechChassis(e.target.value)}>
              <option value="">chasis…</option>
              {chassisOptions.map((c) => (
                <option key={c} value={c}>{MECH_CHASSIS_ASSETS[c] ? `🛠️ ${c}` : c}</option>
              ))}
            </select>
            <select
              value={editMechSelectedModelFile}
              onChange={(e) => setEditMechSelectedModelFile(e.target.value)}
              disabled={editMechModelOptions.length === 0}
            >
              <option value="">modelo…</option>
              {editMechModelOptions.map((m) => (
                <option key={m.file} value={m.file}>
                  {MECH_CHASSIS_ASSETS[editMechChassis]?.models[m.model] ? `🛠️ ${m.model}` : m.model}
                </option>
              ))}
            </select>
          </div>
          <button onClick={submitEditRejectedMech} disabled={!editMechChassis}>Guardar y reenviar</button>
        </Modal>
      )}
    </div>
  )
}
