/**
 * MesaRPG - Gestor de WebSocket para Display
 * Maneja la conexión en tiempo real con el servidor
 */

class WebSocketManager {
    constructor(url) {
        // Detectar automáticamente el protocolo correcto (ws para http, wss para https)
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.url = url || `${wsProtocol}//${window.location.host}/ws/display`;
        this.socket = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 2000;
        this.listeners = new Map();
        this.isConnected = false;
        this.pingInterval = null;
        this.pingIntervalMs = 25000; // Enviar ping cada 25 segundos
    }
    
    connect() {
        console.log('🔌 Conectando a:', this.url);
        
        this.socket = new WebSocket(this.url);
        
        this.socket.onopen = () => {
            console.log('✅ WebSocket conectado');
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.updateConnectionStatus(true);
            this.emit('connected');
            this.startPing();
        };
        
        this.socket.onclose = (event) => {
            console.log('❌ WebSocket desconectado:', event.code);
            this.isConnected = false;
            this.updateConnectionStatus(false);
            this.emit('disconnected');
            this.stopPing();
            this.attemptReconnect();
        };
        
        this.socket.onerror = (error) => {
            console.error('⚠️ WebSocket error:', error);
            this.emit('error', error);
        };
        
        this.socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleMessage(data);
            } catch (e) {
                console.error('Error parseando mensaje:', e);
            }
        };
    }
    
    handleMessage(data) {
        const type = data.type;
        const payload = data.payload || {};
        
        // Ignorar mensajes pong (respuesta a nuestro ping)
        if (type === 'pong') {
            return;
        }
        
        console.log('📨 Mensaje recibido:', type, payload);
        
        // Emitir evento específico
        this.emit(type, payload);
        
        // Emitir evento genérico
        this.emit('message', data);
    }
    
    send(type, payload = {}) {
        if (!this.isConnected) {
            console.warn('No conectado, no se puede enviar:', type);
            return false;
        }
        
        const message = {
            type,
            payload,
            timestamp: new Date().toISOString()
        };
        
        this.socket.send(JSON.stringify(message));
        return true;
    }
    
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('Máximo de intentos de reconexión alcanzado');
            return;
        }
        
        this.reconnectAttempts++;
        console.log(`🔄 Reconectando... (intento ${this.reconnectAttempts})`);
        
        setTimeout(() => {
            this.connect();
        }, this.reconnectDelay);
    }
    
    updateConnectionStatus(connected) {
        const statusEl = document.getElementById('connection-status');
        if (statusEl) {
            statusEl.classList.toggle('connected', connected);
            statusEl.querySelector('.text').textContent = connected ? 'Conectado' : 'Desconectado';
        }
    }
    
    // Sistema de eventos
    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event).push(callback);
    }
    
    off(event, callback) {
        if (this.listeners.has(event)) {
            const callbacks = this.listeners.get(event);
            const index = callbacks.indexOf(callback);
            if (index > -1) {
                callbacks.splice(index, 1);
            }
        }
    }
    
    emit(event, data) {
        if (this.listeners.has(event)) {
            this.listeners.get(event).forEach(callback => {
                try {
                    callback(data);
                } catch (e) {
                    console.error('Error en listener:', e);
                }
            });
        }
    }
    
    disconnect() {
        this.stopPing();
        if (this.socket) {
            this.socket.close();
        }
    }
    
    startPing() {
        this.stopPing();
        this.pingInterval = setInterval(() => {
            if (this.isConnected && this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'ping' }));
            }
        }, this.pingIntervalMs);
    }
    
    stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }
}

// Instancia global
window.wsManager = new WebSocketManager();
