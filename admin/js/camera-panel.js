/**
 * MesaRPG - Camera Panel Controller
 * Gestiona la interfaz del panel de cámara en el admin
 * Recibe streaming de video del detector local vía WebSocket
 */

class CameraPanel {
    constructor() {
        this.status = null;
        this.selectedMiniature = null;
        this.isStreaming = false;
        this.cameraWs = null;
        this.reconnectInterval = null;
        this.lastFrameTime = 0;
        this.frameCount = 0;
        this.detectedMarkers = [];
        this.detectorConnected = false;
        
        // Referencias a elementos DOM
        this.elements = {
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
            btnStartStream: document.getElementById('btn-start-stream'),
            btnStopStream: document.getElementById('btn-stop-stream'),
            btnAssignMiniature: document.getElementById('btn-assign-miniature')
        };
        
        this.init();
    }
    
    async init() {
        console.log('📷 Inicializando panel de cámara...');
        
        // Mostrar instrucciones iniciales
        this.showDetectorDisconnected();
        
        // Conectar al WebSocket de cámara para recibir stream
        this.connectCameraWebSocket();
        
        // Configurar actualización periódica de FPS
        setInterval(() => this.updateFpsDisplay(), 1000);
    }
    
    // === WebSocket para recibir frames del detector ===
    
    connectCameraWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/camera`;
        
        console.log(`📡 Conectando a WebSocket de cámara: ${wsUrl}`);
        
        try {
            this.cameraWs = new WebSocket(wsUrl);
            
            this.cameraWs.onopen = () => {
                console.log('✅ WebSocket de cámara conectado');
                this.stopReconnect();
            };
            
            this.cameraWs.onmessage = (event) => {
                this.handleCameraMessage(JSON.parse(event.data));
            };
            
            this.cameraWs.onclose = () => {
                console.log('🔴 WebSocket de cámara desconectado');
                this.startReconnect();
            };
            
            this.cameraWs.onerror = (error) => {
                console.error('❌ Error en WebSocket de cámara:', error);
            };
        } catch (error) {
            console.error('❌ Error conectando WebSocket:', error);
            this.startReconnect();
        }
    }
    
    startReconnect() {
        if (!this.reconnectInterval) {
            this.reconnectInterval = setInterval(() => {
                console.log('🔄 Reconectando WebSocket de cámara...');
                this.connectCameraWebSocket();
            }, 5000);
        }
    }
    
    stopReconnect() {
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }
    }
    
    handleCameraMessage(message) {
        const type = message.type;
        const payload = message.payload || {};
        
        switch (type) {
            case 'camera_frame':
                this.handleFrame(payload);
                break;
            
            case 'camera_status':
                this.updateStatusDisplay(payload);
                break;
            
            case 'detector_disconnected':
                this.detectorConnected = false;
                this.isStreaming = false;
                this.showDetectorDisconnected();
                this.showNotification('📷 Detector desconectado', 'warning');
                break;
            
            case 'pong':
                // Keep-alive response
                break;
            
            default:
                console.log('Mensaje de cámara no manejado:', type, payload);
        }
    }
    
    handleFrame(payload) {
        const frame = payload.frame;
        const markers = payload.markers || [];
        
        if (frame) {
            // Mostrar el frame
            this.elements.cameraFeed.src = `data:image/jpeg;base64,${frame}`;
            this.elements.cameraOverlay.style.display = 'none';
            this.elements.cameraFeed.style.display = 'block';
            
            // Actualizar FPS
            this.frameCount++;
            this.lastFrameTime = Date.now();
            
            // El detector está conectado
            if (!this.detectorConnected) {
                this.detectorConnected = true;
                this.isStreaming = true;
                this.updateStatusDisplay({ state: 'streaming' });
                this.showNotification('📷 Detector conectado - Recibiendo stream', 'success');
            }
        }
        
        // Actualizar marcadores detectados
        this.detectedMarkers = markers;
        this.updateMarkersDisplay(markers);
    }
    
    updateMarkersDisplay(markers) {
        // Actualizar conteo
        if (this.elements.miniaturesCount) {
            this.elements.miniaturesCount.textContent = `${markers.length} detectadas`;
        }
        
        // Actualizar grid de miniaturas con los marcadores del frame
        if (markers.length > 0) {
            this.renderDetectedMarkers(markers);
        }
    }
    
    renderDetectedMarkers(markers) {
        if (!this.elements.miniaturesGrid) return;
        
        if (markers.length === 0) {
            this.elements.miniaturesGrid.innerHTML = '<p class="empty-state">No hay miniaturas detectadas</p>';
            return;
        }
        
        this.elements.miniaturesGrid.innerHTML = markers.map(m => `
            <div class="miniature-card visible">
                <div class="miniature-icon">🎭</div>
                <div class="miniature-info">
                    <span class="miniature-id">ID: ${m.id}</span>
                    <span class="miniature-position">📍 (${m.x?.toFixed(0) || 0}, ${m.y?.toFixed(0) || 0})</span>
                    <span class="miniature-visibility">👁️ Visible</span>
                </div>
            </div>
        `).join('');
        
        // Actualizar miniaturas sin asignar para selección
        if (this.elements.unassignedMiniatures) {
            this.elements.unassignedMiniatures.innerHTML = markers.map(m => `
                <div class="miniature-select-card ${this.selectedMiniature === m.id ? 'selected' : ''}" 
                     onclick="cameraPanel.selectMiniature(${m.id})">
                    <span class="miniature-id">🎭 ID: ${m.id}</span>
                    <span class="miniature-position">📍 (${m.x?.toFixed(0) || 0}, ${m.y?.toFixed(0) || 0})</span>
                </div>
            `).join('');
        }
    }
    
    showDetectorDisconnected() {
        if (!this.elements.cameraOverlay) return;
        
        this.elements.cameraOverlay.innerHTML = `
            <div class="camera-remote-info">
                <h3>📷 Esperando conexión del detector...</h3>
                <p style="margin-top: 15px;">
                    El sistema de cámara funciona ejecutando un detector en tu PC local
                    que envía el video al servidor.
                </p>
                <div style="margin-top: 20px; text-align: left;">
                    <p><strong>Pasos:</strong></p>
                    <ol style="margin-left: 20px; margin-top: 10px;">
                        <li>Asegúrate de tener OpenCV instalado:<br>
                            <code>pip install opencv-python opencv-contrib-python</code>
                        </li>
                        <li style="margin-top: 10px;">Ejecuta el detector con la cámara conectada:<br>
                            <code>python vision/detector.py --server wss://${window.location.host}/ws/camera</code>
                        </li>
                    </ol>
                </div>
                <p style="margin-top: 20px; font-size: 0.9em; color: #888;">
                    💡 El detector capturará video, detectará marcadores ArUco 
                    y enviará todo al servidor para visualizarlo aquí.
                </p>
            </div>
        `;
        this.elements.cameraOverlay.style.display = 'flex';
        if (this.elements.cameraFeed) {
            this.elements.cameraFeed.style.display = 'none';
        }
        
        this.updateStatusDisplay({ state: 'disconnected' });
    }
    
    updateFpsDisplay() {
        if (this.elements.cameraFps) {
            if (this.detectorConnected) {
                this.elements.cameraFps.textContent = `${this.frameCount}`;
            } else {
                this.elements.cameraFps.textContent = '-';
            }
            this.frameCount = 0;
        }
    }
    
    // === Control del detector remoto ===
    
    setDetectorQuality(quality) {
        if (this.cameraWs && this.cameraWs.readyState === WebSocket.OPEN) {
            this.cameraWs.send(JSON.stringify({
                type: 'set_detector_quality',
                payload: { quality: parseInt(quality) }
            }));
            this.showNotification(`Calidad ajustada a ${quality}%`, 'info');
        }
    }
    
    setDetectorFps(fps) {
        if (this.cameraWs && this.cameraWs.readyState === WebSocket.OPEN) {
            this.cameraWs.send(JSON.stringify({
                type: 'set_detector_fps',
                payload: { fps: parseInt(fps) }
            }));
            this.showNotification(`FPS ajustado a ${fps}`, 'info');
        }
    }
    
    toggleDetectorStream(enabled) {
        if (this.cameraWs && this.cameraWs.readyState === WebSocket.OPEN) {
            this.cameraWs.send(JSON.stringify({
                type: 'toggle_detector_stream',
                payload: { enabled: enabled }
            }));
            this.showNotification(enabled ? 'Stream activado' : 'Stream pausado', 'info');
        }
    }
    
    // === Estado ===
    
    updateStatusDisplay(status) {
        // Determinar el estado real basado en detector remoto
        let displayState = status?.state || 'disconnected';
        
        if (this.detectorConnected) {
            displayState = 'streaming';
        }
        
        // Actualizar indicadores de estado
        if (this.elements.cameraState) {
            this.elements.cameraState.textContent = this.getStateText(displayState);
            this.elements.cameraState.className = `status-value camera-state ${displayState}`;
        }
        
        if (this.elements.cameraResolution) {
            this.elements.cameraResolution.textContent = this.detectorConnected ? '640x480' : '-';
        }
        
        if (this.elements.cameraCalibrated) {
            this.elements.cameraCalibrated.textContent = 
                status?.calibration?.is_calibrated ? '✅' : '❌';
        }
        
        // Actualizar botones
        if (this.elements.btnStartStream) {
            this.elements.btnStartStream.disabled = this.isStreaming;
            this.elements.btnStartStream.onclick = () => this.toggleDetectorStream(true);
        }
        if (this.elements.btnStopStream) {
            this.elements.btnStopStream.disabled = !this.isStreaming;
            this.elements.btnStopStream.onclick = () => this.toggleDetectorStream(false);
        }
    }
    
    getStateText(state) {
        const states = {
            'disconnected': '🔴 Esperando detector',
            'connecting': '🟡 Conectando...',
            'connected': '🟢 Conectado',
            'streaming': '📹 Recibiendo stream',
            'calibrating': '📐 Calibrando',
            'error': '🔴 Error'
        };
        return states[state] || state;
    }
    
    // === Calibración ===
    
    async simpleCalibration() {
        const width = parseInt(this.elements.gameAreaWidth?.value) || 1920;
        const height = parseInt(this.elements.gameAreaHeight?.value) || 1080;
        
        try {
            const response = await fetch('/api/camera/calibration/simple', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ game_width: width, game_height: height })
            });
            
            if (response.ok) {
                this.showNotification('📐 Calibración aplicada', 'success');
            } else {
                const error = await response.json();
                this.showNotification(`Error: ${error.detail}`, 'error');
            }
        } catch (error) {
            console.error('Error en calibración:', error);
        }
    }
    
    // === Miniaturas ===
    
    selectMiniature(markerId) {
        this.selectedMiniature = markerId;
        if (this.elements.btnAssignMiniature) {
            this.elements.btnAssignMiniature.disabled = false;
        }
        
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
        
        const playerId = this.elements.assignPlayerId?.value.trim();
        const playerName = this.elements.assignPlayerName?.value.trim();
        const characterName = this.elements.assignCharacterName?.value.trim() || null;
        
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
                if (this.elements.btnAssignMiniature) {
                    this.elements.btnAssignMiniature.disabled = true;
                }
                if (this.elements.assignPlayerId) this.elements.assignPlayerId.value = '';
                if (this.elements.assignPlayerName) this.elements.assignPlayerName.value = '';
                if (this.elements.assignCharacterName) this.elements.assignCharacterName.value = '';
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
