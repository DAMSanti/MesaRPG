import { useState } from 'react'
import {
  abilityModifier, createDndCharacter, dndAttack, markDndRoundActed, startDndRound,
  type DndAttackResult, type DndCharacter, type DndRoundState,
} from '../api'
import './DndCharacterSheet.css'

const ABILITY_LABELS: { key: keyof Pick<DndCharacter, 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'>; label: string }[] = [
  { key: 'str', label: 'FUE' },
  { key: 'dex', label: 'DES' },
  { key: 'con', label: 'CON' },
  { key: 'int', label: 'INT' },
  { key: 'wis', label: 'SAB' },
  { key: 'cha', label: 'CAR' },
]

const modLabel = (score: number) => {
  const mod = abilityModifier(score)
  return mod >= 0 ? `+${mod}` : `${mod}`
}

/** D&D 5e GM panel (ROADMAP.md Fase R4 — slice mínimo): crear personajes,
 * ver su ficha (puntuaciones, CA, PG), tirar iniciativa, y resolver un
 * ataque genérico. Deliberadamente plano/funcional, no una réplica de
 * MechRecordSheet.tsx — la ficha D&D de esta pasada no tiene ni de lejos
 * la superficie de una hoja de mech real (sin inventario de armas, sin
 * localizaciones, sin críticos). */
export function DndCharacterSheet({
  campaignId, characters, selectedCharacterId, onSelectCharacter, onCharacterCreated,
}: {
  campaignId: number
  characters: DndCharacter[]
  selectedCharacterId: number | null
  onSelectCharacter: (id: number) => void
  onCharacterCreated: (character: DndCharacter) => void
}) {
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({
    name: '', str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, ac: 10, hp_max: 10, proficiency_bonus: 2,
  })
  const [targetId, setTargetId] = useState<number | null>(null)
  const [attackMod, setAttackMod] = useState(0)
  const [damageDice, setDamageDice] = useState('1d6')
  const [lastResult, setLastResult] = useState<DndAttackResult | null>(null)
  const [round, setRound] = useState<DndRoundState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submitCreate = async () => {
    if (!form.name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const created = await createDndCharacter(campaignId, form)
      onCharacterCreated(created)
      setForm({ name: '', str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, ac: 10, hp_max: 10, proficiency_bonus: 2 })
      setShowCreate(false)
    } catch {
      setError('No se pudo crear el personaje.')
    } finally {
      setBusy(false)
    }
  }

  const submitAttack = async () => {
    if (selectedCharacterId == null || targetId == null) return
    setBusy(true)
    setError(null)
    try {
      const result = await dndAttack(campaignId, {
        attacker_id: selectedCharacterId, target_id: targetId, attack_mod: attackMod, damage_dice: damageDice,
      })
      setLastResult(result)
    } catch {
      setError('No se pudo resolver el ataque — revisa la notación de dados.')
    } finally {
      setBusy(false)
    }
  }

  const rollInitiative = async () => {
    setBusy(true)
    setError(null)
    try {
      setRound(await startDndRound(campaignId))
    } catch {
      setError('No se pudo tirar iniciativa.')
    } finally {
      setBusy(false)
    }
  }

  const markActed = async (characterId: number) => {
    try {
      setRound(await markDndRoundActed(campaignId, characterId))
    } catch {
      setError('No se pudo marcar la actuación.')
    }
  }

  return (
    <div className="dnd-panel">
      <div>
        <h3>Personajes</h3>
        <div className="dnd-char-list">
          {characters.map((c) => (
            <div
              key={c.id}
              className={`dnd-char-card${selectedCharacterId === c.id ? ' selected' : ''}`}
              onClick={() => onSelectCharacter(c.id)}
            >
              <div className="name-row">
                <span>{c.name}</span>
                <span>CA {c.ac} · PG {c.hp_current}/{c.hp_max}</span>
              </div>
              <div className="dnd-hp-bar">
                <div className="dnd-hp-bar-fill" style={{ width: `${Math.max(0, (c.hp_current / c.hp_max) * 100)}%` }} />
              </div>
              <div className="dnd-abilities">
                {ABILITY_LABELS.map(({ key, label }) => (
                  <span key={key}>{label} {c[key]} ({modLabel(c[key])})</span>
                ))}
              </div>
            </div>
          ))}
          {characters.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Sin personajes todavía.</p>}
        </div>
        <button type="button" className="secondary" style={{ marginTop: 8 }} onClick={() => setShowCreate((s) => !s)}>
          {showCreate ? 'Cancelar' : '+ Nuevo personaje'}
        </button>
      </div>

      {showCreate && (
        <div>
          <h3>Crear personaje</h3>
          <div className="dnd-form-grid">
            <label style={{ gridColumn: 'span 3' }}>
              Nombre
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            {ABILITY_LABELS.map(({ key, label }) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })}
                />
              </label>
            ))}
            <label>
              CA
              <input type="number" value={form.ac} onChange={(e) => setForm({ ...form, ac: Number(e.target.value) })} />
            </label>
            <label>
              PG máx.
              <input type="number" value={form.hp_max} onChange={(e) => setForm({ ...form, hp_max: Number(e.target.value) })} />
            </label>
            <label>
              Bonif. competencia
              <input
                type="number"
                value={form.proficiency_bonus}
                onChange={(e) => setForm({ ...form, proficiency_bonus: Number(e.target.value) })}
              />
            </label>
          </div>
          <button type="button" disabled={busy || !form.name.trim()} onClick={submitCreate} style={{ marginTop: 8 }}>
            Crear
          </button>
        </div>
      )}

      <div>
        <h3>Iniciativa {round ? `— ronda ${round.round_number}` : ''}</h3>
        <button type="button" onClick={rollInitiative} disabled={busy || characters.length === 0}>
          Tirar iniciativa (ronda nueva)
        </button>
        {round && round.rolls.length > 0 && (
          <ul className="dnd-initiative-list" style={{ marginTop: 8 }}>
            {round.rolls.map((r) => (
              <li key={r.character_id} className={round.acted_character_ids.includes(r.character_id) ? 'acted' : ''}>
                <span>{r.name} — {r.roll}</span>
                {!round.acted_character_ids.includes(r.character_id) && (
                  <button type="button" className="secondary" onClick={() => markActed(r.character_id)}>
                    Actuó
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3>Ataque genérico</h3>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
          Atacante: {characters.find((c) => c.id === selectedCharacterId)?.name ?? 'ninguno seleccionado'}
        </p>
        <div className="dnd-form-grid">
          <label>
            Objetivo
            <select value={targetId ?? ''} onChange={(e) => setTargetId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">—</option>
              {characters.filter((c) => c.id !== selectedCharacterId).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label>
            Mod. ataque
            <input type="number" value={attackMod} onChange={(e) => setAttackMod(Number(e.target.value))} />
          </label>
          <label>
            Dados de daño
            <input value={damageDice} onChange={(e) => setDamageDice(e.target.value)} placeholder="1d8+3" />
          </label>
        </div>
        <button
          type="button"
          style={{ marginTop: 8 }}
          disabled={busy || selectedCharacterId == null || targetId == null}
          onClick={submitAttack}
        >
          Atacar
        </button>
        {lastResult && (
          <div className={`dnd-attack-result ${lastResult.hit ? 'hit' : 'miss'}`} style={{ marginTop: 8 }}>
            Tirada {lastResult.roll} + {lastResult.attack_mod} = {lastResult.total} —{' '}
            {lastResult.hit ? `¡impacto! ${lastResult.damage} de daño` : 'fallo'}
          </div>
        )}
      </div>

      {error && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>}
    </div>
  )
}
