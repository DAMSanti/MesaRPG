// MesaRPG Admin Panel JavaScript

// State
let ws = null;
let gameSystems = [];
let currentSystemId = null;
let pendingSheets = [];
let approvedSheets = [];
let characters = [];
let availableMarkers = [];
let selectedSheetId = null;

// DOM Ready
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    loadGameSystems();
    connectWebSocket();
});

// ==================== Tab Navigation ====================
function initTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            // Remove active from all tabs
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            // Activate clicked tab
            tab.classList.add('active');
            const tabId = `tab-${tab.dataset.tab}`;
            document.getElementById(tabId).classList.add('active');
        });
    });
}

// ==================== WebSocket ====================
function connectWebSocket() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws/admin`;
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('WebSocket connected');
        updateConnectionStatus(true);
        logAction('Sistema', 'Conectado al servidor');
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleMessage(data);
    };
    
    ws.onclose = () => {
        console.log('WebSocket disconnected');
        updateConnectionStatus(false);
        logAction('Sistema', 'Desconectado del servidor');
        // Reconnect after 3 seconds
        setTimeout(connectWebSocket, 3000);
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
}

function updateConnectionStatus(connected) {
    const status = document.getElementById('connection-status');
    if (connected) {
        status.textContent = 'Conectado';
        status.className = 'connected';
    } else {
        status.textContent = 'Desconectado';
        status.className = 'disconnected';
    }
}

function handleMessage(data) {
    console.log('Received:', data);
    
    switch (data.type) {
        case 'state_update':
            updateGameState(data.state);
            break;
        case 'connection_counts':
            updateConnectionCounts(data.counts);
            break;
        case 'sheet_submitted':
            loadPendingSheets();
            logAction('Ficha', `Nueva ficha recibida: ${data.sheet.character_name}`);
            break;
        case 'sheet_approved':
            loadPendingSheets();
            loadApprovedSheets();
            logAction('Ficha', `Ficha aprobada: ${data.sheet.character_name}`);
            break;
        case 'character_added':
            loadCharacters();
            logAction('Personaje', `${data.character.name} añadido a la partida`);
            break;
        case 'character_moved':
            logAction('Movimiento', `${data.character_id} se movió a (${data.x}, ${data.y})`);
            break;
        default:
            console.log('Unknown message type:', data.type);
    }
}

// ==================== Game Systems ====================
async function loadGameSystems() {
    try {
        const response = await fetch('/api/systems');
        const data = await response.json();
        gameSystems = data.systems || data;  // Handle both {"systems": [...]} and [...] formats
        
        const select = document.getElementById('system-select');
        select.innerHTML = '<option value="">Selecciona un sistema...</option>';
        
        gameSystems.forEach(system => {
            const option = document.createElement('option');
            option.value = system.id;
            option.textContent = system.name;
            select.appendChild(option);
        });
        
        // Check if there's a current system
        const stateResponse = await fetch('/api/state');
        const state = await stateResponse.json();
        
        if (state.game_system_id) {
            currentSystemId = state.game_system_id;
            select.value = currentSystemId;
            loadPendingSheets();
            loadApprovedSheets();
            loadCharacters();
        }
    } catch (error) {
        console.error('Error loading game systems:', error);
        logAction('Error', 'No se pudieron cargar los sistemas de juego');
    }
}

async function setGameSystem(systemId) {
    if (!systemId) return;
    
    try {
        const response = await fetch(`/api/systems/set/${systemId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.ok) {
            currentSystemId = systemId;
            const system = gameSystems.find(s => s.id === systemId);
            logAction('Sistema', `Sistema de juego cambiado a: ${system?.name || systemId}`);
            loadPendingSheets();
            loadApprovedSheets();
            loadAvailableMarkers();
        } else {
            alert('Error al cambiar el sistema de juego');
        }
    } catch (error) {
        console.error('Error setting game system:', error);
    }
}

// ==================== Sheets ====================
async function loadPendingSheets() {
    try {
        const response = await fetch('/api/sheets?status=pending');
        pendingSheets = await response.json();
        renderPendingSheets();
    } catch (error) {
        console.error('Error loading pending sheets:', error);
    }
}

async function loadApprovedSheets() {
    try {
        const response = await fetch('/api/sheets?status=approved');
        approvedSheets = await response.json();
        renderApprovedSheets();
        updateSheetForTokenSelect();
    } catch (error) {
        console.error('Error loading approved sheets:', error);
    }
}

function renderPendingSheets() {
    const container = document.getElementById('pending-sheets');
    
    if (pendingSheets.length === 0) {
        container.innerHTML = '<p class="empty-state">No hay fichas pendientes</p>';
        return;
    }
    
    container.innerHTML = pendingSheets.map(sheet => `
        <div class="sheet-item" onclick="viewSheet('${sheet.id}')">
            <div class="sheet-info">
                <div class="sheet-name">${escapeHtml(sheet.character_name)}</div>
                <div class="sheet-player">Jugador: ${escapeHtml(sheet.player_name)}</div>
                <div class="sheet-time">${formatTime(sheet.submitted_at)}</div>
            </div>
            <div class="sheet-actions">
                <button class="btn btn-success btn-sm" onclick="event.stopPropagation(); approveSheet('${sheet.id}')">✓ Aprobar</button>
                <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); rejectSheet('${sheet.id}')">✗ Rechazar</button>
            </div>
        </div>
    `).join('');
}

function renderApprovedSheets() {
    const container = document.getElementById('approved-sheets');
    
    if (approvedSheets.length === 0) {
        container.innerHTML = '<p class="empty-state">No hay fichas aprobadas</p>';
        return;
    }
    
    container.innerHTML = approvedSheets.map(sheet => `
        <div class="sheet-item" onclick="viewSheet('${sheet.id}')">
            <div class="sheet-info">
                <div class="sheet-name">${escapeHtml(sheet.character_name)}</div>
                <div class="sheet-player">Jugador: ${escapeHtml(sheet.player_name)}</div>
                ${sheet.marker_id ? `<div class="sheet-time">Token: #${sheet.marker_id}</div>` : '<div class="sheet-time">Sin token asignado</div>'}
            </div>
            <div class="sheet-actions">
                <button class="btn btn-sm" onclick="event.stopPropagation(); viewSheet('${sheet.id}')">👁 Ver</button>
            </div>
        </div>
    `).join('');
}

async function viewSheet(sheetId) {
    try {
        const response = await fetch(`/api/sheets/${sheetId}`);
        const sheet = await response.json();
        
        selectedSheetId = sheetId;
        
        // Get system template for field labels
        const system = gameSystems.find(s => s.id === sheet.system_id);
        const template = system?.character_template || [];
        
        // Build modal content
        const modalTitle = document.getElementById('sheet-modal-title');
        modalTitle.textContent = `${sheet.character_name} - ${sheet.player_name}`;
        
        const modalBody = document.getElementById('sheet-modal-body');
        modalBody.innerHTML = `
            <div class="sheet-fields">
                ${template.map(field => {
                    const value = sheet.data[field.id] || '-';
                    return `
                        <div class="sheet-field ${field.type === 'textarea' ? 'full-width' : ''}">
                            <div class="field-label">${escapeHtml(field.name)}</div>
                            <div class="field-value">${escapeHtml(String(value))}</div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
        
        // Setup footer buttons based on status
        const modalFooter = document.getElementById('sheet-modal-footer');
        if (sheet.status === 'pending') {
            modalFooter.innerHTML = `
                <button class="btn btn-danger" onclick="rejectSheet('${sheetId}'); closeSheetModal();">Rechazar</button>
                <button class="btn btn-success" onclick="approveSheet('${sheetId}'); closeSheetModal();">Aprobar</button>
            `;
        } else {
            modalFooter.innerHTML = `
                <button class="btn" onclick="closeSheetModal()">Cerrar</button>
            `;
        }
        
        document.getElementById('sheet-modal').classList.remove('hidden');
    } catch (error) {
        console.error('Error loading sheet:', error);
        alert('Error al cargar la ficha');
    }
}

function closeSheetModal() {
    document.getElementById('sheet-modal').classList.add('hidden');
    selectedSheetId = null;
}

async function approveSheet(sheetId) {
    try {
        const response = await fetch(`/api/sheets/${sheetId}/approve`, {
            method: 'POST'
        });
        
        if (response.ok) {
            loadPendingSheets();
            loadApprovedSheets();
            logAction('Ficha', 'Ficha aprobada');
        } else {
            alert('Error al aprobar la ficha');
        }
    } catch (error) {
        console.error('Error approving sheet:', error);
    }
}

async function rejectSheet(sheetId) {
    const reason = prompt('Motivo del rechazo (opcional):');
    
    try {
        const response = await fetch(`/api/sheets/${sheetId}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason || 'Ficha rechazada por el administrador' })
        });
        
        if (response.ok) {
            loadPendingSheets();
            logAction('Ficha', 'Ficha rechazada');
        } else {
            alert('Error al rechazar la ficha');
        }
    } catch (error) {
        console.error('Error rejecting sheet:', error);
    }
}

// ==================== Token Assignment ====================
async function loadAvailableMarkers() {
    try {
        const response = await fetch('/api/markers/available');
        availableMarkers = await response.json();
        
        const select = document.getElementById('marker-select');
        select.innerHTML = '<option value="">Selecciona un marcador</option>';
        
        availableMarkers.forEach(marker => {
            const option = document.createElement('option');
            option.value = marker.id;
            option.textContent = `Marcador #${marker.id}`;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Error loading markers:', error);
        // Fallback: create markers 1-50
        const select = document.getElementById('marker-select');
        select.innerHTML = '<option value="">Selecciona un marcador</option>';
        for (let i = 1; i <= 50; i++) {
            const option = document.createElement('option');
            option.value = i;
            option.textContent = `Marcador #${i}`;
            select.appendChild(option);
        }
    }
}

function updateSheetForTokenSelect() {
    const select = document.getElementById('sheet-for-token');
    select.innerHTML = '<option value="">Selecciona una ficha aprobada</option>';
    
    // Only show approved sheets without assigned tokens
    const unassigned = approvedSheets.filter(s => !s.marker_id);
    
    unassigned.forEach(sheet => {
        const option = document.createElement('option');
        option.value = sheet.id;
        option.textContent = `${sheet.character_name} (${sheet.player_name})`;
        select.appendChild(option);
    });
}

async function assignToken() {
    const sheetId = document.getElementById('sheet-for-token').value;
    const markerId = document.getElementById('marker-select').value;
    
    if (!sheetId || !markerId) {
        alert('Selecciona una ficha y un marcador');
        return;
    }
    
    try {
        const response = await fetch(`/api/sheets/${sheetId}/assign-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ marker_id: parseInt(markerId) })
        });
        
        if (response.ok) {
            loadApprovedSheets();
            loadCharacters();
            loadAvailableMarkers();
            logAction('Token', `Token #${markerId} asignado`);
            
            // Reset selects
            document.getElementById('sheet-for-token').value = '';
            document.getElementById('marker-select').value = '';
        } else {
            const error = await response.json();
            alert(error.detail || 'Error al asignar token');
        }
    } catch (error) {
        console.error('Error assigning token:', error);
    }
}

function renderAssignedTokens() {
    const container = document.getElementById('assigned-tokens');
    const assigned = approvedSheets.filter(s => s.marker_id);
    
    if (assigned.length === 0) {
        container.innerHTML = '<p class="empty-state">No hay tokens asignados</p>';
        return;
    }
    
    container.innerHTML = assigned.map(sheet => `
        <div class="token-item">
            <div class="character-info">
                <div class="token-marker">${sheet.marker_id}</div>
                <div>
                    <div class="character-name">${escapeHtml(sheet.character_name)}</div>
                    <div class="character-player">${escapeHtml(sheet.player_name)}</div>
                </div>
            </div>
            <button class="btn btn-danger btn-sm" onclick="removeToken('${sheet.id}')">Quitar</button>
        </div>
    `).join('');
}

async function removeToken(sheetId) {
    if (!confirm('¿Quitar token de este personaje?')) return;
    
    try {
        const response = await fetch(`/api/sheets/${sheetId}/remove-token`, {
            method: 'POST'
        });
        
        if (response.ok) {
            loadApprovedSheets();
            loadAvailableMarkers();
            logAction('Token', 'Token removido');
        }
    } catch (error) {
        console.error('Error removing token:', error);
    }
}

// ==================== Characters ====================
async function loadCharacters() {
    try {
        const response = await fetch('/api/characters');
        characters = await response.json();
        renderCharacters();
    } catch (error) {
        console.error('Error loading characters:', error);
    }
}

function renderCharacters() {
    const container = document.getElementById('active-characters');
    
    if (characters.length === 0) {
        container.innerHTML = '<p class="empty-state">No hay personajes en juego</p>';
        return;
    }
    
    container.innerHTML = characters.map(char => `
        <div class="character-item">
            <div class="character-info">
                <div class="character-token">${char.marker_id || '?'}</div>
                <div>
                    <div class="character-name">${escapeHtml(char.name)}</div>
                    <div class="character-player">Token #${char.marker_id || 'N/A'}</div>
                </div>
            </div>
            <div class="character-stats">
                <span class="stat health">❤ ${char.hp || char.current_hp || '?'}/${char.max_hp || '?'}</span>
            </div>
        </div>
    `).join('');
}

// ==================== Combat ====================
function startCombat() {
    sendCommand({ action: 'start_combat' });
    logAction('Combate', 'Combate iniciado');
}

function endCombat() {
    sendCommand({ action: 'end_combat' });
    logAction('Combate', 'Combate finalizado');
}

function nextTurn() {
    sendCommand({ action: 'next_turn' });
}

function sendCommand(command) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(command));
    } else {
        console.error('WebSocket not connected');
    }
}

// ==================== Debug Tools ====================
async function addTestCharacter() {
    const name = prompt('Nombre del personaje:');
    if (!name) return;
    
    try {
        const response = await fetch('/api/characters', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: name,
                marker_id: Math.floor(Math.random() * 50) + 1,
                max_hp: 100,
                current_hp: 100
            })
        });
        
        if (response.ok) {
            loadCharacters();
            logAction('Debug', `Personaje test "${name}" añadido`);
        }
    } catch (error) {
        console.error('Error adding test character:', error);
    }
}

async function clearCharacters() {
    if (!confirm('¿Eliminar todos los personajes?')) return;
    
    try {
        const response = await fetch('/api/characters/clear', {
            method: 'POST'
        });
        
        if (response.ok) {
            loadCharacters();
            logAction('Debug', 'Personajes eliminados');
        }
    } catch (error) {
        console.error('Error clearing characters:', error);
    }
}

// ==================== State Updates ====================
function updateGameState(state) {
    if (state.game_system_id && state.game_system_id !== currentSystemId) {
        currentSystemId = state.game_system_id;
        document.getElementById('system-select').value = currentSystemId;
    }
    
    // Update combat state
    if (state.combat_active) {
        document.getElementById('combat-state').textContent = 'En combate';
        document.getElementById('current-turn').textContent = state.current_turn || 1;
        document.getElementById('active-character').textContent = state.active_character || '-';
    } else {
        document.getElementById('combat-state').textContent = 'Fuera de combate';
        document.getElementById('current-turn').textContent = '-';
        document.getElementById('active-character').textContent = '-';
    }
}

function updateConnectionCounts(counts) {
    document.getElementById('display-count').textContent = counts.display || 0;
    document.getElementById('mobile-count').textContent = counts.mobile || 0;
    document.getElementById('camera-status').textContent = counts.camera ? '✓' : '❌';
    
    // Update player list
    const playerList = document.getElementById('player-list');
    if (counts.players && counts.players.length > 0) {
        playerList.innerHTML = counts.players.map(p => `<div>${escapeHtml(p)}</div>`).join('');
    } else {
        playerList.textContent = 'Ninguno';
    }
}

// ==================== Utilities ====================
function logAction(category, message) {
    const log = document.getElementById('action-log');
    const time = new Date().toLocaleTimeString();
    
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `<span class="log-time">[${time}]</span> <strong>${category}:</strong> ${escapeHtml(message)}`;
    
    log.insertBefore(entry, log.firstChild);
    
    // Keep only last 50 entries
    while (log.children.length > 50) {
        log.removeChild(log.lastChild);
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    return date.toLocaleString();
}

// Load markers on page load after systems are ready
setTimeout(() => {
    loadAvailableMarkers();
}, 1000);
