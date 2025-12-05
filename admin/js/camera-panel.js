/**
 * MesaRPG - Camera Panel Controller
 * Gestiona la interfaz del panel de cámara en el admin
 */

class CameraPanel {
    constructor() {
        this.status = null;
        this.selectedMiniature = null;
        this.streamInterval = null;
        this.isStreaming = false;
        
        // Referencias a elementos DOM
        this.elements = {
            cameraSelect: document.getElementById('camera-select'),
            cameraUrl: document.getElementById('camera-url'),
            cameraFeed: document.getElementById('camera-feed'),
            cameraOverlay: document.getElementById('camera-overlay'),
            cameraState: document.getElementById('camera-state'),
            cameraResolution: document.getElementById('camera-resolution'),
            cameraFps: document.getElementById('camera-fps'),
            cameraCalibrated: document.getElementById('camera-calibrated'),
            miniaturesCount: document.getElementById('miniatures-count'),
            miniaturesGrid: document.getElementById('miniatures-grid'),
            unassignedMiniatures: document.getElementById('unassigned-miniatures'),
            currentAssignments: document.getElementById('current-assignments'),
            gameAreaWidth: document.getElementById('game-area-width'),
            gameAreaHeight: document.getElementById('game-area-height'),
            assignPlayerId: document.getElementById('assign-player-id'),
            assignPlayerName: document.getElementById('assign-player-name'),
            assignCharacterName: document.getElementById('assign-character-name'),
            
            // Botones
            btnConnect: document.getElementById('btn-connect-camera'),
            btnDisconnect: document.getElementById('btn-disconnect-camera'),
            btnStartStream: document.getElementById('btn-start-stream'),
            btnStopStream: document.getElementById('btn-stop-stream'),
            btnCaptureFrame: document.getElementById('btn-capture-frame'),
            btnAssignMiniature: document.getElementById('btn-assign-miniature')
        };
        
        this.init();
    }
    
    async init() {
        console.log('📷 Inicializando panel de cámara...');
        
        // Cargar dispositivos disponibles
        await this.loadCameraDevices();
        
        // Cargar estado actual
        await this.refreshStatus();
        
        // Configurar actualización periódica
        setInterval(() => this.refreshStatus(), 5000);
    }
    
    // === Gestión de dispositivos ===
    
    async loadCameraDevices() {
        try {
            const response = await fetch('/api/camera/devices');
            const data = await response.json();
            
            this.elements.cameraSelect.innerHTML = '<option value="">Seleccionar cámara...</option>';
            
            data.cameras.forEach(camera => {
                const option = document.createElement('option');
                option.value = camera.id;
                option.textContent = `${camera.name} (${camera.width}x${camera.height})`;
                this.elements.cameraSelect.appendChild(option);
            });
            
            if (data.cameras.length === 0) {
                const option = document.createElement('option');
                option.value = "0";
                option.textContent = "Cámara 0 (por defecto)";
                this.elements.cameraSelect.appendChild(option);
            }
        } catch (error) {
            console.error('Error cargando dispositivos:', error);
        }
    }
    
    // === Conexión ===
    
    async connect() {
        const cameraId = parseInt(this.elements.cameraSelect.value) || 0;
        const cameraUrl = this.elements.cameraUrl.value.trim() || null;
        
        try {
            this.elements.btnConnect.disabled = true;
            this.elements.btnConnect.textContent = 'Conectando...';
            
            const response = await fetch('/api/camera/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    camera_id: cameraId,
                    camera_url: cameraUrl 
                })
            });
            
            if (response.ok) {
                const data = await response.json();
                this.updateStatus(data.camera);
                this.showNotification('📷 Cámara conectada', 'success');
            } else {
                const error = await response.json();
                this.showNotification(`Error: ${error.detail}`, 'error');
            }
        } catch (error) {
            console.error('Error conectando:', error);
            this.showNotification('Error de conexión', 'error');
        } finally {
            this.elements.btnConnect.textContent = 'Conectar';
            this.refreshStatus();
        }
    }
    
    async disconnect() {
        try {
            await fetch('/api/camera/disconnect', { method: 'POST' });
            this.showNotification('📷 Cámara desconectada', 'info');
            this.stopFramePolling();
            this.hideFrame();
        } catch (error) {
            console.error('Error desconectando:', error);
        } finally {
            this.refreshStatus();
        }
    }
    
    // === Streaming ===
    
    async startStream() {
        try {
            const response = await fetch('/api/camera/stream/start', { method: 'POST' });
            if (response.ok) {
                this.isStreaming = true;
                this.startFramePolling();
                this.showNotification('🎥 Stream iniciado', 'success');
            }
        } catch (error) {
            console.error('Error iniciando stream:', error);
        }
        this.refreshStatus();
    }
    
    async stopStream() {
        try {
            await fetch('/api/camera/stream/stop', { method: 'POST' });
            this.isStreaming = false;
            this.stopFramePolling();
            this.showNotification('🎥 Stream detenido', 'info');
        } catch (error) {
            console.error('Error deteniendo stream:', error);
        }
        this.refreshStatus();
    }
    
    startFramePolling() {
        this.stopFramePolling();
        
        const pollFrame = async () => {
            if (!this.isStreaming) return;
            
            try {
                const response = await fetch('/api/camera/frame');
                if (response.ok) {
                    const data = await response.json();
                    if (data.frame) {
                        this.elements.cameraFeed.src = `data:image/jpeg;base64,${data.frame}`;
                        this.elements.cameraOverlay.style.display = 'none';
                        this.elements.cameraFeed.style.display = 'block';
                    }
                }
            } catch (error) {
                // Silently fail - might be between frames
            }
            
            if (this.isStreaming) {
                this.streamInterval = setTimeout(pollFrame, 66); // ~15 FPS
            }
        };
        
        pollFrame();
    }
    
    stopFramePolling() {
        if (this.streamInterval) {
            clearTimeout(this.streamInterval);
            this.streamInterval = null;
        }
    }
    
    hideFrame() {
        this.elements.cameraFeed.style.display = 'none';
        this.elements.cameraOverlay.style.display = 'flex';
    }
    
    async captureFrame() {
        try {
            const response = await fetch('/api/camera/frame');
            if (response.ok) {
                const data = await response.json();
                if (data.frame) {
                    this.elements.cameraFeed.src = `data:image/jpeg;base64,${data.frame}`;
                    this.elements.cameraOverlay.style.display = 'none';
                    this.elements.cameraFeed.style.display = 'block';
                    this.showNotification('📸 Frame capturado', 'success');
                }
            }
        } catch (error) {
            console.error('Error capturando frame:', error);
        }
    }
    
    // === Estado ===
    
    async refreshStatus() {
        try {
            const response = await fetch('/api/camera/status');
            const status = await response.json();
            this.updateStatus(status);
        } catch (error) {
            console.error('Error obteniendo estado:', error);
        }
    }
    
    updateStatus(status) {
        this.status = status;
        
        // Actualizar indicadores de estado
        this.elements.cameraState.textContent = this.getStateText(status.state);
        this.elements.cameraState.className = `status-value camera-state ${status.state}`;
        
        this.elements.cameraResolution.textContent = 
            status.resolution ? `${status.resolution.width}x${status.resolution.height}` : '-';
        
        this.elements.cameraFps.textContent = 
            status.stats?.avg_detection_time_ms > 0 
                ? `${(1000 / status.stats.avg_detection_time_ms).toFixed(1)}` 
                : '-';
        
        this.elements.cameraCalibrated.textContent = 
            status.calibration?.is_calibrated ? '✅' : '❌';
        
        // Actualizar conteo de miniaturas
        this.elements.miniaturesCount.textContent = 
            `${status.tracking?.visible_miniatures || 0} visibles / ${status.tracking?.total_miniatures || 0} total`;
        
        // Actualizar botones según estado
        const isConnected = ['connected', 'streaming', 'calibrating'].includes(status.state);
        const isStreaming = status.state === 'streaming';
        
        this.elements.btnConnect.disabled = isConnected;
        this.elements.btnDisconnect.disabled = !isConnected;
        this.elements.btnStartStream.disabled = !isConnected || isStreaming;
        this.elements.btnStopStream.disabled = !isStreaming;
        this.elements.btnCaptureFrame.disabled = !isConnected;
        
        // Si está en streaming y no estamos haciendo polling, iniciar
        if (isStreaming && !this.streamInterval) {
            this.isStreaming = true;
            this.startFramePolling();
        } else if (!isStreaming) {
            this.isStreaming = false;
            this.stopFramePolling();
        }
        
        // Refrescar miniaturas
        this.refreshMiniatures();
    }
    
    getStateText(state) {
        const states = {
            'disconnected': '🔴 Desconectado',
            'connecting': '🟡 Conectando...',
            'connected': '🟢 Conectado',
            'streaming': '📹 Transmitiendo',
            'calibrating': '📐 Calibrando',
            'error': '🔴 Error'
        };
        return states[state] || state;
    }
    
    // === Calibración ===
    
    async simpleCalibration() {
        const width = parseInt(this.elements.gameAreaWidth.value) || 1920;
        const height = parseInt(this.elements.gameAreaHeight.value) || 1080;
        
        try {
            const response = await fetch('/api/camera/calibration/simple', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ game_width: width, game_height: height })
            });
            
            if (response.ok) {
                this.showNotification('📐 Calibración aplicada', 'success');
                this.refreshStatus();
            } else {
                const error = await response.json();
                this.showNotification(`Error: ${error.detail}`, 'error');
            }
        } catch (error) {
            console.error('Error en calibración:', error);
        }
    }
    
    startAdvancedCalibration() {
        // TODO: Implementar calibración avanzada con puntos
        this.showNotification('Calibración avanzada próximamente', 'info');
    }
    
    // === Miniaturas ===
    
    async refreshMiniatures() {
        try {
            const response = await fetch('/api/camera/miniatures');
            const data = await response.json();
            this.renderMiniatures(data.miniatures);
        } catch (error) {
            console.error('Error cargando miniaturas:', error);
        }
    }
    
    renderMiniatures(miniatures) {
        // Grid principal de miniaturas
        if (miniatures.length === 0) {
            this.elements.miniaturesGrid.innerHTML = '<p class="empty-state">No hay miniaturas detectadas</p>';
            this.elements.unassignedMiniatures.innerHTML = '<p class="empty-state">Sin miniaturas detectadas</p>';
        } else {
            this.elements.miniaturesGrid.innerHTML = miniatures.map(m => this.renderMiniatureCard(m)).join('');
            
            // Miniaturas sin asignar
            const unassigned = miniatures.filter(m => !m.player_id);
            if (unassigned.length === 0) {
                this.elements.unassignedMiniatures.innerHTML = '<p class="empty-state">Todas las miniaturas asignadas</p>';
            } else {
                this.elements.unassignedMiniatures.innerHTML = unassigned.map(m => 
                    this.renderMiniatureSelectCard(m)
                ).join('');
            }
        }
        
        // Lista de asignaciones actuales
        const assigned = miniatures.filter(m => m.player_id);
        if (assigned.length === 0) {
            this.elements.currentAssignments.innerHTML = '<p class="empty-state">Sin asignaciones</p>';
        } else {
            this.elements.currentAssignments.innerHTML = assigned.map(m => this.renderAssignmentCard(m)).join('');
        }
    }
    
    renderMiniatureCard(miniature) {
        const visibilityClass = miniature.is_visible ? 'visible' : 'hidden';
        const playerInfo = miniature.player_name 
            ? `<span class="miniature-player">${miniature.player_name}</span>` 
            : '<span class="miniature-unassigned">Sin asignar</span>';
        
        return `
            <div class="miniature-card ${visibilityClass}">
                <div class="miniature-icon">🎭</div>
                <div class="miniature-info">
                    <span class="miniature-id">ID: ${miniature.marker_id}</span>
                    ${playerInfo}
                    <span class="miniature-position">📍 (${miniature.x.toFixed(0)}, ${miniature.y.toFixed(0)})</span>
                    <span class="miniature-visibility">${miniature.is_visible ? '👁️ Visible' : '👁️‍🗨️ No visible'}</span>
                </div>
            </div>
        `;
    }
    
    renderMiniatureSelectCard(miniature) {
        const selected = this.selectedMiniature === miniature.marker_id ? 'selected' : '';
        return `
            <div class="miniature-select-card ${selected}" onclick="cameraPanel.selectMiniature(${miniature.marker_id})">
                <span class="miniature-id">🎭 ID: ${miniature.marker_id}</span>
                <span class="miniature-position">📍 (${miniature.x.toFixed(0)}, ${miniature.y.toFixed(0)})</span>
            </div>
        `;
    }
    
    renderAssignmentCard(miniature) {
        return `
            <div class="assignment-card">
                <div class="assignment-info">
                    <span class="assignment-marker">🎭 ID: ${miniature.marker_id}</span>
                    <span class="assignment-player">👤 ${miniature.player_name}</span>
                    ${miniature.character_name ? `<span class="assignment-character">⚔️ ${miniature.character_name}</span>` : ''}
                </div>
                <button class="btn btn-danger btn-sm" onclick="cameraPanel.unassignMiniature(${miniature.marker_id})">
                    ✖️
                </button>
            </div>
        `;
    }
    
    selectMiniature(markerId) {
        this.selectedMiniature = markerId;
        this.elements.btnAssignMiniature.disabled = false;
        
        // Actualizar selección visual
        document.querySelectorAll('.miniature-select-card').forEach(card => {
            card.classList.remove('selected');
        });
        document.querySelector(`.miniature-select-card[onclick*="${markerId}"]`)?.classList.add('selected');
    }
    
    async assignMiniature() {
        if (!this.selectedMiniature) {
            this.showNotification('Selecciona una miniatura primero', 'warning');
            return;
        }
        
        const playerId = this.elements.assignPlayerId.value.trim();
        const playerName = this.elements.assignPlayerName.value.trim();
        const characterName = this.elements.assignCharacterName.value.trim() || null;
        
        if (!playerId || !playerName) {
            this.showNotification('ID y nombre del jugador son requeridos', 'warning');
            return;
        }
        
        try {
            const response = await fetch('/api/camera/miniatures/assign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    marker_id: this.selectedMiniature,
                    player_id: playerId,
                    player_name: playerName,
                    character_name: characterName
                })
            });
            
            if (response.ok) {
                this.showNotification(`✅ Miniatura asignada a ${playerName}`, 'success');
                this.selectedMiniature = null;
                this.elements.btnAssignMiniature.disabled = true;
                this.elements.assignPlayerId.value = '';
                this.elements.assignPlayerName.value = '';
                this.elements.assignCharacterName.value = '';
                this.refreshMiniatures();
            } else {
                const error = await response.json();
                this.showNotification(`Error: ${error.detail}`, 'error');
            }
        } catch (error) {
            console.error('Error asignando miniatura:', error);
        }
    }
    
    async unassignMiniature(markerId) {
        try {
            const response = await fetch(`/api/camera/miniatures/unassign/${markerId}`, {
                method: 'POST'
            });
            
            if (response.ok) {
                this.showNotification('Miniatura desasignada', 'info');
                this.refreshMiniatures();
            }
        } catch (error) {
            console.error('Error desasignando miniatura:', error);
        }
    }
    
    // === Utilidades ===
    
    showNotification(message, type = 'info') {
        // Usar el sistema de notificaciones existente si está disponible
        if (typeof addLog === 'function') {
            addLog(message);
        }
        console.log(`[Camera] ${message}`);
    }
}

// Instancia global
let cameraPanel;

document.addEventListener('DOMContentLoaded', () => {
    // Inicializar cuando se cargue la página
    setTimeout(() => {
        cameraPanel = new CameraPanel();
    }, 100);
});
