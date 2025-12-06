/**
 * MesaRPG - Camera Panel (Simplificado)
 * 
 * Flujo:
 * 1. Usuario selecciona cámara del navegador
 * 2. Se envía el video al servidor via WebSocket
 * 3. Servidor procesa con YOLO y devuelve frames con detecciones
 * 4. Se muestra el feed procesado con bounding boxes
 */

class CameraPanel {
    constructor() {
        this.localStream = null;
        this.cameraWs = null;
        this.isConnected = false;
        this.isStreaming = false;
        this.frameInterval = null;
        this.fps = 10; // Frames por segundo a enviar
        this.quality = 0.7; // Calidad JPEG
        
        // Elementos DOM
        this.elements = {};
        
        this.init();
    }
    
    async init() {
        // Esperar a que el DOM esté listo
        await this.waitForElements();
        
        console.log('📷 Inicializando panel de cámara...');
        
        // Cargar cámaras disponibles
        await this.loadCameras();
        
        // Configurar eventos
        this.setupEvents();
    }
    
    async waitForElements() {
        // Esperar a que existan los elementos
        return new Promise(resolve => {
            const check = () => {
                this.elements = {
                    cameraSelect: document.getElementById('camera-select'),
                    cameraIpInput: document.getElementById('camera-ip-input'),
                    cameraFeed: document.getElementById('camera-feed'),
                    cameraOverlay: document.getElementById('camera-overlay'),
                    localVideo: document.getElementById('local-video'),
                    cameraState: document.getElementById('camera-state'),
                    cameraFps: document.getElementById('camera-fps'),
                    detectionsCount: document.getElementById('detections-count'),
                    btnConnect: document.getElementById('btn-connect-camera'),
                    btnConnectIp: document.getElementById('btn-connect-ip'),
                    btnDisconnect: document.getElementById('btn-disconnect-camera'),
                    qualitySlider: document.getElementById('stream-quality'),
                    fpsSlider: document.getElementById('stream-fps')
                };
                
                if (this.elements.cameraSelect) {
                    resolve();
                } else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    }
    
    setupEvents() {
        // Botón conectar cámara local
        if (this.elements.btnConnect) {
            this.elements.btnConnect.onclick = () => this.connect();
        }
        
        // Botón conectar por IP
        if (this.elements.btnConnectIp) {
            this.elements.btnConnectIp.onclick = () => this.connectByIp();
        }
        
        // Botón desconectar
        if (this.elements.btnDisconnect) {
            this.elements.btnDisconnect.onclick = () => this.disconnect();
        }
        
        // Slider de calidad
        if (this.elements.qualitySlider) {
            this.elements.qualitySlider.oninput = (e) => {
                this.quality = e.target.value / 100;
                e.target.nextElementSibling.textContent = e.target.value + '%';
            };
        }
        
        // Slider de FPS
        if (this.elements.fpsSlider) {
            this.elements.fpsSlider.oninput = (e) => {
                this.fps = parseInt(e.target.value);
                e.target.nextElementSibling.textContent = e.target.value;
                if (this.isStreaming) {
                    this.restartFrameCapture();
                }
            };
        }
    }
    
    async loadCameras() {
        try {
            // Pedir permiso primero para obtener la lista de dispositivos
            await navigator.mediaDevices.getUserMedia({ video: true })
                .then(stream => stream.getTracks().forEach(t => t.stop()));
            
            const devices = await navigator.mediaDevices.enumerateDevices();
            const cameras = devices.filter(d => d.kind === 'videoinput');
            
            if (!this.elements.cameraSelect) return;
            
            this.elements.cameraSelect.innerHTML = '';
            
            if (cameras.length === 0) {
                this.elements.cameraSelect.innerHTML = '<option value="">No se encontraron cámaras</option>';
                return;
            }
            
            cameras.forEach((camera, index) => {
                const option = document.createElement('option');
                option.value = camera.deviceId;
                option.textContent = camera.label || `Cámara ${index + 1}`;
                this.elements.cameraSelect.appendChild(option);
            });
            
            console.log(`📷 ${cameras.length} cámara(s) encontrada(s)`);
            
        } catch (error) {
            console.error('Error accediendo a cámaras:', error);
            if (this.elements.cameraSelect) {
                this.elements.cameraSelect.innerHTML = '<option value="">Error: Permite acceso a la cámara</option>';
            }
        }
    }
    
    async connect() {
        const deviceId = this.elements.cameraSelect?.value;
        
        if (!deviceId) {
            this.showNotification('Selecciona una cámara primero', 'warning');
            return;
        }
        
        // Limpiar conexión anterior si existe
        this.handleDisconnect();
        
        this.updateState('connecting');
        
        try {
            // 1. Obtener stream de la cámara local
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    deviceId: { exact: deviceId },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                }
            });
            
            // Mostrar preview local (oculto, solo para captura)
            if (this.elements.localVideo) {
                this.elements.localVideo.srcObject = this.localStream;
                await this.elements.localVideo.play().catch(() => {});
            }
            
            // 2. Conectar WebSocket al servidor
            await this.connectWebSocket();
            
            // 3. Iniciar envío de frames
            this.startFrameCapture();
            
            this.isConnected = true;
            this.updateState('streaming');
            this.showNotification('📷 Cámara conectada y transmitiendo', 'success');
            
        } catch (error) {
            console.error('Error conectando cámara:', error);
            this.handleDisconnect();
            this.showNotification(`Error: ${error.message}`, 'error');
            this.updateState('error');
        }
    }
    
    async connectByIp() {
        let ipUrl = this.elements.cameraIpInput?.value.trim();
        
        if (!ipUrl) {
            this.showNotification('Introduce la IP de la cámara', 'warning');
            return;
        }
        
        // Normalizar URL
        if (!ipUrl.startsWith('http')) {
            ipUrl = 'http://' + ipUrl;
        }
        // DroidCam usa /video, añadir si no tiene path
        if (!ipUrl.includes('/video') && !ipUrl.includes('/mjpeg') && !ipUrl.includes('/stream')) {
            ipUrl = ipUrl + '/video';
        }
        
        // Limpiar conexión anterior
        this.handleDisconnect();
        this.updateState('connecting');
        
        try {
            // Conectar WebSocket primero
            await this.connectWebSocket();
            
            // Crear elemento img para recibir el stream MJPEG
            // y enviar frames al servidor
            this.showNotification('📱 Conectando a cámara IP...', 'info');
            
            // Usar un elemento de video oculto para capturar el stream
            const video = this.elements.localVideo;
            if (video) {
                // Para cámaras IP, usamos un img y canvas
                this.ipStreamImg = new Image();
                this.ipStreamImg.crossOrigin = 'anonymous';
                
                this.ipStreamImg.onload = () => {
                    if (!this.isConnected) {
                        this.isConnected = true;
                        this.updateState('streaming');
                        this.showNotification('📱 Cámara IP conectada', 'success');
                        this.startIpFrameCapture();
                    }
                };
                
                this.ipStreamImg.onerror = () => {
                    this.showNotification('Error: No se puede conectar a la cámara IP', 'error');
                    this.updateState('error');
                };
                
                // Iniciar stream
                this.ipStreamImg.src = ipUrl;
            }
            
        } catch (error) {
            console.error('Error conectando cámara IP:', error);
            this.handleDisconnect();
            this.showNotification(`Error: ${error.message}`, 'error');
            this.updateState('error');
        }
    }
    
    startIpFrameCapture() {
        this.isStreaming = true;
        
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        const captureFrame = () => {
            if (!this.isStreaming || !this.cameraWs || this.cameraWs.readyState !== WebSocket.OPEN) {
                return;
            }
            
            if (!this.ipStreamImg || !this.ipStreamImg.complete) {
                if (this.isStreaming) {
                    setTimeout(captureFrame, 1000 / this.fps);
                }
                return;
            }
            
            try {
                canvas.width = this.ipStreamImg.naturalWidth || 640;
                canvas.height = this.ipStreamImg.naturalHeight || 480;
                ctx.drawImage(this.ipStreamImg, 0, 0);
                
                const frameData = canvas.toDataURL('image/jpeg', this.quality);
                const base64 = frameData.split(',')[1];
                
                this.cameraWs.send(JSON.stringify({
                    type: 'frame',
                    payload: {
                        frame: base64,
                        width: canvas.width,
                        height: canvas.height,
                        timestamp: Date.now()
                    }
                }));
                
                // Refrescar imagen para siguiente frame (MJPEG)
                const currentSrc = this.ipStreamImg.src.split('?')[0];
                this.ipStreamImg.src = currentSrc + '?t=' + Date.now();
                
            } catch (error) {
                console.error('Error capturando frame IP:', error);
            }
            
            if (this.isStreaming) {
                this.frameInterval = setTimeout(captureFrame, 1000 / this.fps);
            }
        };
        
        captureFrame();
    }
    
    async connectWebSocket() {
        return new Promise((resolve, reject) => {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws/camera`;
            
            this.cameraWs = new WebSocket(wsUrl);
            
            this.cameraWs.onopen = () => {
                console.log('✅ WebSocket conectado');
                resolve();
            };
            
            this.cameraWs.onmessage = (event) => {
                this.handleServerMessage(JSON.parse(event.data));
            };
            
            this.cameraWs.onerror = (error) => {
                console.error('WebSocket error:', error);
                reject(new Error('Error conectando al servidor'));
            };
            
            this.cameraWs.onclose = () => {
                console.log('WebSocket cerrado');
                if (this.isConnected) {
                    this.handleDisconnect();
                }
            };
            
            // Timeout
            setTimeout(() => {
                if (this.cameraWs && this.cameraWs.readyState !== WebSocket.OPEN) {
                    reject(new Error('Timeout conectando'));
                }
            }, 5000);
        });
    }
    
    handleServerMessage(message) {
        const { type, payload } = message;
        
        switch (type) {
            case 'processed_frame':
                // Frame procesado por YOLO con bounding boxes
                if (payload.frame && this.elements.cameraFeed) {
                    this.elements.cameraFeed.src = `data:image/jpeg;base64,${payload.frame}`;
                    this.elements.cameraFeed.style.display = 'block';
                    if (this.elements.cameraOverlay) {
                        this.elements.cameraOverlay.style.display = 'none';
                    }
                }
                
                // Actualizar conteo de detecciones
                if (this.elements.detectionsCount && payload.detections !== undefined) {
                    this.elements.detectionsCount.textContent = payload.detections;
                }
                break;
            
            case 'detection_update':
                // Actualización de detecciones (posiciones de miniaturas, etc.)
                if (payload.objects) {
                    this.handleDetections(payload.objects);
                }
                break;
            
            case 'camera_status':
                // Estado de la cámara
                break;
            
            case 'pong':
                // Keep-alive
                break;
                
            case 'error':
                this.showNotification(`Error del servidor: ${payload.message}`, 'error');
                break;
        }
    }
    
    handleDetections(objects) {
        // Aquí se pueden procesar las detecciones para tracking
        console.log(`Detectados: ${objects.length} objetos`);
    }
    
    startFrameCapture() {
        this.isStreaming = true;
        
        // Crear canvas para capturar frames
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const video = this.elements.localVideo;
        
        if (!video) return;
        
        // Esperar a que el video esté listo
        video.onloadedmetadata = () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
        };
        
        const captureFrame = () => {
            if (!this.isStreaming || !this.cameraWs || this.cameraWs.readyState !== WebSocket.OPEN) {
                return;
            }
            
            try {
                // Dibujar frame en canvas
                ctx.drawImage(video, 0, 0);
                
                // Convertir a JPEG base64
                const frameData = canvas.toDataURL('image/jpeg', this.quality);
                const base64 = frameData.split(',')[1];
                
                // Enviar al servidor
                this.cameraWs.send(JSON.stringify({
                    type: 'frame',
                    payload: {
                        frame: base64,
                        width: canvas.width,
                        height: canvas.height,
                        timestamp: Date.now()
                    }
                }));
                
            } catch (error) {
                console.error('Error capturando frame:', error);
            }
        };
        
        // Capturar frames según FPS configurado
        this.frameInterval = setInterval(captureFrame, 1000 / this.fps);
    }
    
    restartFrameCapture() {
        if (this.frameInterval) {
            clearInterval(this.frameInterval);
        }
        if (this.isStreaming) {
            this.startFrameCapture();
        }
    }
    
    stopFrameCapture() {
        this.isStreaming = false;
        if (this.frameInterval) {
            clearInterval(this.frameInterval);
            this.frameInterval = null;
        }
    }
    
    disconnect() {
        this.handleDisconnect();
        this.showNotification('📷 Cámara desconectada', 'info');
    }
    
    handleDisconnect() {
        this.isConnected = false;
        
        // Detener captura
        this.stopFrameCapture();
        
        // Cerrar WebSocket
        if (this.cameraWs) {
            this.cameraWs.close();
            this.cameraWs = null;
        }
        
        // Detener stream local
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
        
        // Limpiar video
        if (this.elements.localVideo) {
            this.elements.localVideo.srcObject = null;
        }
        
        // Mostrar overlay
        if (this.elements.cameraFeed) {
            this.elements.cameraFeed.style.display = 'none';
        }
        if (this.elements.cameraOverlay) {
            this.elements.cameraOverlay.style.display = 'flex';
            this.elements.cameraOverlay.innerHTML = `
                <div class="camera-placeholder">
                    <p>📷 Selecciona una cámara y haz clic en Conectar</p>
                </div>
            `;
        }
        
        this.updateState('disconnected');
    }
    
    updateState(state) {
        // Actualizar texto de estado
        if (this.elements.cameraState) {
            const states = {
                'disconnected': '🔴 Desconectado',
                'connecting': '🟡 Conectando...',
                'streaming': '🟢 Transmitiendo',
                'error': '🔴 Error'
            };
            this.elements.cameraState.textContent = states[state] || state;
            this.elements.cameraState.className = `status-value camera-state ${state}`;
        }
        
        // Actualizar botones
        if (this.elements.btnConnect) {
            this.elements.btnConnect.disabled = state === 'streaming' || state === 'connecting';
        }
        if (this.elements.btnDisconnect) {
            this.elements.btnDisconnect.disabled = state !== 'streaming';
        }
        if (this.elements.cameraSelect) {
            this.elements.cameraSelect.disabled = state === 'streaming' || state === 'connecting';
        }
    }
    
    showNotification(message, type = 'info') {
        if (typeof addLog === 'function') {
            addLog(message);
        }
        console.log(`[Camera] ${message}`);
    }
}

// Instancia global
let cameraPanel;

document.addEventListener('DOMContentLoaded', () => {
    cameraPanel = new CameraPanel();
});
