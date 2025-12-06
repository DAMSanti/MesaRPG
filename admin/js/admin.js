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

// Token selection state
let tokenLibrary = null;
let selectedTokenSheetId = null;
let selectedTokenId = null;
let currentTokenCategory = 'system';

// DOM Ready
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initTokenCategoryTabs();
    loadGameSystems();
    loadTokenLibrary();
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
            const tabContent = document.getElementById(tabId);
            if (tabContent) {
                tabContent.classList.add('active');
            }
            
            // Inicializar editor de mapas cuando se selecciona esa pestaña
            if (tab.dataset.tab === 'maps') {
                if (typeof initMapEditor === 'function') {
                    initMapEditor();
                }
            }
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
            updateGameState(data.payload || data.state || data);
            break;
        case 'stats':
            if (data.payload) updateConnectionCounts(data.payload);
            break;
        case 'connection_counts':
            updateConnectionCounts(data.counts || data.payload);
            break;
        case 'sheet_submitted':
        case 'sheet_pending':
        case 'sheet_created':
            loadPendingSheets();
            const sheetData = data.sheet || data.payload?.sheet || data.payload;
            const sheetName = sheetData?.character_name || sheetData?.data?.name || sheetData?.player_name || 'Desconocido';
            logAction('Ficha', `Nueva ficha recibida: ${sheetName}`);
            break;
        case 'sheet_approved':
            loadPendingSheets();
            loadApprovedSheets();
            logAction('Ficha', `Ficha aprobada: ${data.sheet?.character_name || data.payload?.sheet?.character_name || data.payload?.character_name || 'Desconocido'}`);
            break;
        case 'token_assigned':
            loadApprovedSheets();
            loadAvailableMarkers();
            loadCharacters();
            const tokenSheet = data.sheet || data.payload?.sheet;
            logAction('Token', `Token #${data.marker_id || data.payload?.marker_id} asignado a ${tokenSheet?.character_name || 'Personaje'}`);
            break;
        case 'character_added':
            loadCharacters();
            logAction('Personaje', `${data.character?.name || data.payload?.name || 'Personaje'} añadido a la partida`);
            break;
        case 'character_moved':
            logAction('Movimiento', `${data.character_id} se movió a (${data.x}, ${data.y})`);
            break;
        case 'player_joined':
            logAction('Jugador', `Nuevo jugador conectado`);
            break;
        case 'map_changed':
            logAction('Mapa', `Mapa actualizado`);
            break;
        case 'game_system_changed':
            const sysId = data.payload?.system_id;
            if (sysId) {
                currentSystemId = sysId;
                document.getElementById('system-select').value = sysId;
                logAction('Sistema', `Sistema cambiado a ${sysId}`);
            }
            break;
        case 'error':
            const errorMsg = data.payload?.message || data.payload?.error || data.message || 'Error desconocido';
            console.error('Server error:', errorMsg);
            logAction('Error', errorMsg);
            break;
        case 'pong':
            // Response to ping - connection alive
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
            
            // Bloquear el selector si ya hay un sistema seleccionado
            const system = gameSystems.find(s => s.id === currentSystemId);
            if (system) {
                lockGameSystemSelector(system);
            }
            
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
            
            // Bloquear el selector y mostrar el botón de cambio
            lockGameSystemSelector(system);
            
            loadPendingSheets();
            loadApprovedSheets();
            loadAvailableMarkers();
            
            // Actualizar galería de tokens para el nuevo sistema
            renderTokenGallery();
            renderSheetsForToken();
            
            // Recargar editor de mapas con los tiles del nuevo sistema
            if (typeof reloadMapEditor === 'function') {
                reloadMapEditor();
            }
        } else {
            alert('Error al cambiar el sistema de juego');
        }
    } catch (error) {
        console.error('Error setting game system:', error);
    }
}

// Bloquear el selector de sistema de juego
function lockGameSystemSelector(system) {
    const select = document.getElementById('system-select');
    const displaySpan = document.getElementById('current-system-display');
    const changeBtn = document.getElementById('btn-change-system');
    
    // Ocultar selector y mostrar display + botón
    select.style.display = 'none';
    displaySpan.style.display = 'inline-block';
    displaySpan.textContent = system ? `${system.icon || '🎮'} ${system.name}` : currentSystemId;
    changeBtn.style.display = 'inline-block';
}

// Desbloquear el selector de sistema de juego
function unlockGameSystemSelector() {
    const select = document.getElementById('system-select');
    const displaySpan = document.getElementById('current-system-display');
    const changeBtn = document.getElementById('btn-change-system');
    
    // Mostrar selector y ocultar display + botón
    select.style.display = 'inline-block';
    select.value = '';
    displaySpan.style.display = 'none';
    changeBtn.style.display = 'none';
    
    currentSystemId = null;
}

// Confirmar cambio de sistema de juego
function confirmChangeSystem() {
    const confirmed = confirm('⚠️ ¿Estás seguro de que quieres cambiar el sistema de juego?\n\nEsto puede afectar a los personajes y configuración actual.');
    
    if (confirmed) {
        unlockGameSystemSelector();
        logAction('Sistema', 'Selector de sistema desbloqueado');
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
        renderAssignedTokens();
        renderSheetsForToken();
        renderTokenGallery();
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

// ==================== Token Assignment (Visual) ====================

// Load token library from JSON
async function loadTokenLibrary() {
    try {
        const response = await fetch('/assets/markers/tokens.json');
        tokenLibrary = await response.json();
        console.log('Token library loaded:', tokenLibrary);
        // Renderizar galería después de cargar
        renderTokenGallery();
    } catch (error) {
        console.error('Error loading token library:', error);
        // Fallback con tokens genéricos
        tokenLibrary = {
            dnd: [],
            battletech: [],
            generic: [
                { id: 'player1', name: 'Player 1', number: 1, file: 'generic/player1.svg' },
                { id: 'player2', name: 'Player 2', number: 2, file: 'generic/player2.svg' },
                { id: 'player3', name: 'Player 3', number: 3, file: 'generic/player3.svg' },
                { id: 'player4', name: 'Player 4', number: 4, file: 'generic/player4.svg' }
            ]
        };
        renderTokenGallery();
    }
}

// Initialize token category tabs
function initTokenCategoryTabs() {
    document.querySelectorAll('.token-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.token-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentTokenCategory = tab.dataset.category;
            renderTokenGallery();
        });
    });
}

// Render sheets available for token assignment
function renderSheetsForToken() {
    const container = document.getElementById('sheets-for-token');
    if (!container) return;
    
    const unassigned = approvedSheets.filter(s => !s.marker_id);
    
    if (unassigned.length === 0) {
        container.innerHTML = '<p class="empty-state">Todas las fichas tienen token asignado</p>';
        return;
    }
    
    container.innerHTML = unassigned.map(sheet => `
        <div class="sheet-option ${selectedTokenSheetId === sheet.id ? 'selected' : ''}" 
             onclick="selectSheetForToken('${sheet.id}')">
            <div class="sheet-avatar">${escapeHtml(sheet.character_name.charAt(0).toUpperCase())}</div>
            <div class="sheet-info">
                <div class="sheet-name">${escapeHtml(sheet.character_name)}</div>
                <div class="sheet-player">${escapeHtml(sheet.player_name)}</div>
            </div>
        </div>
    `).join('');
}

// Select a sheet for token assignment
function selectSheetForToken(sheetId) {
    selectedTokenSheetId = sheetId;
    renderSheetsForToken();
    updateAssignButtonState();
}

// Render token gallery based on current system and category
function renderTokenGallery() {
    const container = document.getElementById('token-gallery');
    if (!container) return;
    
    // Si tokenLibrary no está cargado aún, mostrar mensaje
    if (!tokenLibrary) {
        container.innerHTML = '<p class="empty-state">Cargando tokens...</p>';
        return;
    }
    
    let tokens = [];
    
    if (currentTokenCategory === 'system') {
        // Get tokens based on current game system
        const systemId = currentSystemId || 'dnd5e';
        console.log('Rendering tokens for system:', systemId);
        
        if (systemId.includes('battletech')) {
            tokens = tokenLibrary.battletech || [];
        } else {
            tokens = tokenLibrary.dnd || [];
        }
    } else if (currentTokenCategory === 'generic') {
        tokens = tokenLibrary.generic || [];
    }
    
    // Obtener tokens ya asignados
    const assignedTokens = approvedSheets
        .filter(s => s.token_visual)
        .map(s => s.token_visual);
    
    if (tokens.length === 0) {
        container.innerHTML = '<p class="empty-state">No hay tokens disponibles</p>';
        return;
    }
    
    container.innerHTML = tokens.map(token => {
        const isSelected = selectedTokenId === token.id;
        const isAssigned = assignedTokens.includes(token.id);
        const weightBadge = token.tonnage ? getWeightBadge(token.tonnage) : '';
        
        if (isAssigned) {
            return `
                <div class="token-option assigned" title="${token.name} - Ya asignado">
                    ${weightBadge}
                    <img class="token-image" src="/assets/markers/${token.file}" alt="${token.name}">
                    <span class="token-label">${token.name}</span>
                    <span class="assigned-badge">✓</span>
                </div>
            `;
        }
        
        return `
            <div class="token-option ${isSelected ? 'selected' : ''}" 
                 onclick="selectToken('${token.id}')"
                 title="${token.name}${token.tonnage ? ` (${token.tonnage}T)` : ''}">
                ${weightBadge}
                <img class="token-image" src="/assets/markers/${token.file}" alt="${token.name}">
                <span class="token-label">${token.name}</span>
            </div>
        `;
    }).join('');
}

// Get weight class badge HTML for BattleTech mechs
function getWeightBadge(tonnage) {
    if (tonnage <= 35) {
        return '<span class="weight-badge light">L</span>';
    } else if (tonnage <= 55) {
        return '<span class="weight-badge medium">M</span>';
    } else if (tonnage <= 75) {
        return '<span class="weight-badge heavy">H</span>';
    } else {
        return '<span class="weight-badge assault">A</span>';
    }
}

// Select a token
function selectToken(tokenId) {
    selectedTokenId = tokenId;
    renderTokenGallery();
    updateAssignButtonState();
}

// Update assign button state
function updateAssignButtonState() {
    const btn = document.getElementById('assign-token-btn');
    if (!btn) return;
    
    // Solo necesitamos ficha y token seleccionados
    const isValid = selectedTokenSheetId && selectedTokenId;
    btn.disabled = !isValid;
}

// Assign token visually
async function assignTokenVisual() {
    if (!selectedTokenSheetId || !selectedTokenId) {
        alert('Selecciona una ficha y un token');
        return;
    }
    
    // Generar un ID único basado en el token visual (sin ArUco)
    const markerId = Date.now() % 10000;  // ID numérico simple
    
    try {
        const response = await fetch(`/api/sheets/${selectedTokenSheetId}/assign-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                marker_id: markerId,
                token_visual: selectedTokenId
            })
        });
        
        if (response.ok) {
            loadApprovedSheets();
            loadCharacters();
            logAction('Token', `Token ${selectedTokenId} asignado`);
            
            // Reset selections
            selectedTokenSheetId = null;
            selectedTokenId = null;
            renderSheetsForToken();
            renderTokenGallery();
            updateAssignButtonState();
        } else {
            const error = await response.json();
            alert(error.detail || 'Error al asignar token');
        }
    } catch (error) {
        console.error('Error assigning token:', error);
    }
}

// Legacy function for compatibility
async function loadAvailableMarkers() {
    // No longer uses select, but keep for any other code that calls it
}

function updateSheetForTokenSelect() {
    // Replaced by renderSheetsForToken
    renderSheetsForToken();
}

function renderAssignedTokens() {
    const container = document.getElementById('assigned-tokens');
    if (!container) return;
    
    const assigned = approvedSheets.filter(s => s.marker_id || s.token_visual);
    
    if (assigned.length === 0) {
        container.innerHTML = '<p class="empty-state">No hay tokens asignados</p>';
        return;
    }
    
    container.innerHTML = assigned.map(sheet => {
        // Determine token image path
        let tokenImagePath = '/assets/markers/generic/player1.svg'; // default
        let tokenName = 'Token';
        
        if (sheet.token_visual && tokenLibrary) {
            // Find the token in library
            const allTokens = [
                ...(tokenLibrary.dnd || []),
                ...(tokenLibrary.battletech || []),
                ...(tokenLibrary.generic || [])
            ];
            const token = allTokens.find(t => t.id === sheet.token_visual);
            if (token) {
                tokenImagePath = `/assets/markers/${token.file}`;
                tokenName = token.name;
            }
        }
        
        return `
            <div class="assigned-token-card">
                <div class="token-header">
                    <img class="token-visual" src="${tokenImagePath}" alt="Token">
                    <div class="token-details">
                        <div class="character-name">${escapeHtml(sheet.character_name)}</div>
                        <div class="player-name">${escapeHtml(sheet.player_name)}</div>
                    </div>
                    <span class="token-type-badge">${tokenName}</span>
                </div>
                <div class="token-footer">
                    <button class="btn btn-danger btn-sm" onclick="removeToken('${sheet.id}')">
                        ❌ Quitar
                    </button>
                </div>
            </div>
        `;
    }).join('');
    
    // Also update the sheets for token list
    renderSheetsForToken();
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
        const data = await response.json();
        // API returns object {id: character}, convert to array
        characters = Array.isArray(data) ? data : Object.values(data || {});
        renderCharacters();
    } catch (error) {
        console.error('Error loading characters:', error);
    }
}

function renderCharacters() {
    const container = document.getElementById('active-characters');
    if (!container) return;
    
    if (!characters || characters.length === 0) {
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
    if (!state) return;
    
    const sysId = state.game_system_id || state.game_system;
    if (sysId && sysId !== currentSystemId) {
        currentSystemId = sysId;
        const select = document.getElementById('system-select');
        if (select) select.value = currentSystemId;
    }
    
    // Update combat state
    if (state.is_combat || state.combat_active) {
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
    document.getElementById('display-count').textContent = counts.displays || counts.display || 0;
    document.getElementById('mobile-count').textContent = counts.mobiles || counts.mobile || 0;
    document.getElementById('camera-status').textContent = counts.camera ? '✓' : '❌';
    
    // Update player list
    const playerList = document.getElementById('player-list');
    const players = counts.mobile_players || counts.players || [];
    if (players && players.length > 0) {
        playerList.innerHTML = players.map(p => `<div>${escapeHtml(p)}</div>`).join('');
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
