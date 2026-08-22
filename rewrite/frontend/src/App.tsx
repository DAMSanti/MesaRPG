import { Routes, Route } from 'react-router-dom'
import { TableView } from './routes/TableView'
import { RollerView } from './routes/RollerView'
import { GMView } from './routes/GMView'
import { PlayerView } from './routes/PlayerView'
import { CampaignsView } from './routes/CampaignsView'
import { MapEditorView } from './routes/MapEditorView'
import { HubView } from './routes/HubView'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<TableView />} />
      <Route path="/roll" element={<RollerView />} />
      <Route path="/gm" element={<GMView />} />
      <Route path="/player" element={<PlayerView />} />
      <Route path="/campaigns" element={<CampaignsView />} />
      <Route path="/mapeditor" element={<MapEditorView />} />
      <Route path="/hub" element={<HubView />} />
    </Routes>
  )
}
