import { useEffect, useRef, useState } from 'react'
import { getMechImport, searchMechImport, type MechImportData, type MechImportResult } from '../api'
import './MechImportSelector.css'

interface Props {
  onImport: (data: MechImportData) => void
}

/** Search the public MegaMek-format unit database (ROADMAP.md Fase R3 —
 * requested directly by the user, replaces a small hand-curated
 * catalog) and load a real mech's stats straight into the creation
 * form — chassis, movement, armor/structure per location, weapons —
 * still editable before submitting, same as everything else here. */
export function MechImportSelector({ onImport }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MechImportResult[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (query.trim().length < 2) {
      setResults([])
      return
    }
    debounceRef.current = setTimeout(() => {
      searchMechImport(query)
        .then((r) => { setResults(r); setOpen(true) })
        .catch(() => setError('No se pudo buscar — ¿sin conexión con la base de datos pública?'))
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query])

  const pick = async (result: MechImportResult) => {
    setLoading(true)
    setOpen(false)
    try {
      const data = await getMechImport(result.file)
      onImport(data)
      setQuery(result.name)
    } catch {
      setError('No se pudo importar ese mech.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mech-import-selector">
      <input
        placeholder="Buscar mech real (p.ej. Atlas, Warhammer)…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
      />
      {loading && <span className="hint">Importando…</span>}
      {error && <span className="hint error">{error}</span>}
      {open && results.length > 0 && (
        <ul className="mech-import-results">
          {results.map((r) => (
            <li key={r.file}>
              <button type="button" onClick={() => pick(r)}>{r.name}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
